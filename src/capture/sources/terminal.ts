import { watch, openSync, readSync, fstatSync, existsSync, closeSync } from "node:fs";
import type { CaptureSource, EventSink } from "../source.ts";
import { logger } from "../../core/log.ts";

const log = logger("terminal");

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
  #offset = 0;
  #buf = "";

  constructor(opts: { logPath: string }) {
    this.#path = opts.logPath;
  }

  start(sink: EventSink): void {
    if (!existsSync(this.#path)) {
      log.warn(`command log ${this.#path} not found; add ZSH_HOOK to ~/.zshrc`);
      return;
    }
    this.#offset = fstatSync(openSync(this.#path, "r")).size; // skip existing
    const read = () => this.#drain(sink);
    this.#watcher = watch(this.#path, () => read());
  }

  #drain(sink: EventSink): void {
    let fd: number | undefined;
    try {
      fd = openSync(this.#path, "r");
      const size = fstatSync(fd).size;
      if (size <= this.#offset) return;
      const len = size - this.#offset;
      const chunk = Buffer.alloc(len);
      readSync(fd, chunk, 0, len, this.#offset);
      this.#offset = size;
      this.#buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.#buf.indexOf("\n")) >= 0) {
        const line = this.#buf.slice(0, nl).trim();
        this.#buf = this.#buf.slice(nl + 1);
        if (line) this.#emit(line, sink);
      }
    } catch (err) {
      log.debug("drain failed", String(err));
    } finally {
      if (fd !== undefined) closeSync(fd);
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
      sink({
        source: "terminal",
        app: "iTerm2",
        window: rec.cwd ?? "shell",
        type: "command_run",
        ts: rec.ts,
        payload: {
          cmd: rec.cmd,
          cwd: rec.cwd,
          exitCode: rec.exitCode ?? 0,
          durationMs: rec.durationMs ?? 0,
        },
      });
    } catch {
      log.debug("bad command-log line", line);
    }
  }

  stop(): void {
    this.#watcher?.close();
  }
}
