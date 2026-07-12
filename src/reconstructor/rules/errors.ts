import type { ActionEvent, RawEvent } from "../../core/types.ts";
import type { Rule } from "../rule.ts";
import type { RuleContext } from "../evidence.ts";
import { score, type Signal } from "../confidence.ts";
import { mkAction } from "../rule.ts";
import { toMs } from "../../core/time.ts";

/**
 * Error/failure reconstruction: correlate independent failure signals into a
 * single `encountered_error` interpretation.
 *
 * Three corroborating channels:
 *   - terminal output containing an error keyword AND a stack-frame-like line
 *     (a keyword alone — "0 failed" in a green test run — is too noisy);
 *   - a screen frame whose OCR text shows error language (weak on its own:
 *     the user may just be *reading about* an error);
 *   - an agent-session tool_result flagged is_error (explicit, but agents
 *     routinely recover from tool errors without the user ever noticing).
 *
 * Each signal alone is deliberately weak (< 0.6); noisy-OR corroboration
 * across channels is what pushes an action into "the user really hit an
 * error" territory that downstream dispatch is allowed to act on.
 */

/** Error-language keywords (the dispatch trigger's shared vocabulary). */
const ERROR_TEXT = /(error|exception|traceback|failed|FAIL|✗)/i;

/**
 * A stack-frame-like line: JS ("at fn (file.ts:12:3)"), Python
 * ('File "x.py", line 9'), or a generic file.ext:line reference.
 */
const STACK_FRAME =
  /(?:^|\n)\s*at\s+.+:\d+|(?:^|\n)\s*File "[^"]+", line \d+|[\w./\\-]+\.[A-Za-z]\w*:\d+/;

/** Standalone signal probabilities — each alone stays below 0.6. */
const P_TERMINAL = 0.55;
const P_AGENT_TOOL = 0.5;
const P_FRAME = 0.45;
/** Repeats of an already-seen channel barely move the needle. */
const P_REPEAT = 0.05;
/** At most this many repeat signals per channel (keeps one noisy channel < 0.6). */
const MAX_REPEATS = 2;

/** Signals closer than this belong to the same error occurrence. */
const CLUSTER_GAP_MS = 30_000;

type ErrorSignalKind = "terminal_error" | "agent_tool_error" | "frame_error";

interface ErrorHit {
  event: RawEvent;
  kind: ErrorSignalKind;
  p: number;
  text: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Output-ish text on a terminal event: inline payload fields, then blobs. */
function terminalText(ctx: RuleContext, e: RawEvent): string {
  const p = e.payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["output", "stderr", "stdout", "text", "summary", "message"]) {
    const v = str(p[key]);
    if (v) parts.push(v);
  }
  if (ctx.blob) {
    for (const ref of e.blobRefs) {
      const t = ctx.blob(ref);
      if (t) parts.push(t);
    }
  }
  return parts.join("\n");
}

/** Error-ish text on an agent tool_result event. */
function toolResultText(ctx: RuleContext, e: RawEvent): string {
  const p = e.payload as Record<string, unknown>;
  const parts: string[] = [];
  // `preview` is the agent-sessions channel: transcripts carry only a hashed
  // body plus a short redaction-safe preview (see capture/sources/agentSessions.ts).
  for (const key of ["content", "text", "error", "output", "message", "preview"]) {
    const v = str(p[key]);
    if (v) parts.push(v);
  }
  if (ctx.blob) {
    for (const ref of e.blobRefs) {
      const t = ctx.blob(ref);
      if (t) parts.push(t);
    }
  }
  return parts.join("\n");
}

/** Classify every event that carries a failure signal. Events stay time-sorted. */
function findHits(ctx: RuleContext): ErrorHit[] {
  const hits: ErrorHit[] = [];
  for (const e of ctx.events) {
    if (e.source === "terminal") {
      const t = terminalText(ctx, e);
      if (t && ERROR_TEXT.test(t) && STACK_FRAME.test(t)) {
        hits.push({ event: e, kind: "terminal_error", p: P_TERMINAL, text: t });
      }
    } else if (e.source === "screen_video") {
      const ocr = str((e.payload as Record<string, unknown>).ocrText);
      if (ocr && ERROR_TEXT.test(ocr)) {
        hits.push({ event: e, kind: "frame_error", p: P_FRAME, text: ocr });
      }
    } else if (e.source === "ai_proxy") {
      const p = e.payload as Record<string, unknown>;
      const isToolResult = e.type === "tool_result" || p.type === "tool_result";
      const isError = p.is_error === true || p.isError === true;
      if (isToolResult && isError) {
        const t = toolResultText(ctx, e) || "agent tool_result reported is_error";
        hits.push({ event: e, kind: "agent_tool_error", p: P_AGENT_TOOL, text: t });
      }
    }
  }
  return hits;
}

/** Best text source for describing the error, most structured channel first. */
const KIND_PRIORITY: ErrorSignalKind[] = [
  "terminal_error",
  "agent_tool_error",
  "frame_error",
];

function clusterToAction(ctx: RuleContext, cluster: ErrorHit[]): ActionEvent {
  // One full-strength signal per channel; repeats of the same channel add only
  // a whisper (an error scrolling across five frames is still ONE sighting).
  const seen = new Map<ErrorSignalKind, number>();
  const signals: Signal[] = [];
  for (const h of cluster) {
    const n = seen.get(h.kind) ?? 0;
    if (n === 0) {
      signals.push({ id: h.event.id, p: h.p, tag: h.kind });
    } else if (n <= MAX_REPEATS) {
      signals.push({ id: h.event.id, p: P_REPEAT, tag: `more_${h.kind}` });
    }
    seen.set(h.kind, n + 1);
  }
  const scored = score(signals);

  const first = cluster[0]!;
  const last = cluster[cluster.length - 1]!;
  const best = KIND_PRIORITY.map((k) => cluster.find((h) => h.kind === k)).find(
    (h) => h !== undefined,
  )!;
  const errorText = best.text.trim();
  const firstLine = errorText.split("\n").find((l) => l.trim().length > 0) ?? "";

  const kinds = [...new Set(cluster.map((h) => h.kind))];
  const uncertainty =
    scored.confidence < 0.6
      ? [
          "single error signal — output may be stale, already handled, or merely on screen",
        ]
      : undefined;

  return mkAction(ctx, {
    action: "encountered_error",
    app: first.event.app,
    window: first.event.window,
    startTs: first.event.ts,
    endTs: last.event.ts,
    text: firstLine.slice(0, 160),
    scored,
    uncertainty,
    payload: {
      errorText: errorText.slice(0, 500),
      signalKinds: kinds,
    },
    reconstructedBy: "errors.encounteredError",
  });
}

/** Failure signals across channels => `encountered_error`. */
export function encounteredError(ctx: RuleContext): ActionEvent[] {
  const hits = findHits(ctx);
  const out: ActionEvent[] = [];
  let cluster: ErrorHit[] = [];
  const flush = () => {
    if (cluster.length > 0) {
      out.push(clusterToAction(ctx, cluster));
      cluster = [];
    }
  };
  for (const h of hits) {
    const prev = cluster[cluster.length - 1];
    if (prev && toMs(h.event.ts) - toMs(prev.event.ts) > CLUSTER_GAP_MS) flush();
    cluster.push(h);
  }
  flush();
  return out;
}

export const errorRules: Rule[] = [encounteredError];
