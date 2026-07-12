import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CaptureSource, EventSink } from "../source.ts";
import { logger } from "../../core/log.ts";

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
  #last = "";
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
    this.#timer = setInterval(async () => {
      try {
        const front = this.#frontApp();
        if (!this.#canAcquire(front)) return;
        const stdout = await this.#readClipboard();
        if (stdout && stdout !== this.#last) {
          this.#last = stdout;
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
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }
}
