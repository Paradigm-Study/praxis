import type { ActionEvent, RawEvent } from "../../core/types.ts";
import type { RuleContext } from "../evidence.ts";
import { after, payloadText } from "../evidence.ts";
import { P, score, type Signal } from "../confidence.ts";
import { mkAction } from "../rule.ts";

function num(e: RawEvent, key: string): number | undefined {
  const v = (e.payload as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}
function str(e: RawEvent, key: string): string | undefined {
  const v = (e.payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/** terminal `command_run` => `ran_command`. */
export function ranCommand(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e) => {
    if (e.source !== "terminal" || e.type !== "command_run") return;
    out.push(
      mkAction(ctx, {
        action: "ran_command",
        app: e.app,
        window: e.window,
        startTs: e.ts,
        endTs: e.ts,
        text: str(e, "cmd"),
        scored: score([{ id: e.id, p: P.commandRun, tag: "command_run" }]),
        payload: {
          cmd: str(e, "cmd"),
          exitCode: num(e, "exitCode"),
          cwd: str(e, "cwd"),
          durationMs: num(e, "durationMs"),
        },
        reconstructedBy: "ranCommand",
      }),
    );
  });
  return out;
}

/**
 * A failed command followed by dwelling on the terminal / copying the error =>
 * `inspected_failure`.
 */
export function inspectedFailure(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e, i) => {
    if (e.source !== "terminal" || e.type !== "command_run") return;
    if ((num(e, "exitCode") ?? 0) === 0) return;

    const dwell = after(ctx, i, 20_000, {
      source: "focus_timeline",
      type: "dwell",
      app: e.app,
    });
    const copy = after(ctx, i, 20_000, {
      source: "clipboard",
      type: "clipboard_changed",
    });

    const signals: Signal[] = [{ id: e.id, p: P.failExit, tag: "non_zero_exit" }];
    if (dwell) signals.push({ id: dwell.id, p: P.dwellOnFailure, tag: "dwell" });
    if (copy) signals.push({ id: copy.id, p: P.copyAfterFail, tag: "copied_error" });

    out.push(
      mkAction(ctx, {
        action: "inspected_failure",
        app: e.app,
        window: e.window,
        startTs: e.ts,
        endTs: (copy ?? dwell ?? e).ts,
        text: `inspect failure: ${str(e, "cmd") ?? ""}`.trim(),
        scored: score(signals),
        payload: { cmd: str(e, "cmd"), exitCode: num(e, "exitCode") },
        reconstructedBy: "inspectedFailure",
      }),
    );
  });
  return out;
}

/** Re-running a command that previously failed => `retried`. */
export function retried(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  const cmds = ctx.events.filter(
    (e) => e.source === "terminal" && e.type === "command_run",
  );
  for (let k = 1; k < cmds.length; k++) {
    const cur = cmds[k]!;
    const cmd = str(cur, "cmd");
    // nearest previous run of the same command within 10 minutes
    for (let j = k - 1; j >= 0; j--) {
      const prev = cmds[j]!;
      if (str(prev, "cmd") !== cmd) continue;
      if (Date.parse(cur.ts) - Date.parse(prev.ts) > 600_000) break;
      const prevFailed = (num(prev, "exitCode") ?? 0) !== 0;
      out.push(
        mkAction(ctx, {
          action: "retried",
          app: cur.app,
          window: cur.window,
          startTs: prev.ts,
          endTs: cur.ts,
          text: cmd,
          scored: score([
            { id: cur.id, p: P.sameCmdRetry, tag: "same_command" },
            ...(prevFailed
              ? [{ id: prev.id, p: P.prevFailed, tag: "prev_failed" }]
              : []),
          ]),
          payload: {
            cmd,
            previousExitCode: num(prev, "exitCode"),
            exitCode: num(cur, "exitCode"),
          },
          reconstructedBy: "retried",
        }),
      );
      break;
    }
  }
  return out;
}

export const terminalRules = [ranCommand, inspectedFailure, retried];
