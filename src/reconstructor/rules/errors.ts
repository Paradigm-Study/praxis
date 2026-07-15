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
 * Three evidence channels:
 *   - terminal output containing an error keyword AND a stack-frame-like line
 *     (a keyword alone — "0 failed" in a green test run — is too noisy);
 *   - a screen frame whose OCR text shows error language (corroboration only:
 *     the user may just be *reading about* an error, and OCR is noisy);
 *   - an agent-session tool_result flagged is_error (explicit, but agents
 *     routinely recover from tool errors without the user ever noticing).
 *
 * Screen-only clusters never become actions. A terminal stack trace or an
 * unresolved failed agent tool result is structured evidence and may stand on
 * its own; nearby OCR can corroborate it without becoming the anchor. A tool
 * failure that the agent recovers from within the same user turn is execution
 * noise, not a substantive error for the user. Keeping the structured event as
 * the anchor makes action ids stable when a rolling reconstruction window
 * sheds older frames.
 */

/** Error-language keywords (the dispatch trigger's shared vocabulary). */
const ERROR_TEXT = /(?:error|exception|traceback|fail(?:ed|ure)?|✗)/i;

/** Common success/documentation phrases that happen to contain error words. */
const NEGATED_ERROR_TEXT =
  /(?:\b(?:0|no|zero)\s+(?:errors?|failures?|failed)\b|\b(?:errors?|failures?|failed)\s*[:=]\s*0\b|\berror\s+handling\b|\berror\s+(?:docs?|documentation|messages?|states?|examples?)\b)/i;

/**
 * A frame is a useful corroborator only when one line resembles an actual
 * failure, not merely a menu label or prose that mentions errors.
 */
const FAILURE_LINE =
  /(?:\b[A-Za-z][A-Za-z0-9_.-]*(?:Error|Exception)\b|^\s*(?:error|exception|traceback)\b|\b(?:build|command|compile|compilation|connection|operation|request|test)\s+(?:failed|failure)\b|✗)/i;

/**
 * A stack-frame-like line: JS ("at fn (file.ts:12:3)"), Python
 * ('File "x.py", line 9'), or a generic file.ext:line reference.
 */
const STACK_FRAME =
  /(?:^|\n)\s*at\s+.+:\d+|(?:^|\n)\s*File "[^"]+", line \d+|[\w./\\-]+\.[A-Za-z]\w*:\d+/;

/** Structured signals may stand alone; a screen frame never may. */
const P_TERMINAL = 0.72;
const P_AGENT_TOOL = 0.68;
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
  context: ErrorContext;
}

interface ErrorContext {
  app: string;
  window: string;
  sessionKey?: string;
  cwd?: string;
  command?: string;
  failureKey?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalized(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const result = cleanLine(value).toLowerCase();
  return result.length > 0 ? result : undefined;
}

/** The exact failure-looking line, rather than an unrelated OCR/header line. */
function matchedErrorLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  return lines.find((line) =>
    ERROR_TEXT.test(line) && FAILURE_LINE.test(line) && !NEGATED_ERROR_TEXT.test(line),
  );
}

