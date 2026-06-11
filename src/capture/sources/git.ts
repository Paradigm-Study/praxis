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
  #initialized = false; // first poll establishes a baseline (no emits)
  #lastSha = "";
  #lastBranch = "";
  #lastStaged = "";

  constructor(opts: { repo: string; intervalMs?: number }) {
    this.#repo = opts.repo;
    this.#intervalMs = opts.intervalMs ?? 3000;
  }

  /** Run a git command, returning `def` (default "") on failure. */
  async #git(args: string[], def = ""): Promise<string> {
    try {
      const { stdout } = await exec("git", ["-C", this.#repo, ...args]);
      return stdout.trim();
    } catch {
      return def; // e.g. `rev-parse HEAD` in a repo with no commits yet
    }
  }

  start(sink: EventSink): void {
    const poll = async () => {
      // Each git call is independent so one failure can't skip the others.
      const branch = await this.#git(["rev-parse", "--abbrev-ref", "HEAD"]);
      const head = await this.#git(["rev-parse", "HEAD"]); // "" if no commits
      const staged = await this.#git(["diff", "--cached", "--stat"]);

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
        sink({
          source: "git", app: "git", window: this.#repo,
          type: "branch_changed",
          payload: { from: this.#lastBranch, to: branch },
        });
      }
      if (branch) this.#lastBranch = branch;

      if (head && head !== this.#lastSha) {
        const subject = await this.#git(["log", "-1", "--pretty=%s", head]);
        const files = (await this.#git(["show", "--name-only", "--pretty=format:", head]))
          .split("\n")
          .filter(Boolean);
        sink({
          source: "git", app: "git", window: this.#repo,
          type: "commit",
          payload: { sha: head.slice(0, 7), message: subject, files, branch },
        });
      }
      this.#lastSha = head;

      if (staged && staged !== this.#lastStaged) {
        sink({
          source: "git", app: "git", window: this.#repo,
          type: "staged_changed",
          payload: { stat: staged.split("\n").slice(-1)[0] ?? "" },
          blobs: [{ kind: "diff", data: staged }],
        });
      }
      this.#lastStaged = staged;
    };
    void poll();
    this.#timer = setInterval(poll, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }
}
