import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Episode } from "../core/types.ts";
import { logger } from "../core/log.ts";
import { defaultDataDir, type Store } from "../storage/index.ts";
import { redactMeshFrame } from "./redact.ts";
import type { MeshFrame, SyncVerification, WorkFrame, WorkFrameStatus } from "./types.ts";
import { episodeToWorkFrame, normalizeRepoUrl } from "./workframe.ts";
import { episodeToContextFrames, isContextFrameCurrentlyConsented } from "./contextFrame.ts";
import { EgressAuditor } from "../privacy/egress.ts";
import { PrivacyControlStore } from "../privacy/control.ts";
import { sha256 } from "../core/hash.ts";
import {
  isMeshProjectConsented,
  normalizeMeshProjectIdentity,
  resolveConsentedWorkspaceProject,
  safeMeshRelayBaseUrl,
  safeRepoRelativePath,
  safeMeshWireIdentity,
} from "./projectConsent.ts";

const log = logger("mesh");
const MAX_RELAY_ACK_BYTES = 64 * 1024;
const MAX_MESH_FRAME_BYTES = 256 * 1024;
const MAX_MESH_SPOOL_BYTES = 8 * 1024 * 1024;
const MAX_MESH_SPOOL_RECORDS = 256;

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
  /** Resolve an episode to an explicitly consented workspace/project pair. */
  projectContext?: (episode: Episode) => MeshEpisodeProject | undefined;
  /**
   * Re-check affirmative project consent immediately before every network
   * send, including durable-spool retries. Defaults to the configured project
   * allowlist (or explicit activation when no allowlist exists).
   */
  currentProjectConsent?: (project: string) => boolean;
  /** Re-check the source grant for v1 records immediately before send/retry. */
  currentContextConsent?: (frame: Extract<MeshFrame, { kind: "context_frame" }>) => boolean;
  /** Defaults to ~/.config/praxis/mesh.json. */
  configPath?: string;
  /** Defaults to the Praxis data directory's mesh outbox spool. */
  spoolPath?: string;
  /** Bounded relay request time; defaults to five seconds. */
  requestTimeoutMs?: number;
  /** Metadata-only egress audit. */
  auditor?: EgressAuditor;
}

export interface MeshPublisherEnvironmentOptions {
  /** Optional dedicated retry spool for another publisher process/surface. */
  spoolPath?: string;
}

export interface MeshEpisodeProject {
  project: string;
  repoRoot: string;
  sessionKey?: string;
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

interface MeshSpoolScope {
  /** Null is the standalone/non-hosted relay scope. */
  teamId: string | null;
  person: string;
  device: string;
}

interface MeshSpoolRecord {
  spoolVersion: 1;
  scope: MeshSpoolScope;
  frame: MeshFrame;
  /** Local-only selector used to re-check consent for a content-free receipt. */
  consentProject?: string;
}

type MeshSpoolLine = MeshSpoolRecord | MeshFrame;

interface PendingMeshFrame {
  frame: MeshFrame;
  consentProject?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectInList(project: string, allowedProjects: string[]): boolean {
  const normalizedProject = normalizeRepoUrl(project);
  return allowedProjects.some((allowed) =>
    allowed === project || normalizeRepoUrl(allowed) === normalizedProject
  );
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

function parseMeshFrame(value: unknown): MeshFrame | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.v !== 0 && candidate.v !== 1)
    || (
      candidate.kind !== "workframe"
      && candidate.kind !== "card_event"
      && candidate.kind !== "context_frame"
      && candidate.kind !== "sync_verification"
    )
    || typeof candidate.person !== "string"
    || typeof candidate.device !== "string"
    || (
      candidate.kind !== "context_frame"
      && candidate.kind !== "sync_verification"
      && typeof candidate.project !== "string"
    )
    || (candidate.kind === "sync_verification" && candidate.v !== 0)
  ) {
    return undefined;
  }
  try {
    return redactMeshFrame(value as MeshFrame);
  } catch {
    return undefined;
  }
}

