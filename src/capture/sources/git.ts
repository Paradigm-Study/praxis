import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CaptureSource, EventSink } from "../source.ts";
import { logger } from "../../core/log.ts";

const exec = promisify(execFile);
const log = logger("git");

/**
 * Git tap. Polls a repository for new commits, branch switches, and the current
 * staged diff. Emits `commit`, `branch_changed`, and `staged_changed` events.
 */
export class GitSource implements CaptureSource {
  readonly name = "git";
  readonly source = "git" as const;
  #repo: string;
  #timer: ReturnType<typeof setInterval> | undefined;
  #intervalMs: number;
  #runGit: ((args: string[]) => Promise<string>) | undefined;
  #canAcquire: () => boolean;
  #acquisitionRevision: (() => string) | undefined;
  #lastAcquisitionRevision: string | undefined;
  #pollInFlight: Promise<void> | undefined;
  #generation = 0;
  #initialized = false; // first poll establishes a baseline (no emits)
  #lastSha = "";
  #lastBranch = "";
  #lastStaged = "";

  constructor(opts: {
    repo: string;
    intervalMs?: number;
    /** Deterministic command seam for lifecycle tests. */
    runGit?: (args: string[]) => Promise<string>;
    /** Acquisition-time privacy/resource fence; false performs no Git reads. */
    canAcquire?: () => boolean;
    /** Changes whenever privacy/resource controls change, even between polls. */
    acquisitionRevision?: () => string;
  }) {
    this.#repo = opts.repo;
    this.#intervalMs = opts.intervalMs ?? 3000;
    this.#runGit = opts.runGit;
    this.#canAcquire = opts.canAcquire ?? (() => true);
    this.#acquisitionRevision = opts.acquisitionRevision;
  }

  #allowed(): boolean {
    try {
      return this.#canAcquire();
    } catch {
      return false;
    }
  }

  #policyChanged(): boolean {
    if (!this.#acquisitionRevision) return false;
    let revision: string;
    try {
      revision = this.#acquisitionRevision();
    } catch {
      return true;
    }
    if (this.#lastAcquisitionRevision === undefined) {
      this.#lastAcquisitionRevision = revision;
      return false;
    }
    if (revision === this.#lastAcquisitionRevision) return false;
    this.#lastAcquisitionRevision = revision;
    return true;
  }

  /** Run a git command, returning `def` (default "") on failure. */
  async #git(args: string[], def = ""): Promise<string> {
    try {
      if (this.#runGit) return (await this.#runGit(args)).trim();
      const { stdout } = await exec("git", ["-C", this.#repo, ...args]);
      return stdout.trim();
    } catch {
      return def; // e.g. `rev-parse HEAD` in a repo with no commits yet
    }
  }

  start(sink: EventSink): void {
    this.stop();
    const generation = ++this.#generation;
    this.#initialized = false;
    this.#lastSha = "";
    this.#lastBranch = "";
    this.#lastStaged = "";
    this.#lastAcquisitionRevision = undefined;
    const pollOnce = async () => {
      if (this.#policyChanged()) this.#initialized = false;
      if (!this.#allowed()) {
        // Do not invoke Git at all while private/disabled. Requiring a fresh
        // allowed baseline prevents commits/staging from replaying on resume.
        this.#initialized = false;
        return;
      }
      // Each git call is independent so one failure can't skip the others.
      const branch = await this.#git(["rev-parse", "--abbrev-ref", "HEAD"]);
      const head = await this.#git(["rev-parse", "HEAD"]); // "" if no commits
      const staged = await this.#git(["diff", "--cached", "--stat"]);
      if (generation !== this.#generation) return;
      if (!this.#allowed()) {
        this.#initialized = false;
        return;
      }

      // Baseline on the first poll: record current state, emit nothing, so we
      // only report commits/branches/staging that happen AFTER capture starts.
      if (!this.#initialized) {
        this.#initialized = true;
        this.#lastBranch = branch;
        this.#lastSha = head;
        this.#lastStaged = staged;
        return;
      }

      if (branch && this.#lastBranch && branch !== this.#lastBranch) {
        if (!this.#allowed()) {
          this.#initialized = false;
          return;
        }
        sink({
          source: "git", app: "git", window: this.#repo,
          type: "branch_changed",
          payload: { from: this.#lastBranch, to: branch },
        });
      }
      if (branch) this.#lastBranch = branch;

      if (head && head !== this.#lastSha) {
        if (!this.#allowed()) {
          this.#initialized = false;
          return;
        }
        const subject = await this.#git(["log", "-1", "--pretty=%s", head]);
        const files = (await this.#git(["show", "--name-only", "--pretty=format:", head]))
          .split("\n")
          .filter(Boolean);
        if (generation !== this.#generation) return;
        if (!this.#allowed()) {
          this.#initialized = false;
          return;
        }
        sink({
          source: "git", app: "git", window: this.#repo,
          type: "commit",
          payload: { sha: head.slice(0, 7), message: subject, files, branch },
        });
      }
      this.#lastSha = head;

      if (staged && staged !== this.#lastStaged) {
        if (!this.#allowed()) {
          this.#initialized = false;
          return;
        }
        sink({
          source: "git", app: "git", window: this.#repo,
          type: "staged_changed",
          payload: { stat: staged.split("\n").slice(-1)[0] ?? "" },
          blobs: [{ kind: "diff", data: staged }],
        });
      }
      this.#lastStaged = staged;
    };
    const poll = () => {
      // A slow repository must never let interval callbacks race snapshots:
      // stale completions otherwise rewind #lastSha and duplicate commits.
      if (this.#pollInFlight) return;
      const run = pollOnce();
      this.#pollInFlight = run;
      void run
        .catch((error) => log.warn("git poll failed", String(error)))
        .finally(() => {
          if (this.#pollInFlight === run) this.#pollInFlight = undefined;
        });
    };
    poll();
    this.#timer = setInterval(poll, this.#intervalMs);
  }

  stop(): void {
    this.#generation += 1;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
