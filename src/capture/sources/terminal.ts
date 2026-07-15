import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  watch,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CaptureSource, EventSink } from "../source.ts";
import { logger } from "../../core/log.ts";

const log = logger("terminal");
const MAX_COMMAND_BACKLOG_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_READ_BYTES = 256 * 1024;
const MAX_COMMAND_LINE_BYTES = 256 * 1024;

interface SecureCommandLog {
  fd: number;
  size: number;
  dev: number;
  ino: number;
}

interface CommandLogParent {
  real: string;
  dev: number;
  ino: number;
}

/**
 * Shell snippet the user adds to ~/.zshrc so the terminal tap can observe
 * commands, cwd, and exit codes without screen-scraping. Each completed command
 * appends one NDJSON line to $PRAXIS_CMDLOG.
 */
// Built from plain strings (not a template literal) because the shell uses
// ${VAR:-default}, which JS template literals would try to interpolate.
export const ZSH_HOOK = [
  "# --- Praxis terminal tap ---",
  'export PRAXIS_CMDLOG="$HOME/.praxis/cmdlog.ndjson"',
  'mkdir -p "$(dirname "$PRAXIS_CMDLOG")"',
  "praxis_preexec() { PRAXIS_T0=$EPOCHREALTIME; PRAXIS_CMD=$1 }",
  "praxis_precmd() {",
  "  local code=$?",
  '  [ -z "$PRAXIS_CMD" ] && return',
  "  local dur=$(( ${EPOCHREALTIME:-0} - ${PRAXIS_T0:-0} ))",
  "  printf '{\"ts\":\"%s\",\"cmd\":%s,\"cwd\":%s,\"exitCode\":%d,\"durationMs\":%d}\\n' \\",
  '    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \\',
  "    \"$(jq -Rn --arg s \"$PRAXIS_CMD\" '$s')\" \\",
  "    \"$(jq -Rn --arg s \"$PWD\" '$s')\" \\",
  "    \"$code\" \"$(printf '%.0f' $((dur*1000)))\" >> \"$PRAXIS_CMDLOG\"",
  '  PRAXIS_CMD=""',
  "}",
  "typeset -ag preexec_functions precmd_functions",
  "preexec_functions+=(praxis_preexec)",
  "precmd_functions+=(praxis_precmd)",
  "",
].join("\n");

/**
 * Terminal tap. Tails the NDJSON command log written by {@link ZSH_HOOK} and
 * emits a `command_run` event per completed command. Non-zero exit codes are
 * what the reconstructor later turns into `inspected_failure` / `retried`.
 */
export class TerminalSource implements CaptureSource {
  readonly name = "terminal";
  readonly source = "terminal" as const;
  #path: string;
  #watcher: ReturnType<typeof watch> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #pollMs: number;
  #canAcquire: (path: string) => boolean;
  #acquisitionRevision: (() => string) | undefined;
  #lastAcquisitionRevision: string | undefined;
  #parent: CommandLogParent | undefined;
  #offset = 0;
  #buf = "";
  #decoder = new StringDecoder("utf8");
  #discardingLine = false;
  #dev: number | undefined;
  #ino: number | undefined;

  constructor(opts: {
    logPath: string;
    pollMs?: number;
    /** Acquisition-time privacy/resource fence; false baselines metadata only. */
    canAcquire?: (path: string) => boolean;
    /** Changes whenever privacy/resource controls change, even between reads. */
    acquisitionRevision?: () => string;
  }) {
    this.#path = resolve(opts.logPath);
    this.#pollMs = opts.pollMs ?? 1000;
    this.#canAcquire = opts.canAcquire ?? (() => true);
    this.#acquisitionRevision = opts.acquisitionRevision;
  }