function isMeshSpoolRecord(value: MeshSpoolLine): value is MeshSpoolRecord {
  return "spoolVersion" in value;
}

function parseSpoolLine(value: unknown): MeshSpoolLine | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.spoolVersion !== 1) return parseMeshFrame(value);

  if (
    typeof candidate.scope !== "object"
    || candidate.scope === null
    || Array.isArray(candidate.scope)
  ) {
    return undefined;
  }
  const scope = candidate.scope as Record<string, unknown>;
  if (
    !(scope.teamId === null || typeof scope.teamId === "string")
    || typeof scope.person !== "string"
    || typeof scope.device !== "string"
  ) {
    return undefined;
  }
  const frame = parseMeshFrame(candidate.frame);
  if (!frame || frame.person !== scope.person || frame.device !== scope.device) return undefined;
  const consentProject = typeof candidate.consentProject === "string"
    ? normalizeMeshProjectIdentity(candidate.consentProject)
    : undefined;
  if (
    (frame.kind === "sync_verification" && !consentProject)
    || (frame.kind !== "sync_verification" && candidate.consentProject !== undefined)
  ) {
    return undefined;
  }
  return {
    spoolVersion: 1,
    scope: {
      teamId: scope.teamId as string | null,
      person: scope.person,
      device: scope.device,
    },
    frame,
    ...(consentProject ? { consentProject } : {}),
  };
}

function sameSpoolScope(left: MeshSpoolScope, right: MeshSpoolScope): boolean {
  return left.teamId === right.teamId
    && left.person === right.person
    && left.device === right.device;
}

function idempotencyKeyForFrame(
  frame: MeshFrame,
  body: string,
  credentialFingerprint: string,
): string {
  if (frame.kind === "sync_verification") {
    // Readiness is tied to the rotating credential that actually reached the
    // relay. The raw token is never persisted or sent in this metadata header;
    // rotating it necessarily produces a distinct retry namespace.
    return `praxis:sync:${sha256(`${credentialFingerprint}\0${body}`)}`;
  }
  if (frame.kind === "context_frame" && /^[A-Za-z0-9._:-]{1,120}$/.test(frame.id)) {
    return `praxis:context:${frame.id}`;
  }
  if (frame.kind === "workframe" && /^[A-Za-z0-9._:-]{1,120}$/.test(frame.id)) {
    return `praxis:${frame.id}`;
  }
  if (frame.kind === "card_event") {
    return `praxis:card:${sha256(body)}`;
  }
  return `praxis:frame:${sha256(body)}`;
}

