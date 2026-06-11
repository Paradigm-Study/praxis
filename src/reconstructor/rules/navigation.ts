import type { ActionEvent, RawEvent } from "../../core/types.ts";
import type { RuleContext } from "../evidence.ts";
import { inWindow, payloadText } from "../evidence.ts";
import { P, score, type Signal } from "../confidence.ts";
import { mkAction } from "../rule.ts";
import { toMs } from "../../core/time.ts";

function str(e: RawEvent, key: string): string | undefined {
  const v = (e.payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}
function num(e: RawEvent, key: string): number | undefined {
  const v = (e.payload as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

/** focus_timeline `app_focused` => `switched_app`. */
export function switchedApp(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e) => {
    if (e.source !== "focus_timeline" || e.type !== "app_focused") return;
    const from = str(e, "from");
    const to = str(e, "to") ?? e.app;
    out.push(
      mkAction(ctx, {
        action: "switched_app",
        app: e.app,
        window: e.window,
        startTs: e.ts,
        endTs: e.ts,
        text: from ? `${from} → ${to}` : to,
        scored: score([{ id: e.id, p: P.appFocused, tag: "app_focused" }]),
        payload: { from, to },
        reconstructedBy: "switchedApp",
      }),
    );
  });
  return out;
}

/** browser_dom `page_loaded` => `opened_page`. */
export function openedPage(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e) => {
    if (e.source !== "browser_dom" || e.type !== "page_loaded") return;
    out.push(
      mkAction(ctx, {
        action: "opened_page",
        app: e.app,
        window: e.window,
        startTs: e.ts,
        endTs: e.ts,
        text: str(e, "title") ?? str(e, "url"),
        scored: score([{ id: e.id, p: P.pageLoaded, tag: "page_loaded" }]),
        payload: { url: str(e, "url"), title: str(e, "title") },
        reconstructedBy: "openedPage",
      }),
    );
  });
  return out;
}

/**
 * A long dwell with no input. If accessibility text was available we call it a
 * confident `read_dwelled`; if only focus + screen agree (no AX) we emit a weak,
 * explicitly-uncertain `possibly_reading_*` — the design doc's worked example of
 * weak evidence producing a weak action.
 */
export function readDwelled(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e) => {
    if (e.source !== "focus_timeline" || e.type !== "dwell") return;
    const dwellMs = num(e, "dwellMs") ?? 0;
    if (dwellMs < 3000) return;
    const end = toMs(e.ts);
    const start = end - dwellMs;

    const hasInput = inWindow(ctx, start, end, { source: "input_events" }).length > 0;
    if (hasInput) return;

    const ax = inWindow(ctx, start, end, { source: "accessibility", app: e.app });
    const screen = inWindow(ctx, start, end, { source: "screen_video", app: e.app });

    if (ax.length > 0) {
      const signals: Signal[] = [
        { id: e.id, p: P.dwellWithAx, tag: "dwell" },
        { id: ax[0]!.id, p: P.axPresent, tag: "ax_text" },
      ];
      out.push(
        mkAction(ctx, {
          action: "read_dwelled",
          app: e.app,
          window: e.window,
          startTs: new Date(start).toISOString(),
          endTs: e.ts,
          text: payloadText(ctx, ax[ax.length - 1]!),
          scored: score(signals),
          payload: { dwellMs },
          reconstructedBy: "readDwelled",
        }),
      );
    } else if (screen.length > 0) {
      const slug = e.app.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      out.push(
        mkAction(ctx, {
          action: `possibly_reading_${slug}`,
          app: e.app,
          window: e.window,
          startTs: new Date(start).toISOString(),
          endTs: e.ts,
          text: `possibly reading ${e.window || e.app}`,
          scored: score([
            { id: e.id, p: P.dwellNoAx, tag: "dwell" },
            { id: screen[0]!.id, p: P.screenOnly, tag: "screen_only" },
          ]),
          uncertainty: ["focus and screen agree, but no AX text available"],
          payload: { dwellMs },
          reconstructedBy: "readDwelled",
        }),
      );
    }
  });
  return out;
}

export const navigationRules = [switchedApp, openedPage, readDwelled];