  start(sink: EventSink): void {
    this.stop();
    if (!existsSync(this.#path)) {
      log.warn(`command log ${this.#path} not found; add ZSH_HOOK to ~/.zshrc`);
      return;
    }
    if (!this.#pinParent()) {
      log.warn("command log parent is unavailable or changed");
      return;
    }
    const opened = this.#openSecure();
    if (!opened) {
      log.warn("command log is not a secure owner-owned regular file");
      return;
    }
    this.#reset(opened, opened.size); // skip existing
    this.#lastAcquisitionRevision = this.#currentRevision();
    closeSync(opened.fd);
    const read = () => this.#drain(sink);
    try {
      this.#watcher = watch(this.#path, read);
      this.#watcher.on("error", (error) => log.debug("command log watch failed", String(error)));
    } catch (error) {
      log.debug("command log watch unavailable", String(error));
    }
    this.#timer = setInterval(read, this.#pollMs);
    this.#timer.unref();
  }

  #pinParent(): boolean {
    try {
      const real = realpathSync.native(dirname(this.#path));
      const stats = statSync(real);
      if (!stats.isDirectory()) return false;
      this.#parent = { real, dev: stats.dev, ino: stats.ino };
      return true;
    } catch {
      return false;
    }
  }

  #openSecure(): SecureCommandLog | undefined {
    let fd: number | undefined;
    try {
      const parent = this.#parent;
      if (!parent) return undefined;
      const currentParent = realpathSync.native(dirname(this.#path));
      const parentStats = statSync(currentParent);
      if (
        currentParent !== parent.real
        || parentStats.dev !== parent.dev
        || parentStats.ino !== parent.ino
      ) return undefined;

      const before = lstatSync(this.#path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return undefined;
      if (typeof process.getuid === "function" && before.uid !== process.getuid()) return undefined;
      const real = realpathSync.native(this.#path);
      if (dirname(real) !== parent.real || basename(real) !== basename(this.#path)) return undefined;
      fd = openSync(
        this.#path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const after = fstatSync(fd);
      if (
        !after.isFile()
        || after.nlink !== 1
        || after.dev !== before.dev
        || after.ino !== before.ino
        || (typeof process.getuid === "function" && after.uid !== process.getuid())
      ) {
        closeSync(fd);
        return undefined;
      }
      return { fd, size: after.size, dev: after.dev, ino: after.ino };
    } catch {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Best effort after validation failure.
        }
      }
      return undefined;
    }
  }

  #reset(identity: { dev: number; ino: number }, offset = 0): void {
    this.#offset = offset;
    this.#buf = "";
    this.#decoder = new StringDecoder("utf8");
    this.#discardingLine = false;
    this.#dev = identity.dev;
    this.#ino = identity.ino;
  }

  #allowed(): boolean {
    try {
      return this.#canAcquire(this.#path);
    } catch {
      return false;
    }
  }

  #currentRevision(): string | undefined {
    try {
      return this.#acquisitionRevision?.();
    } catch {
      return undefined;
    }
  }

  #drain(sink: EventSink): void {
    let opened: SecureCommandLog | undefined;
    try {
      opened = this.#openSecure();
      if (!opened) return;
      if (this.#dev !== opened.dev || this.#ino !== opened.ino) this.#reset(opened);
      const revision = this.#currentRevision();
      if (this.#acquisitionRevision) {
        if (revision === undefined) {
          this.#reset(opened, opened.size);
          return;
        }
        if (
          this.#lastAcquisitionRevision === undefined
          || revision !== this.#lastAcquisitionRevision
        ) {
          this.#lastAcquisitionRevision = revision;
          this.#reset(opened, opened.size);
          return;
        }
      }
      if (!this.#allowed()) {
        // Metadata-only baseline: private/disabled command bytes are never read
        // and cannot be replayed when capture resumes.
        this.#reset(opened, opened.size);
        return;
      }
      if (opened.size < this.#offset) this.#reset(opened);
      if (opened.size <= this.#offset) return;
      const backlog = opened.size - this.#offset;
      if (backlog > MAX_COMMAND_BACKLOG_BYTES) {
        this.#reset(opened, opened.size);
        return;
      }
      const len = Math.min(backlog, MAX_COMMAND_READ_BYTES);
      const chunk = Buffer.allocUnsafe(len);
      const bytesRead = readSync(opened.fd, chunk, 0, len, this.#offset);
      if (bytesRead <= 0) return;
      this.#offset += bytesRead;
      let decoded = this.#decoder.write(chunk.subarray(0, bytesRead));
      if (this.#discardingLine) {
        const newline = decoded.indexOf("\n");
        if (newline < 0) return;
        decoded = decoded.slice(newline + 1);
        this.#discardingLine = false;
      }
      this.#buf += decoded;
      let nl: number;
      while ((nl = this.#buf.indexOf("\n")) >= 0) {
        const rawLine = this.#buf.slice(0, nl);
        this.#buf = this.#buf.slice(nl + 1);
        if (Buffer.byteLength(rawLine, "utf8") > MAX_COMMAND_LINE_BYTES) continue;
        const line = rawLine.trim();
        if (line) this.#emit(line, sink);
      }
      if (Buffer.byteLength(this.#buf, "utf8") > MAX_COMMAND_LINE_BYTES) {
        this.#buf = "";
        this.#decoder = new StringDecoder("utf8");
        this.#discardingLine = true;
      }
    } catch (err) {
      log.debug("drain failed", String(err));
    } finally {
      if (opened !== undefined) {
        try {
          closeSync(opened.fd);
        } catch (error) {
          log.debug("command log close failed", String(error));
        }
      }
    }
  }

  #emit(line: string, sink: EventSink): void {
    try {
      const rec = JSON.parse(line) as {
        ts?: string;
        cmd: string;
        cwd?: string;
        exitCode?: number;
        durationMs?: number;
      };
      if (typeof rec.cmd !== "string") return;
      const cwd = typeof rec.cwd === "string" ? rec.cwd : undefined;
      sink({
        source: "terminal",
        app: "iTerm2",
        window: cwd ?? "shell",
        type: "command_run",
        ...(typeof rec.ts === "string" ? { ts: rec.ts } : {}),
        payload: {
          cmd: rec.cmd,
          ...(cwd === undefined ? {} : { cwd }),
          exitCode: typeof rec.exitCode === "number" && Number.isFinite(rec.exitCode)
            ? rec.exitCode
            : 0,
          durationMs: typeof rec.durationMs === "number" && Number.isFinite(rec.durationMs)
            ? rec.durationMs
            : 0,
        },
      });
    } catch {
      log.debug("bad command-log line");
    }
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#parent = undefined;
    this.#lastAcquisitionRevision = undefined;
    this.#offset = 0;
    this.#buf = "";
    this.#decoder = new StringDecoder("utf8");
    this.#discardingLine = false;
    this.#dev = undefined;
    this.#ino = undefined;
  }
}
