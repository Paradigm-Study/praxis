import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Episode } from "../core/types.ts";
import { logger } from "../core/log.ts";
import { defaultDataDir, type Store } from "../storage/index.ts";
import { redactMeshFrame } from "./redact.ts";
import type { MeshFrame, WorkFrame, WorkFrameStatus } from "./types.ts";
import { episodeToWorkFrame, normalizeRepoUrl } from "./workframe.ts";
import { EgressAuditor } from "../privacy/egress.ts";
import { PrivacyControlStore } from "../privacy/control.ts";
import { sha256 } from "../core/hash.ts";

const log = logger("mesh");

/**
 * Publishes mesh frames to the relay's POST /outbox/:person.
 *
 * The publisher is deliberately fail-open: relay availability must never
 * interrupt local Praxis work. Network failures go to a local NDJSON spool,
 * while HTTP failures do not, because retrying an invalid token forever would
 * turn a consent or configuration problem into an unbounded queue.
 */

export interface MeshPublisherOptions {
  /** Relay base url, e.g. "http://127.0.0.1:4600". */
  url: string;
  /** Bearer token for this person (relay static token table). */
  token: string;
  person: string;
  /** Hosted tenant identity. Sent as X-Mesh-Team-ID when present. */
  teamId?: string;
  /** Defaults to os.hostname(). */
  device?: string;
  /** Git remote url or directory name. Defaults to basename(cwd). */
  project?: string;
  /** For workframe construction (claims/evidence lookups). */
  store?: Store;
  /** Injectable for tests. Defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** Optional consent allowlist of git remotes or project directory names. */
  projects?: string[];
  /** Defaults to ~/.config/praxis/mesh.json. */
  configPath?: string;
  /** Defaults to the Praxis data directory's mesh outbox spool. */
  spoolPath?: string;
  /** Metadata-only egress audit. */
  auditor?: EgressAuditor;
}

export interface PublishResult {
  ok: boolean;
  /** Relay-assigned sequence number when ok. */
  seq?: number;
  /** Failure detail (never thrown — the publisher fails open). */
  error?: string;
}

interface ConsentConfig {
  person: string;
  device: string;
  relayUrl: string;
  token: string;
  projects: string[];
}

interface PostAttempt extends PublishResult {
  networkFailure: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readConsentConfig(path: string): ConsentConfig | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null) {
      throw new Error("expected a JSON object");
    }
    const config = value as Record<string, unknown>;
    if (
      typeof config.person !== "string"
      || typeof config.device !== "string"
      || typeof config.relayUrl !== "string"
      || typeof config.token !== "string"
      || !Array.isArray(config.projects)
      || !config.projects.every((project) => typeof project === "string")
    ) {
      throw new Error("invalid mesh consent config");
    }
    return config as unknown as ConsentConfig;
  } catch (error) {
    // Missing or malformed consent files disable no local behavior. An absent
    // allowlist means the explicitly enabled environment setup remains usable.
    log.debug("mesh consent config unavailable; ignoring it", errorMessage(error));
    return undefined;
  }
}