/** A short, bounded excerpt beginning at the matched failure line. */
function errorExcerpt(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const index = lines.findIndex((line) =>
    ERROR_TEXT.test(line) && FAILURE_LINE.test(line) && !NEGATED_ERROR_TEXT.test(line),
  );
  if (index < 0) return undefined;
  return lines.slice(index, index + 4).join("\n").slice(0, 500);
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

function isAgentToolResult(e: RawEvent): boolean {
  if (e.source !== "ai_proxy") return false;
  const payload = e.payload as Record<string, unknown>;
  return e.type === "tool_result" || payload.type === "tool_result";
}

function isAgentToolError(e: RawEvent): boolean {
  if (!isAgentToolResult(e)) return false;
  const payload = e.payload as Record<string, unknown>;
  return payload.is_error === true || payload.isError === true;
}

function toolUseForResult(
  ctx: RuleContext,
  resultIndex: number,
): RawEvent | undefined {
  const result = ctx.events[resultIndex]!;
  const resultPayload = result.payload as Record<string, unknown>;
  const sessionKey = str(resultPayload.sessionKey);
  const toolUseId = str(resultPayload.toolUseId);
  if (!sessionKey || !toolUseId) return undefined;

  for (let index = resultIndex - 1; index >= 0; index -= 1) {
    const candidate = ctx.events[index]!;
    if (candidate.source !== "ai_proxy") continue;
    const payload = candidate.payload as Record<string, unknown>;
    if (str(payload.sessionKey) !== sessionKey) continue;
    if (candidate.type === "ai_request" && str(payload.role) === "user") break;
    if (
      candidate.type === "ai_response" &&
      str(payload.toolUseId) === toolUseId &&
      str(payload.tool) !== undefined
    ) return candidate;
  }
  return undefined;
}

function hitContext(
  event: RawEvent,
  text: string,
  toolUse?: RawEvent,
): ErrorContext {
  const payload = event.payload as Record<string, unknown>;
  const toolPayload = toolUse?.payload as Record<string, unknown> | undefined;
  return {
    app: event.app,
    window: event.window,
    sessionKey: str(payload.sessionKey),
    cwd: str(payload.cwd) ?? str(toolPayload?.cwd),
    command: str(payload.cmd) ?? str(payload.command) ?? str(toolPayload?.command),
    failureKey: normalized(matchedErrorLine(text) ?? text.split("\n")[0]),
  };
}

const EXPLICIT_UNRESOLVED_RESPONSE =
  /\b(?:still\s+(?:failing|broken|blocked)|tests?\s+(?:are|is|remain)\s+failing|could\s+not|couldn't|unable\s+to|blocked\s+by|permission\s+denied|not\s+(?:fixed|resolved)|remains?\s+(?:broken|failing|blocked))\b/i;

/**
 * Claude tool calls often fail speculatively and then succeed on a retry or a
 * different approach. Suppress that implementation detail only when the
 * transcript provides both pieces of structural recovery evidence in the same
 * session and user turn:
 *
 *   failed tool_result -> successful tool_result -> final assistant response
 *
 * A final response alone can report that work is still blocked, so it is not
 * sufficient. Likewise, a later user turn must never retroactively erase an
 * unresolved failure from the turn where it occurred.
 */
function recoveredAgentToolError(ctx: RuleContext, index: number): boolean {
  const failed = ctx.events[index]!;
  const failedPayload = failed.payload as Record<string, unknown>;
  const sessionKey = str(failedPayload.sessionKey);
  if (!sessionKey) return false;

  let successfulToolResult = false;
  for (let nextIndex = index + 1; nextIndex < ctx.events.length; nextIndex += 1) {
    const next = ctx.events[nextIndex]!;
    if (next.source !== "ai_proxy") continue;
    const payload = next.payload as Record<string, unknown>;
    if (str(payload.sessionKey) !== sessionKey) continue;

    // Direct user text begins a new turn. A tool_result is encoded as an
    // ai_request too, so use its explicit role rather than the event type.
    if (next.type === "ai_request" && str(payload.role) === "user") break;

    if (isAgentToolResult(next)) {
      // Recovery often uses a different tool (failed Read -> successful Edit,
      // failed Bash -> successful Write). The clean final response below is
      // the turn-level evidence that this success actually resolved the work;
      // an explicit still-failing final remains unsuppressed.
      if (!isAgentToolError(next)) successfulToolResult = true;
      continue;
    }

    const finalAssistantResponse =
      next.type === "ai_response" &&
      str(payload.role) === "assistant" &&
      str(payload.textHash) !== undefined &&
      str(payload.tool) === undefined &&
      str(payload.stopReason) !== "tool_use";
    const finalPreview = str(payload.preview) ?? "";
    if (
      finalAssistantResponse &&
      successfulToolResult &&
      !EXPLICIT_UNRESOLVED_RESPONSE.test(finalPreview)
    ) return true;
  }
  return false;
}

/** Classify every event that carries a failure signal. Events stay time-sorted. */
function findHits(ctx: RuleContext): ErrorHit[] {
  const hits: ErrorHit[] = [];
  for (const [index, e] of ctx.events.entries()) {
    if (e.source === "terminal") {
      const t = terminalText(ctx, e);
      const excerpt = t ? errorExcerpt(t) : undefined;
      if (excerpt && STACK_FRAME.test(t)) {
        hits.push({
          event: e,
          kind: "terminal_error",
          p: P_TERMINAL,
          text: excerpt,
          context: hitContext(e, excerpt),
        });
      }
    } else if (e.source === "screen_video") {
      const ocr = str((e.payload as Record<string, unknown>).ocrText);
      const line = ocr ? matchedErrorLine(ocr) : undefined;
      if (line) {
        hits.push({
          event: e,
          kind: "frame_error",
          p: P_FRAME,
          text: line,
          context: hitContext(e, line),
        });
      }
    } else if (e.source === "ai_proxy") {
      if (isAgentToolError(e) && !recoveredAgentToolError(ctx, index)) {
        const raw = toolResultText(ctx, e);
        const t = (raw && (errorExcerpt(raw) ?? cleanLine(raw).slice(0, 500)))
          || "agent tool_result reported is_error";
        hits.push({
          event: e,
          kind: "agent_tool_error",
          p: P_AGENT_TOOL,
          text: t,
          context: hitContext(e, t, toolUseForResult(ctx, index)),
        });
      }
    }
  }
  return hits;
}

function sameLocation(a: ErrorHit, b: ErrorHit): boolean {
  if (a.context.app !== b.context.app) return false;
  return a.context.window === b.context.window;
}

function sameCwd(a: ErrorHit, b: ErrorHit): boolean {
  const aCwd = normalized(a.context.cwd);
  const bCwd = normalized(b.context.cwd);
  return aCwd !== undefined && aCwd === bCwd;
}

function commandConnects(a: ErrorHit, b: ErrorHit): boolean {
  const aCommand = normalized(a.context.command);
  const bCommand = normalized(b.context.command);
  if (aCommand && bCommand && aCommand === bCommand) return true;
  const aText = normalized(a.text);
  const bText = normalized(b.text);
  return (
    (aCommand !== undefined && aCommand.length >= 6 && bText?.includes(aCommand) === true) ||
    (bCommand !== undefined && bCommand.length >= 6 && aText?.includes(bCommand) === true)
  );
}

function sameFailureText(a: ErrorHit, b: ErrorHit): boolean {
  return a.context.failureKey !== undefined &&
    a.context.failureKey === b.context.failureKey;
}

function structuredCompatible(a: ErrorHit, b: ErrorHit): boolean {
  if (a.kind === "agent_tool_error" && b.kind === "agent_tool_error") {
    const aSession = a.context.sessionKey;
    const bSession = b.context.sessionKey;
    if (aSession !== undefined || bSession !== undefined) {
      return aSession !== undefined && aSession === bSession;
    }
    return sameLocation(a, b);
  }

  if (a.kind === "terminal_error" && b.kind === "terminal_error") {
    // A cwd alone is not an occurrence id: two shells can fail independently
    // in the same repository. The terminal app+window identifies the stream.
    return sameLocation(a, b);
  }

  // Terminal and agent channels name different foreground apps. Correlate them
  // only with an explicit shared workspace/command, never merely because they
  // happened within the same 30-second wall-clock window.
  return commandConnects(a, b) || (sameCwd(a, b) && sameFailureText(a, b));
}

function hitsCompatible(a: ErrorHit, b: ErrorHit): boolean {
  const aStructured = a.kind !== "frame_error";
  const bStructured = b.kind !== "frame_error";
  if (aStructured && bStructured) return structuredCompatible(a, b);

  // OCR may corroborate a structured signal across apps only when it shows the
  // exact same failure line. Otherwise it must belong to the same visible app
  // and window. This prevents a noisy frame from bridging unrelated failures.
  return sameLocation(a, b) || sameFailureText(a, b);
}

function canJoinCluster(cluster: ErrorHit[], hit: ErrorHit): boolean {
  const structured = cluster.filter((candidate) => candidate.kind !== "frame_error");
  if (hit.kind !== "frame_error") {
    if (structured.some((candidate) => !structuredCompatible(candidate, hit))) {
      return false;
    }
    return cluster.some((candidate) => hitsCompatible(candidate, hit));
  }
  if (structured.length > 0) {
    return structured.some((candidate) => hitsCompatible(candidate, hit));
  }
  return cluster.some((candidate) => hitsCompatible(candidate, hit));
}

/** Best text source for describing the error, most structured channel first. */
const KIND_PRIORITY: ErrorSignalKind[] = [
  "terminal_error",
  "agent_tool_error",
  "frame_error",
];

function clusterToAction(ctx: RuleContext, cluster: ErrorHit[]): ActionEvent | undefined {
  // OCR is useful context, never proof. Dropping screen-only clusters here
  // prevents them from entering actions, questions, episodes, or memory.
  const anchor = KIND_PRIORITY
    .filter((kind) => kind !== "frame_error")
    .map((kind) => cluster.find((hit) => hit.kind === kind))
    .find((hit) => hit !== undefined);
  if (!anchor) return undefined;

  // One full-strength signal per channel; repeats of the same channel add only
  // a whisper (an error scrolling across five frames is still ONE sighting).
  const seen = new Map<ErrorSignalKind, number>();
  const signals: Signal[] = [];
  // The structured anchor MUST be first: mkAction content-addresses on the first
  // evidence id. Temporal OCR churn therefore cannot change this action's id.
  const ordered = [anchor, ...cluster.filter((hit) => hit !== anchor)];
  for (const h of ordered) {
    const n = seen.get(h.kind) ?? 0;
    if (n === 0) {
      signals.push({ id: h.event.id, p: h.p, tag: h.kind });
    } else if (n <= MAX_REPEATS) {
      signals.push({ id: h.event.id, p: P_REPEAT, tag: `more_${h.kind}` });
    }
    seen.set(h.kind, n + 1);
  }
  const scored = score(signals);

  const last = cluster[cluster.length - 1]!;
  const best = KIND_PRIORITY.map((k) => cluster.find((h) => h.kind === k)).find(
    (h) => h !== undefined,
  )!;
  const errorText = best.text.trim();
  const firstLine = matchedErrorLine(errorText)
    ?? errorText.split("\n").find((line) => line.trim().length > 0)
    ?? "";

  const kinds = [...new Set(cluster.map((h) => h.kind))];
  const uncertainty = scored.confidence < 0.6
    ? ["structured failure signal needs verification"]
    : undefined;

  return mkAction(ctx, {
    action: "encountered_error",
    app: anchor.event.app,
    window: anchor.event.window,
    startTs: anchor.event.ts,
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
  const clusters: ErrorHit[][] = [];
  for (const h of hits) {
    let target: ErrorHit[] | undefined;
    for (let index = clusters.length - 1; index >= 0; index -= 1) {
      const candidate = clusters[index]!;
      const last = candidate[candidate.length - 1]!;
      if (toMs(h.event.ts) - toMs(last.event.ts) > CLUSTER_GAP_MS) continue;
      if (canJoinCluster(candidate, h)) {
        target = candidate;
        break;
      }
    }
    if (target) target.push(h);
    else clusters.push([h]);
  }
  for (const cluster of clusters) {
    const action = clusterToAction(ctx, cluster);
    if (action) out.push(action);
  }
  return out;
}

export const errorRules: Rule[] = [encounteredError];
