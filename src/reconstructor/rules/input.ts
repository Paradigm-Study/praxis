import type { ActionEvent, RawEvent } from "../../core/types.ts";
import type { RuleContext } from "../evidence.ts";
import { payloadText } from "../evidence.ts";
import { P, score } from "../confidence.ts";
import { mkAction } from "../rule.ts";

const ACCEPT = /\b(accept|apply|keep|approve|confirm|merge)\b/i;
const REJECT = /\b(reject|discard|dismiss|undo|decline|revert|cancel)\b/i;

function str(e: RawEvent, key: string): string | undefined {
  const v = (e.payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/** clipboard `copy` => `copied`; `paste` => `pasted`. */
export function copyPaste(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e) => {
    if (e.source !== "clipboard" || e.type !== "clipboard_changed") return;
    const op = str(e, "op");
    const action = op === "paste" ? "pasted" : "copied";
    out.push(
      mkAction(ctx, {
        action,
        app: e.app,
        window: e.window,
        startTs: e.ts,
        endTs: e.ts,
        text: payloadText(ctx, e),
        scored: score([{ id: e.id, p: P.clipboard, tag: "clipboard" }]),
        reconstructedBy: "copyPaste",
      }),
    );
  });
  return out;
}

/**
 * accessibility `control_clicked` => `clicked_control`, and additionally
 * `accepted_suggestion` / `rejected_suggestion` when the control label says so
 * (e.g. clicking "Accept" on an AI edit). Both actions are emitted — the click
 * is a fact; the acceptance is its meaning.
 */
export function clickedControl(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e) => {
    const isClick =
      (e.source === "accessibility" && e.type === "control_clicked") ||
      (e.source === "input_events" && e.type === "mouse_click" && str(e, "target"));
    if (!isClick) return;
    const title = str(e, "title") ?? str(e, "target") ?? "control";

    out.push(
      mkAction(ctx, {
        action: "clicked_control",
        app: e.app,
        window: e.window,
        startTs: e.ts,
        endTs: e.ts,
        text: title,
        scored: score([{ id: e.id, p: P.controlClick, tag: "control_click" }]),
        payload: { role: str(e, "role"), title },
        reconstructedBy: "clickedControl",
      }),
    );

    if (ACCEPT.test(title)) {
      out.push(
        mkAction(ctx, {
          action: "accepted_suggestion",
          app: e.app,
          window: e.window,
          startTs: e.ts,
          endTs: e.ts,
          text: title,
          scored: score([{ id: e.id, p: P.controlClick, tag: "accept_button" }]),
          reconstructedBy: "clickedControl",
        }),
      );
    } else if (REJECT.test(title)) {
      out.push(
        mkAction(ctx, {
          action: "rejected_suggestion",
          app: e.app,
          window: e.window,
          startTs: e.ts,
          endTs: e.ts,
          text: title,
          scored: score([{ id: e.id, p: P.controlClick, tag: "reject_button" }]),
          reconstructedBy: "clickedControl",
        }),
      );
    }
  });
  return out;
}

export const inputRules = [copyPaste, clickedControl];