export class MeshPublisher {
  readonly url: string;
  readonly person: string;
  readonly teamId: string | undefined;
  readonly device: string;
  readonly project: string;
  protected token: string;
  protected store: Store | undefined;
  protected fetchFn: typeof fetch;
  protected projects: string[] | undefined;
  protected spoolPath: string;
  protected auditor: EgressAuditor;
  /**
   * Serializes publish()/flushSpool() runs. Concurrent publishes (the agent
   * loop fire-and-forgets several per tick) would otherwise both read the same
   * spool and double-deliver every pending frame (the relay has no dedup), and
   * race their spool rewrites.
   */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: MeshPublisherOptions) {
    const configPath = opts.configPath
      ?? join(homedir(), ".config", "praxis", "mesh.json");
    const config = readConsentConfig(configPath);

    this.url = opts.url.replace(/\/$/, "");
    this.token = opts.token;
    this.person = opts.person;
    this.teamId = opts.teamId;
    this.device = opts.device ?? config?.device ?? hostname();
    this.project = opts.project ?? basename(process.cwd());
    this.store = opts.store;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.projects = opts.projects !== undefined
      ? [...opts.projects]
      : config?.projects === undefined
        ? undefined
        : [...config.projects];
    this.spoolPath = opts.spoolPath
      ?? join(defaultDataDir(), "mesh-outbox-spool.ndjson");
    this.auditor = opts.auditor ?? EgressAuditor.forStore(opts.store);
  }

  /**
   * Build from PRAXIS_MESH_URL + PRAXIS_MESH_TOKEN + PRAXIS_PERSON.
   * Hosted credentials additionally use PRAXIS_MESH_TEAM_ID and the bound
   * PRAXIS_MESH_DEVICE_ID.
   * Returns undefined when any of the three is unset (feature off).
   */
  static fromEnv(store?: Store): MeshPublisher | undefined {
    const url = process.env.PRAXIS_MESH_URL;
    const token = process.env.PRAXIS_MESH_TOKEN;
    const person = process.env.PRAXIS_PERSON;
    if (!url || !token || !person) return undefined;
    const projects = store ? PrivacyControlStore.forStore(store).read().meshProjects : [];
    // Environment credentials alone no longer grant every project: the
    // versioned privacy control carries affirmative per-project consent.
    return new MeshPublisher({
      url,
      token,
      person,
      store,
      projects,
      ...(process.env.PRAXIS_MESH_TEAM_ID && {
        teamId: process.env.PRAXIS_MESH_TEAM_ID,
      }),
      ...(process.env.PRAXIS_MESH_DEVICE_ID && {
        device: process.env.PRAXIS_MESH_DEVICE_ID,
      }),
    });
  }

  /**
   * Episode-close hook: project the closed episode to a redacted WorkFrame
   * with status "done" (finished work must not read as an active edit in
   * teammates' briefs/gates for the next 8h) and publish it. Never throws; a
   * failed publish has already been spooled when the failure is retryable.
   */
  async onEpisodeClosed(episode: Episode): Promise<WorkFrame | undefined> {
    return this.publishEpisode(episode, "done");
  }

  /**
   * Open-episode hook: announce in-progress work as an "active" WorkFrame so
   * teammates' /brief and /gate see it. The matching onEpisodeClosed "done"
   * frame later supersedes it (the materializer keys by person+project).
   */
  async onEpisodeActive(episode: Episode): Promise<WorkFrame | undefined> {
    return this.publishEpisode(episode, "active");
  }

  private async publishEpisode(
    episode: Episode,
    status: WorkFrameStatus,
  ): Promise<WorkFrame | undefined> {
    try {
      if (!this.projectIsAllowed()) {
        log.debug("mesh project not present in consent allowlist", this.project);
        return undefined;
      }

      const frame = episodeToWorkFrame(episode, {
        person: this.person,
        device: this.device,
        project: this.project,
        store: this.store,
        status,
      });
      try {
        await this.publish(frame);
      } catch (error) {
        // publish itself is fail-open, but keep the episode hook safe even if
        // an injected implementation violates that contract.
        log.warn("mesh frame publish unexpectedly threw", errorMessage(error));
      }
      return frame;
    } catch (error) {
      log.warn("mesh episode-close publish failed open", errorMessage(error));
      return undefined;
    }
  }

  /**
   * POST one frame to `${url}/outbox/${person}`. Never throws — a down relay
   * yields { ok: false, error } and preserves the frame in the local spool.
   * Publishes are serialized per publisher (see #queue).
   */
  async publish(frame: MeshFrame): Promise<PublishResult> {
    const run = this.#queue.then(() => this.publishNow(frame));
    // Keep the chain alive whatever this publish does.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async publishNow(frame: MeshFrame): Promise<PublishResult> {
    try {
      // The credential is bound to this publisher's device. Canonicalize the
      // wire record to the same identity as X-Mesh-Device-ID so callers cannot
      // accidentally emit a frame that hosted authentication will contradict.
      const outbound = redactMeshFrame({ ...frame, device: this.device });
      try {
        await this.flushSpool();
      } catch (error) {
        // A damaged or temporarily unwritable spool must not prevent an
        // otherwise healthy relay from receiving the current frame.
        log.warn("mesh spool flush failed open", errorMessage(error));
      }

      const attempt = await this.postFrame(outbound);
      if (!attempt.ok && attempt.networkFailure) {
        try {
          // Persist the exact redacted wire projection, never the richer caller
          // object. Retry storage is itself a privacy boundary.
          this.appendToSpool(outbound);
        } catch (error) {
          log.warn("mesh frame could not be written to spool", errorMessage(error));
        }
      }
      return attempt.ok
        ? { ok: true, seq: attempt.seq }
        : { ok: false, error: attempt.error };
    } catch (error) {
      const message = errorMessage(error);
      log.warn("unexpected mesh publish failure", message);
      return { ok: false, error: message };
    }
  }

  /**
   * A defined allowlist is affirmative project consent. URL entries compare
   * after contract normalization; plain directory names remain case-sensitive
   * and match exactly. With no configured list, explicit env activation is
   * sufficient consent and publishing remains enabled.
   */
  private projectIsAllowed(): boolean {
    if (this.projects === undefined) return true;
    const normalizedProject = normalizeRepoUrl(this.project);
    return this.projects.some((allowed) =>
      allowed === this.project || normalizeRepoUrl(allowed) === normalizedProject
    );
  }

  private async flushSpool(): Promise<void> {
    if (!existsSync(this.spoolPath)) return;

    const frames: MeshFrame[] = [];
    const lines = readFileSync(this.spoolPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        frames.push(JSON.parse(line) as MeshFrame);
      } catch {
        log.debug("skipping corrupt line in mesh spool");
      }
    }

    for (let index = 0; index < frames.length; index += 1) {
      const attempt = await this.postFrame(frames[index]!);
      if (!attempt.ok && attempt.networkFailure) {
        this.replaceSpool(frames.slice(index));
        return;
      }
      if (!attempt.ok) {
        log.warn("dropping spooled mesh frame rejected by relay", attempt.error);
      }
    }

    this.replaceSpool([]);
  }

  private async postFrame(frame: MeshFrame): Promise<PostAttempt> {
    // The wire boundary IS a redaction boundary: whatever frame a caller hands
    // publish(), workframes re-pass the redactor (whitelist projection — extra
    // fields and secret-shaped strings never serialize).
    const outbound = redactMeshFrame(frame);
    const body = JSON.stringify(outbound);
    const audit = (outcome: "succeeded" | "failed", status?: number, error?: string) =>
      this.auditor.record({
        destination: this.url,
        purpose: "mesh_publish",
        categories: ["work_metadata", "artifact_paths", "evidence_hashes"],
        bytes: Buffer.byteLength(body),
        digest: sha256(body),
        redaction: "mesh-v0",
        outcome,
        ...(status !== undefined ? { status } : {}),
        ...(error ? { error } : {}),
      });
    let response: Response;
    try {
      response = await this.fetchFn(`${this.url}/outbox/${this.person}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
          ...(this.teamId && { "x-mesh-team-id": this.teamId }),
          "x-mesh-device-id": this.device,
        },
        body,
      });
    } catch (error) {
      audit("failed", undefined, errorMessage(error));
      return {
        ok: false,
        error: errorMessage(error),
        networkFailure: true,
      };
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      audit("failed", response.status, `response read: ${errorMessage(error)}`);
      return {
        ok: false,
        error: `relay response read failed: ${errorMessage(error)}`,
        networkFailure: false,
      };
    }

    if (!response.ok) {
      const detail = text.trim() || response.statusText || "request failed";
      audit("failed", response.status, detail);
      return {
        ok: false,
        error: `http ${response.status}: ${detail}`,
        networkFailure: false,
      };
    }

    try {
      const payload = JSON.parse(text) as unknown;
      if (
        typeof payload === "object"
        && payload !== null
        && (payload as Record<string, unknown>).ok === true
        && typeof (payload as Record<string, unknown>).seq === "number"
      ) {
        audit("succeeded", response.status);
        return {
          ok: true,
          seq: (payload as Record<string, number>).seq,
          networkFailure: false,
        };
      }
      audit("failed", response.status, "invalid relay response");
      return {
        ok: false,
        error: "invalid relay response",
        networkFailure: false,
      };
    } catch (error) {
      audit("failed", response.status, errorMessage(error));
      return {
        ok: false,
        error: `invalid relay response: ${errorMessage(error)}`,
        networkFailure: false,
      };
    }
  }

  /** Owner-only spool dir/file: queued intents are private on shared hosts. */
  private prepareSpoolDir(): void {
    const dir = dirname(this.spoolPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best-effort (mkdir mode only applies to newly created dirs)
    }
  }

  private appendToSpool(frame: MeshFrame): void {
    this.prepareSpoolDir();
    appendFileSync(this.spoolPath, `${JSON.stringify(frame)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private replaceSpool(frames: MeshFrame[]): void {
    if (frames.length === 0) {
      rmSync(this.spoolPath, { force: true });
      return;
    }
    this.prepareSpoolDir();
    writeFileSync(
      this.spoolPath,
      `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
}