async function readBoundedRelayAck(response: Response): Promise<string> {
  const declaredRaw = (response as { headers?: Headers }).headers?.get("content-length") ?? "0";
  const declared = Number(declaredRaw);
  if (Number.isFinite(declared) && declared > MAX_RELAY_ACK_BYTES) {
    throw new Error("relay response too large");
  }
  const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RELAY_ACK_BYTES) throw new Error("relay response too large");
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RELAY_ACK_BYTES) {
      await reader.cancel();
      throw new Error("relay response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Resolve an episode from captured session/workspace metadata to one explicit
 * local-root → team-project consent. Absolute roots stay local; only `project`
 * reaches the relay. Ambiguous multi-workspace episodes fail closed.
 */
export function resolveEpisodeProject(
  store: Store,
  episode: Episode,
): MeshEpisodeProject | undefined {
  const actions = store.actions.byIds(episode.actions);
  const workspaces = [...new Set(actions
    .map((action) => action.payload?.cwd)
    .filter((value): value is string => typeof value === "string" && value.startsWith("/"))
    .map((value) => value.replace(/\/+$/, "")))];
  if (workspaces.length === 0) return undefined;

  const consents = PrivacyControlStore.forStore(store).read().meshProjectConsents;
  const matches = new Map<string, MeshEpisodeProject>();
  for (const cwd of workspaces) {
    const consent = resolveConsentedWorkspaceProject(consents, cwd);
    if (!consent) return undefined;
    matches.set(`${consent.workspaceRoot}\0${consent.project}`, {
      project: consent.project,
      repoRoot: consent.workspaceRoot,
    });
  }
  if (matches.size !== 1) return undefined;
  const context = [...matches.values()][0]!;
  const sessionKeys = [...new Set(actions
    .map((action) => action.payload?.sessionKey)
    .filter((value): value is string => typeof value === "string" && value !== ""))];
  return {
    ...context,
    ...(sessionKeys.length === 1 ? { sessionKey: sessionKeys[0] } : {}),
  };
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
  protected projectContext: ((episode: Episode) => MeshEpisodeProject | undefined) | undefined;
  protected currentProjectConsent: (project: string) => boolean;
  protected currentContextConsent: (frame: Extract<MeshFrame, { kind: "context_frame" }>) => boolean;
  protected credentialFingerprint: string;
  protected spoolPath: string;
  protected spoolScope: MeshSpoolScope;
  protected requestTimeoutMs: number;
  protected auditor: EgressAuditor;
  /**
   * Serializes publish()/flushSpool() runs. Concurrent publishes (the agent
   * loop fire-and-forgets several per tick) would otherwise both read the same
   * spool and double-deliver every pending frame (the relay has no dedup), and
   * race their spool rewrites.
   */
  #queue: Promise<unknown> = Promise.resolve();
  #spoolRecordCount: number | undefined;
  #verificationFrames = new Map<string, SyncVerification>();

  constructor(opts: MeshPublisherOptions) {
    const configPath = opts.configPath
      ?? join(homedir(), ".config", "praxis", "mesh.json");
    const config = readConsentConfig(configPath);

    const safeUrl = safeMeshRelayBaseUrl(opts.url);
    if (!safeUrl) throw new Error("mesh relay URL must be credential-free HTTPS or an exact loopback HTTP origin");
    this.url = safeUrl;
    this.token = opts.token;
    const person = safeMeshWireIdentity(opts.person);
    const requestedTeam = opts.teamId === undefined ? undefined : safeMeshWireIdentity(opts.teamId);
    const explicitDevice = opts.device === undefined ? undefined : safeMeshWireIdentity(opts.device);
    if (!person || (opts.teamId !== undefined && !requestedTeam) || (opts.device !== undefined && !explicitDevice)) {
      throw new Error("mesh person, team, and device identities must be bounded opaque identifiers");
    }
    this.person = person;
    this.teamId = requestedTeam;
    if (this.teamId && !explicitDevice) {
      throw new Error("hosted mesh publishers require a provisioned device id");
    }
    this.device = explicitDevice ?? safeMeshWireIdentity(config?.device) ?? hostname();
    if (!safeMeshWireIdentity(this.device)) {
      throw new Error("mesh person, team, and device identities must be bounded opaque identifiers");
    }
    this.project = opts.project ?? basename(process.cwd());
    this.store = opts.store;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.projects = opts.projects !== undefined
      ? [...opts.projects]
      : config?.projects === undefined
        ? undefined
        : [...config.projects];
    this.projectContext = opts.projectContext;
    this.currentProjectConsent = opts.currentProjectConsent ?? (
      config && opts.projects === undefined
        ? (project) => {
            const current = readConsentConfig(configPath);
            return current !== undefined && projectInList(project, current.projects);
          }
        : (project) => this.projectIsAllowed(project)
    );
    this.currentContextConsent = opts.currentContextConsent ?? (() => false);
    this.spoolScope = {
      teamId: this.teamId ?? null,
      person: this.person,
      device: this.device,
    };
    this.credentialFingerprint = sha256(JSON.stringify({
      teamId: this.teamId ?? null,
      person: this.person,
      device: this.device,
      token: this.token,
    }));
    const spoolScopeId = sha256(JSON.stringify(this.spoolScope)).slice(0, 16);
    this.spoolPath = opts.spoolPath
      ?? join(defaultDataDir(), `mesh-outbox-spool-${spoolScopeId}.ndjson`);
    this.requestTimeoutMs = Math.max(250, Math.min(30_000, Math.trunc(opts.requestTimeoutMs ?? 5_000)));
    this.auditor = opts.auditor ?? EgressAuditor.forStore(opts.store);
  }

  /**
   * Build from PRAXIS_MESH_URL + PRAXIS_MESH_TOKEN + PRAXIS_PERSON.
   * Hosted credentials additionally use PRAXIS_MESH_TEAM_ID and the bound
   * PRAXIS_MESH_DEVICE_ID.
   * Returns undefined when any of the three is unset (feature off).
   */
  static fromEnv(
    store?: Store,
    options: MeshPublisherEnvironmentOptions = {},
  ): MeshPublisher | undefined {
    const url = process.env.PRAXIS_MESH_URL;
    const token = process.env.PRAXIS_MESH_TOKEN;
    const person = process.env.PRAXIS_PERSON;
    if (!url || !token || !person) return undefined;
    if (!safeMeshRelayBaseUrl(url)) {
      log.warn("mesh publisher disabled: unsafe relay URL");
      return undefined;
    }
    if (process.env.PRAXIS_MESH_TEAM_ID && !process.env.PRAXIS_MESH_DEVICE_ID) {
      log.warn("mesh publisher disabled: hosted team credentials require a provisioned device id");
      return undefined;
    }
    // Environment credentials alone never grant a project. Each episode is
    // matched at publish time against the live, explicit workspace mapping so
    // a long-running service sees consent changes without a restart.
    return new MeshPublisher({
      url,
      token,
      person,
      store,
      projects: [],
      projectContext: store
        ? (episode) => resolveEpisodeProject(store, episode)
        : () => undefined,
      currentProjectConsent: store
        ? (project) => isMeshProjectConsented(
            PrivacyControlStore.forStore(store).read().meshProjectConsents,
            project,
          )
        : () => false,
      currentContextConsent: store
        ? (frame) => process.env.PRAXIS_MESH_TEAM_ID !== undefined
          && isContextFrameCurrentlyConsented(
            PrivacyControlStore.forStore(store).read(),
            frame,
          )
        : () => false,
      ...(options.spoolPath ? { spoolPath: options.spoolPath } : {}),
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

  /**
   * Publish a content-free receipt proving this credential reached the relay.
   * `project` remains a local consent selector and is retained only alongside
   * a retry spool record; it is never part of the Mesh wire body.
   */
  async publishVerification(
    project: string,
    expectedScope: { teamId: string; deviceId: string },
  ): Promise<PublishResult> {
    const canonicalProject = normalizeMeshProjectIdentity(project);
    if (!canonicalProject) {
      return { ok: false, error: "project identity is invalid" };
    }
    if (!this.currentProjectConsent(canonicalProject)) {
      return { ok: false, error: "project is not currently consented" };
    }
    if (this.teamId !== expectedScope.teamId || this.device !== expectedScope.deviceId) {
      return { ok: false, error: "team relay scope changed; restart required" };
    }

    let frame = this.#verificationFrames.get(canonicalProject);
    if (!frame) {
      frame = this.findSpooledVerification(canonicalProject) ?? {
        v: 0,
        kind: "sync_verification",
        person: this.person,
        device: this.device,
        ts: new Date().toISOString(),
      };
      this.#verificationFrames.set(canonicalProject, frame);
    }
    return this.publishWithConsent(frame, canonicalProject);
  }

  private async publishEpisode(
    episode: Episode,
    status: WorkFrameStatus,
  ): Promise<WorkFrame | undefined> {
    try {
      const context = this.projectContext?.(episode) ?? (
        this.projectIsAllowed(this.project)
          ? { project: this.project, repoRoot: process.cwd() }
          : undefined
      );
      let frame: WorkFrame | undefined;
      if (context) {
        frame = episodeToWorkFrame(episode, {
          person: this.person,
          device: this.device,
          project: context.project,
          store: this.store,
          status,
          repoRoot: context.repoRoot,
          ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
        });
        try {
          await this.publish(frame);
        } catch (error) {
          log.warn("mesh frame publish unexpectedly threw", errorMessage(error));
        }
      } else {
        log.debug("mesh episode has no explicitly consented workspace project");
      }

      if (this.store) {
        const control = PrivacyControlStore.forStore(this.store).read();
        const contextFrames = episodeToContextFrames(episode, {
          person: this.person,
          device: this.device,
          store: this.store,
          control,
          status: status === "active" ? "active" : "done",
          ...(context ? { project: context } : {}),
        });
        for (const contextFrame of contextFrames) {
          try {
            await this.publish(contextFrame);
          } catch (error) {
            log.warn("mesh context frame publish unexpectedly threw", errorMessage(error));
          }
        }
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

  private async publishWithConsent(
    frame: SyncVerification,
    consentProject: string,
  ): Promise<PublishResult> {
    const run = this.#queue.then(() => this.publishNow(frame, consentProject));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async publishNow(frame: MeshFrame, consentProject?: string): Promise<PublishResult> {
    try {
      // The credential is bound to this publisher's person/device identity.
      // Canonicalize the wire record to the same identity as the relay path and
      // X-Mesh-Device-ID so caller data cannot contradict authentication.
      const outbound = this.safeOutboundFrame(redactMeshFrame({
        ...frame,
        person: this.person,
        device: this.device,
      }));
      if (!outbound) return { ok: false, error: "frame has an unsafe identity or artifact path" };
      try {
        await this.flushSpool();
      } catch (error) {
        // A damaged or temporarily unwritable spool must not prevent an
        // otherwise healthy relay from receiving the current frame.
        log.warn("mesh spool flush failed open", errorMessage(error));
      }

      if (!this.frameIsCurrentlyConsented(outbound, consentProject)) {
        return { ok: false, error: "frame is not currently consented" };
      }

      const attempt = await this.postFrame(outbound);
      if (!attempt.ok && attempt.networkFailure) {
        try {
          // Persist the exact redacted wire projection, never the richer caller
          // object. Retry storage is itself a privacy boundary.
          this.appendToSpool(outbound, consentProject);
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
  private projectIsAllowed(project: string): boolean {
    if (this.projects === undefined) return true;
    return projectInList(project, this.projects);
  }

  private frameIsCurrentlyConsented(frame: MeshFrame, consentProject?: string): boolean {
    if (frame.kind === "context_frame") return this.currentContextConsent(frame);
    if (frame.kind === "sync_verification") {
      const project = consentProject && normalizeMeshProjectIdentity(consentProject);
      return project !== undefined && this.currentProjectConsent(project);
    }
    return this.currentProjectConsent(frame.project);
  }

  private async flushSpool(): Promise<void> {
    if (!existsSync(this.spoolPath)) return;

    const records: MeshSpoolLine[] = [];
    const lines = this.readBoundedSpoolLines();
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        const parsed = parseSpoolLine(JSON.parse(line) as unknown);
        if (parsed) records.push(parsed);
        else log.debug("skipping invalid line in mesh spool");
      } catch {
        log.debug("skipping corrupt line in mesh spool");
      }
    }

    if (records.length > MAX_MESH_SPOOL_RECORDS) {
      const dropped = records.length - MAX_MESH_SPOOL_RECORDS;
      records.splice(0, dropped);
      this.recordSpoolDrop(dropped, "record retention limit");
    }

    const retained: MeshSpoolLine[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const pending = this.frameForCurrentScope(record);
      if (!pending) {
        // Another team/person/device owns this durable record. Keep it intact;
        // the matching credential scope may flush it in a later process.
        retained.push(record);
        continue;
      }
      if (!this.frameIsCurrentlyConsented(pending.frame, pending.consentProject)) {
        log.debug("dropping spooled mesh frame whose consent was revoked");
        continue;
      }

      const attempt = await this.postFrame(pending.frame);
      if (!attempt.ok && attempt.networkFailure) {
        this.replaceSpool([...retained, ...records.slice(index)]);
        return;
      }
      if (!attempt.ok) {
        log.warn("dropping spooled mesh frame rejected by relay", attempt.error);
      }
    }

    this.replaceSpool(retained);
  }

  private frameForCurrentScope(record: MeshSpoolLine): PendingMeshFrame | undefined {
    if (isMeshSpoolRecord(record)) {
      return sameSpoolScope(record.scope, this.spoolScope)
        ? {
            frame: record.frame,
            ...(record.consentProject ? { consentProject: record.consentProject } : {}),
          }
        : undefined;
    }

    // Legacy v0 spool lines had no credential scope. They are only safe to
    // migrate for a standalone relay when their person/device already match.
    // A hosted team must leave them quarantined because their tenant is
    // unknowable; guessing would recreate the cross-team leak this fence fixes.
    if (this.teamId !== undefined) return undefined;
    return record.kind !== "sync_verification"
      && record.person === this.person
      && record.device === this.device
      ? { frame: record }
      : undefined;
  }

  private async postFrame(frame: MeshFrame): Promise<PostAttempt> {
    // The wire boundary IS a redaction boundary: whatever frame a caller hands
    // publish(), workframes re-pass the redactor (whitelist projection — extra
    // fields and secret-shaped strings never serialize).
    const outbound = this.safeOutboundFrame(redactMeshFrame(frame));
    if (!outbound) {
      return { ok: false, error: "frame has an unsafe identity or artifact path", networkFailure: false };
    }
    const body = JSON.stringify(outbound);
    if (Buffer.byteLength(body) > MAX_MESH_FRAME_BYTES) {
      return { ok: false, error: "frame exceeds mesh size limit", networkFailure: false };
    }
    const idempotencyKey = idempotencyKeyForFrame(outbound, body, this.credentialFingerprint);
    const audit = (outcome: "succeeded" | "failed", status?: number, error?: string) =>
      this.auditor.record({
        destination: this.url,
        purpose: "mesh_publish",
        categories: outbound.kind === "sync_verification"
          ? ["sync_metadata"]
          : ["work_metadata", "artifact_paths", "evidence_hashes"],
        bytes: Buffer.byteLength(body),
        digest: sha256(body),
        redaction: outbound.kind === "context_frame"
          ? "mesh-v1"
          : outbound.kind === "sync_verification"
            ? "mesh-sync-v0"
            : "mesh-v0",
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
          "idempotency-key": idempotencyKey,
          ...(this.teamId && { "x-mesh-team-id": this.teamId }),
          "x-mesh-device-id": this.device,
        },
        body,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        redirect: "error",
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
      text = await readBoundedRelayAck(response);
    } catch (error) {
      audit("failed", response.status, `response read: ${errorMessage(error)}`);
      return {
        ok: false,
        error: `relay response read failed: ${errorMessage(error)}`,
        networkFailure: true,
      };
    }

    if (!response.ok) {
      const detail = text.trim() || response.statusText || "request failed";
      audit("failed", response.status, detail);
      const retryable = response.status === 408
        || response.status === 425
        || response.status === 429
        || response.status >= 500;
      return {
        ok: false,
        error: `http ${response.status}: ${detail}`,
        networkFailure: retryable,
      };
    }

    try {
      const payload = JSON.parse(text) as unknown;
      if (
        typeof payload === "object"
        && payload !== null
        && (payload as Record<string, unknown>).ok === true
        && Number.isSafeInteger((payload as Record<string, unknown>).seq)
        && Number((payload as Record<string, unknown>).seq) >= 0
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
        networkFailure: true,
      };
    } catch (error) {
      audit("failed", response.status, errorMessage(error));
      return {
        ok: false,
        error: `invalid relay response: ${errorMessage(error)}`,
        networkFailure: true,
      };
    }
  }

  private safeOutboundFrame(frame: MeshFrame): MeshFrame | undefined {
    if (!Number.isFinite(Date.parse(frame.ts)) || frame.ts.length > 64) return undefined;
    if (frame.kind === "sync_verification") return frame;
    if (frame.kind === "context_frame") {
      const safeOpaque = (value: string, max = 120): boolean =>
        value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
      const sourceKinds = new Set(["meeting", "document", "agent_session"]);
      const signals = new Set(["activity", "decision", "requirement", "risk", "question", "handoff"]);
      const statuses = new Set(["active", "done"]);
      const entityKinds = new Set(["initiative", "goal", "ticket", "topic", "customer", "feature"]);
      const linkKinds = new Set(["supports", "depends_on", "blocks", "updates", "duplicates"]);
      if (
        !safeOpaque(frame.id)
        || !safeOpaque(frame.source.id)
        || !sourceKinds.has(frame.source.kind)
        || !signals.has(frame.signal)
        || !statuses.has(frame.status)
        || frame.summary.length > 500
        || frame.entities.some((entity) => !entityKinds.has(entity.kind) || !safeOpaque(entity.key))
        || frame.links.some((link) =>
          !linkKinds.has(link.relation) || !safeOpaque(link.targetId) || link.reason.length > 240
        )
      ) return undefined;
      const artifacts: typeof frame.artifacts = [];
      for (const artifact of frame.artifacts) {
        const repo = normalizeMeshProjectIdentity(artifact.repo);
        const path = safeRepoRelativePath(artifact.path);
        if (!repo || !path) return undefined;
        artifacts.push({ ...artifact, repo, path });
      }
      return { ...frame, artifacts };
    }

    const project = normalizeMeshProjectIdentity(frame.project);
    if (!project) return undefined;
    if (frame.kind === "workframe") {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(frame.id)
        || (frame.status !== "active" && frame.status !== "done" && frame.status !== "abandoned")
      ) return undefined;
    } else if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(frame.cardId)
      || (frame.stage !== "clarify" && frame.stage !== "plan" && frame.stage !== "spec" && frame.stage !== "results")
      || (frame.event !== "raised" && frame.event !== "decided")
    ) {
      return undefined;
    }
    const artifacts: Array<{ repo: string; path: string; branch?: string }> = [];
    for (const artifact of frame.artifacts) {
      const repo = normalizeMeshProjectIdentity(artifact.repo);
      const path = safeRepoRelativePath(artifact.path);
      if (!repo || !path) return undefined;
      artifacts.push({ ...artifact, repo, path });
    }
    return { ...frame, project, artifacts };
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

  private fsyncSpoolDir(): void {
    try {
      const handle = openSync(dirname(this.spoolPath), constants.O_RDONLY);
      try { fsyncSync(handle); } finally { closeSync(handle); }
    } catch {
      // Some filesystems do not support directory fsync; file fsync still holds.
    }
  }

  private recordSpoolDrop(bytes: number, reason: string): void {
    this.auditor.record({
      destination: this.url,
      purpose: "mesh_spool_retention",
      categories: ["work_metadata"],
      bytes: Math.max(0, bytes),
      outcome: "blocked",
      error: reason,
    });
  }

  /** Never read a preexisting queue larger than the process memory contract. */
  private readBoundedSpoolLines(): string[] {
    if (!existsSync(this.spoolPath)) {
      this.#spoolRecordCount = 0;
      return [];
    }
    const stats = lstatSync(this.spoolPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_MESH_SPOOL_BYTES) {
      const quarantine = `${this.spoolPath}.quarantine-${Date.now()}-${process.pid}`;
      renameSync(this.spoolPath, quarantine);
      this.fsyncSpoolDir();
      this.#spoolRecordCount = 0;
      this.recordSpoolDrop(stats.size, "unsafe or oversized preexisting spool quarantined");
      return [];
    }
    const lines = readFileSync(this.spoolPath, "utf8").split(/\r?\n/).filter(Boolean);
    this.#spoolRecordCount = lines.length;
    return lines;
  }

  /** Reuse one pending receipt body so repeated retries cannot grow the queue. */
  private findSpooledVerification(consentProject: string): SyncVerification | undefined {
    if (!existsSync(this.spoolPath)) return undefined;
    for (const line of this.readBoundedSpoolLines().reverse()) {
      try {
        const record = parseSpoolLine(JSON.parse(line) as unknown);
        if (
          record
          && isMeshSpoolRecord(record)
          && sameSpoolScope(record.scope, this.spoolScope)
          && record.consentProject === consentProject
          && record.frame.kind === "sync_verification"
        ) {
          return record.frame;
        }
      } catch {
        // Corrupt records remain isolated until the normal bounded rewrite.
      }
    }
    return undefined;
  }

  private appendToSpool(frame: MeshFrame, consentProject?: string): void {
    if (
      frame.kind === "sync_verification"
      && consentProject
      && this.findSpooledVerification(consentProject)
    ) {
      return;
    }
    this.prepareSpoolDir();
    const record: MeshSpoolRecord = {
      spoolVersion: 1,
      scope: { ...this.spoolScope },
      frame,
      ...(frame.kind === "sync_verification" && consentProject ? { consentProject } : {}),
    };
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > MAX_MESH_FRAME_BYTES) {
      this.recordSpoolDrop(lineBytes, "frame exceeds spool line limit");
      return;
    }
    if (this.#spoolRecordCount === undefined) this.readBoundedSpoolLines();
    const currentBytes = existsSync(this.spoolPath) ? lstatSync(this.spoolPath).size : 0;
    if (
      currentBytes + lineBytes > MAX_MESH_SPOOL_BYTES
      || (this.#spoolRecordCount ?? 0) + 1 > MAX_MESH_SPOOL_RECORDS
    ) {
      const retained: MeshSpoolLine[] = [];
      for (const existing of this.readBoundedSpoolLines()) {
        try {
          const parsed = parseSpoolLine(JSON.parse(existing) as unknown);
          if (parsed) retained.push(parsed);
        } catch {
          // Corrupt lines are dropped while the bounded queue compacts.
        }
      }
      retained.push(record);
      const dropped = Math.max(0, retained.length - MAX_MESH_SPOOL_RECORDS);
      this.replaceSpool(retained.slice(-MAX_MESH_SPOOL_RECORDS));
      if (dropped > 0) this.recordSpoolDrop(dropped, "oldest records evicted at retention limit");
      return;
    }
    const handle = openSync(
      this.spoolPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(handle, line, { encoding: "utf8" });
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    this.#spoolRecordCount = (this.#spoolRecordCount ?? 0) + 1;
    this.fsyncSpoolDir();
  }

  private replaceSpool(records: MeshSpoolLine[]): void {
    if (records.length === 0) {
      rmSync(this.spoolPath, { force: true });
      this.#spoolRecordCount = 0;
      this.fsyncSpoolDir();
      return;
    }
    const retained: MeshSpoolLine[] = [];
    let retainedBytes = 0;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]!;
      const bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
      if (retained.length >= MAX_MESH_SPOOL_RECORDS || retainedBytes + bytes > MAX_MESH_SPOOL_BYTES) {
        continue;
      }
      retained.unshift(record);
      retainedBytes += bytes;
    }
    if (retained.length !== records.length) {
      this.recordSpoolDrop(records.length - retained.length, "oldest records evicted at spool retention limit");
    }
    records = retained;
    if (records.length === 0) {
      rmSync(this.spoolPath, { force: true });
      this.#spoolRecordCount = 0;
      this.fsyncSpoolDir();
      return;
    }
    this.prepareSpoolDir();
    const temporary = `${this.spoolPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      writeFileSync(temporary, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const handle = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(handle); } finally { closeSync(handle); }
      renameSync(temporary, this.spoolPath);
      this.#spoolRecordCount = records.length;
      this.fsyncSpoolDir();
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
