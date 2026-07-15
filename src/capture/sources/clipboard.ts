import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CaptureSource, EventSink } from "../source.ts";
import { logger } from "../../core/log.ts";
import { sha256 } from "../../core/hash.ts";

const exec = promisify(execFile);
const log = logger("clipboard");

/**
 * Clipboard tap. Polls the macOS pasteboard (`pbpaste`) and emits a
 * `clipboard_changed` event whenever the contents change. A real build would
 * also hook Cmd+C/Cmd+V via the input tap to distinguish copy vs paste; here we
 * record the movement of content.
 */
export class ClipboardSource implements CaptureSource {
  readonly name = "clipboard";
  readonly source = "clipboard" as const;
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastHash = "";
  #initialized = false;
  #needsPrivacyBaseline = true;
  #pollInFlight: Promise<void> | undefined;
  #generation = 0;
  #intervalMs: number;
  #frontApp: () => { app: string; window: string };
  #canAcquire: (front: { app: string; window: string }) => boolean;
  #readClipboard: () => Promise<string>;

  constructor(opts: {
    intervalMs?: number;
    frontApp?: () => { app: string; window: string };
    /** Pre-acquisition privacy fence. Called before pbpaste is executed. */
    canAcquire?: (front: { app: string; window: string }) => boolean;
    /** Injection seam proving a denied policy never executes pbpaste. */
    readClipboard?: () => Promise<string>;
  } = {}) {
    this.#intervalMs = opts.intervalMs ?? 1000;
    this.#frontApp = opts.frontApp ?? (() => ({ app: "unknown", window: "" }));
    this.#canAcquire = opts.canAcquire ?? (() => true);
    this.#readClipboard = opts.readClipboard ?? (async () => (await exec("pbpaste")).stdout);
  }

  start(sink: EventSink): void {
    this.stop();
    const generation = ++this.#generation;
    this.#lastHash = "";
    this.#initialized = false;
    this.#needsPrivacyBaseline = true;
    const pollOnce = async () => {
      try {
        const front = this.#frontApp();
        if (!this.#canAcquire(front)) {
          this.#needsPrivacyBaseline = true;
          return;
        }
        const stdout = await this.#readClipboard();
        if (generation !== this.#generation) return;
        // Re-check current context after the asynchronous read. Ingest has a
        // final fence too, but the source must not surface a value after the
        // user entered private mode while pbpaste was pending.
        if (!this.#canAcquire(this.#frontApp())) {
          this.#needsPrivacyBaseline = true;
          return;
        }
        const hash = sha256(stdout);
        if (!this.#initialized || this.#needsPrivacyBaseline) {
          // Startup and every privacy gap establish a silent baseline. A value
          // copied before capture or while blocked is not a new live action.
          this.#initialized = true;
          this.#needsPrivacyBaseline = false;
          this.#lastHash = hash;
          return;
        }
        if (hash !== this.#lastHash) {
          this.#lastHash = hash;
          // Clearing the pasteboard is state, not useful captured content, but
          // it must advance dedupe so copying the same value again is observed.
          if (!stdout) return;
          const big = stdout.length > 256;
          sink({
            source: "clipboard",
            app: front.app,
            window: front.window,
            type: "clipboard_changed",
            // Inline short content; offload large clipboard contents to a blob.
            payload: big
              ? { op: "copy", length: stdout.length }
              : { op: "copy", text: stdout },
            blobs: big ? [{ kind: "text", data: stdout }] : [],
          });
        }
      } catch (err) {
        log.debug("pbpaste failed", String(err));
      }
    };
    const poll = () => {
      if (this.#pollInFlight) return;
      const run = pollOnce();
      this.#pollInFlight = run;
      void run.finally(() => {
        if (this.#pollInFlight === run) this.#pollInFlight = undefined;
      });
    };
    poll();
    this.#timer = setInterval(poll, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#generation += 1;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
