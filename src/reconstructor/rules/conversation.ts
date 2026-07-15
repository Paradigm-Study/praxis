import type { ActionEvent, RawEvent } from "../../core/types.ts";
import type { RuleContext } from "../evidence.ts";
import { after, before, payloadText } from "../evidence.ts";
import { P, score, type Signal } from "../confidence.ts";
import { mkAction } from "../rule.ts";
import { isExplicitCorrectionText } from "../correctionText.ts";

function role(e: RawEvent): string | undefined {
  const r = (e.payload as Record<string, unknown>).role;
  return typeof r === "string" ? r.trim().toLowerCase() : undefined;
}

const CONVERSATION_CONTEXT_KEYS = [
  "sessionKey",
  "sessionId",
  "conversationId",
  "threadId",
] as const;

function conversationContextId(e: RawEvent): string | undefined {
  const payload = e.payload as Record<string, unknown>;
  for (const key of CONVERSATION_CONTEXT_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return `${key}:${value}`;
  }
  return undefined;
}

/**
 * AX bubbles have no global identity. Pair them only inside one visible chat
 * context: the same app plus either an explicit matching conversation/session
 * id or the exact same window. This deliberately refuses one-sided ids rather
 * than borrowing a nearby response from another tab/session.
 */
function sameConversationContext(a: RawEvent, b: RawEvent): boolean {
  if (a.app !== b.app) return false;
  const aContext = conversationContextId(a);
  const bContext = conversationContextId(b);
  if (aContext !== undefined || bContext !== undefined) {
    return aContext !== undefined && aContext === bContext;
  }
  return a.window === b.window;
}

// Empty chat composers expose their placeholder as the AX value, which would
// otherwise be reconstructed as if the user typed it. Treat these as "no draft".
const PLACEHOLDER_RE =
  /^(type \/? ?for commands|reply to |message (claude|chatgpt|gemini|copilot|cursor|slack|discord)\b|ask (claude|chatgpt|cursor|copilot|gemini|anything)\b|send a message|type a message|write a (message|reply)|how can i help|what (can i|are you working)|start a new|search|jump to|add a comment)/i;

function isPlaceholder(text: string | undefined): boolean {
  if (!text) return true;
  const t = text.trim();
  return t.length === 0 || PLACEHOLDER_RE.test(t);
}

function isConversationBubble(e: RawEvent): boolean {
  return e.source === "accessibility" && e.type === "conversation_bubble_added";
}

function isRolelessBubble(e: RawEvent): boolean {
  const value = role(e);
  return value === undefined || value === "unknown";
}

function normalizedConversationText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

/**
 * Native AX capture cannot label bubble ownership. A role-less bubble is the
 * user's only when it echoes a real draft and follows that draft's Enter in the
 * exact same conversation context. Enter alone is deliberately insufficient:
 * a fast assistant response can also arrive shortly after it.
 */
interface UserBubbleInference {
  explicit: boolean;
  draft?: RawEvent;
  enter?: RawEvent;
}

function inferUserBubble(
  ctx: RuleContext,
  bubble: RawEvent,
  bubbleIndex: number,
): UserBubbleInference | undefined {
  if (!isConversationBubble(bubble)) return undefined;
  const bubbleRole = role(bubble);
  if (bubbleRole === "user") return { explicit: true };
  if (!isRolelessBubble(bubble)) return undefined;

  const bubbleText = normalizedConversationText(payloadText(ctx, bubble));
  if (!bubbleText || isPlaceholder(bubbleText)) return undefined;

  const bubbleMs = ctx.ms[bubbleIndex]!;
  let draft: RawEvent | undefined;
  let draftIndex = -1;
  for (let j = bubbleIndex - 1; j >= 0; j--) {
    if (bubbleMs - ctx.ms[j]! > 12_000) break;
    const candidate = ctx.events[j]!;
    if (
      candidate.source !== "accessibility" ||
      candidate.type !== "focused_text_changed" ||
      !sameConversationContext(bubble, candidate)
    ) {
      continue;
    }
    const draftText = normalizedConversationText(payloadText(ctx, candidate));
    if (!draftText || isPlaceholder(draftText) || draftText !== bubbleText) continue;
    draft = candidate;
    draftIndex = j;
    break;
  }
  if (!draft) return undefined;

  for (let j = bubbleIndex - 1; j > draftIndex; j--) {
    const candidate = ctx.events[j]!;
    if (bubbleMs - ctx.ms[j]! > 4_000) break;
    if (
      candidate.source === "input_events" &&
      candidate.type === "key_down" &&
      (candidate.payload as Record<string, unknown>).key === "Enter" &&
      !(((candidate.payload as Record<string, unknown>).mods as string[] | undefined) ?? []).includes("shift") &&
      sameConversationContext(bubble, candidate)
    ) {
      return { explicit: false, draft, enter: candidate };
    }
  }
  return undefined;
}

function userInferenceSignals(
  bubble: RawEvent,
  inference: UserBubbleInference,
  tag: string,
): Signal[] {
  const signals: Signal[] = [{ id: bubble.id, p: P.userBubble, tag }];
  if (inference.draft) {
    signals.push({ id: inference.draft.id, p: P.draftText, tag: "matching_draft" });
  }
  if (inference.enter) {
    signals.push({ id: inference.enter.id, p: P.enterKey, tag: "submit_enter" });
  }
  return signals;
}

/**
 * Enter pressed + a draft in the focused text field + a new user bubble +
 * (optionally) a matching AI request => `submitted_message`. This is the
 * worked example from the design doc; confidence climbs as signals corroborate.
 */
export function submittedMessage(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e, i) => {
    if (e.source !== "input_events" || e.type !== "key_down") return;
    const key = (e.payload as Record<string, unknown>).key;
    const mods = ((e.payload as Record<string, unknown>).mods as string[]) ?? [];
    if (key !== "Enter" || mods.includes("shift")) return;

    const draft = before(ctx, i, 6000, {
      source: "accessibility",
      type: "focused_text_changed",
      app: e.app,
      where: (ev) =>
        sameConversationContext(e, ev) && !isPlaceholder(payloadText(ctx, ev)),
    });
    const bubble = after(ctx, i, 4000, {
      source: "accessibility",
      type: "conversation_bubble_added",
      app: e.app,
      where: (ev) =>
        sameConversationContext(e, ev) &&
        inferUserBubble(ctx, ev, ctx.events.indexOf(ev)) !== undefined,
    });
    const request = after(ctx, i, 4000, {
      source: "ai_proxy",
      type: "ai_request",
      app: e.app,
    });
    const screen = before(ctx, i, 4000, {
      source: "screen_video",
      type: "frame",
      app: e.app,
    });

    // Not a message submit if there's no draft and no resulting bubble/request.
    if (!draft && !bubble && !request) return;

    const text = bubble
      ? payloadText(ctx, bubble)
      : draft
        ? payloadText(ctx, draft)
        : undefined;

    const signals: Signal[] = [{ id: e.id, p: P.enterKey, tag: "enter" }];
    if (draft) signals.push({ id: draft.id, p: P.draftText, tag: "draft" });
    if (bubble) signals.push({ id: bubble.id, p: P.userBubble, tag: "user_bubble" });
    if (request) signals.push({ id: request.id, p: P.aiRequest, tag: "ai_request" });
    if (screen) {
      // A frame whose OCR text actually contains the draft is strong proof the
      // message was on screen; a bare frame is only weak corroboration.
      const ocr = ((screen.payload as Record<string, unknown>).ocrText as string) ?? "";
      const draftText = draft ? payloadText(ctx, draft) : undefined;
      const ocrMatch =
        !!draftText && ocr.toLowerCase().includes(draftText.toLowerCase().slice(0, 24));
      signals.push({
        id: screen.id,
        p: ocrMatch ? P.screenOcrMatch : P.screenMatch,
        tag: ocrMatch ? "screen_ocr_match" : "screen",
      });
    }

    const uncertainty =
      !bubble && !request
        ? ["no conversation bubble or AI request seen; inferred from Enter + draft"]
        : undefined;

    out.push(
      mkAction(ctx, {
        action: "submitted_message",
        app: e.app,
        window: e.window,
        startTs: (draft ?? e).ts,
        endTs: (bubble ?? request ?? e).ts,
        text,
        scored: score(signals),
        uncertainty,
        reconstructedBy: "submittedMessage",
      }),
    );
  });
  return out;
}

/** Runs of text-field changes => `typed_draft` (composing). */
export function typedDraft(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  const edits = ctx.events.filter(
    (e) =>
      e.source === "accessibility" &&
      e.type === "focused_text_changed" &&
      !isPlaceholder(payloadText(ctx, e)), // drop empty-composer placeholders
  );
  let run: RawEvent[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const signals: Signal[] = run.map((ev, idx) => ({
      id: ev.id,
      p: idx === 0 ? P.draftText + 0.1 : 0.2,
      tag: "keystroke",
    }));
    out.push(
      mkAction(ctx, {
        action: "typed_draft",
        app: first.app,
        window: first.window,
        startTs: first.ts,
        endTs: last.ts,
        text: payloadText(ctx, last),
        scored: score(signals),
        payload: { keystrokes: run.length },
        reconstructedBy: "typedDraft",
      }),
    );
    run = [];
  };
  for (let k = 0; k < edits.length; k++) {
    const e = edits[k]!;
    const prev = run[run.length - 1];
    const sameTarget =
      !prev ||
      (prev.app === e.app &&
        (prev.payload as Record<string, unknown>).element ===
          (e.payload as Record<string, unknown>).element);
    const closeInTime = !prev || Date.parse(e.ts) - Date.parse(prev.ts) < 5000;
    if (prev && (!sameTarget || !closeInTime)) flush();
    run.push(e);
  }
  flush();
  return out;
}

interface AssistantTurnInference {
  event: RawEvent;
  /** The confirmed preceding user turn that makes a role-less AX reply safe. */
  priorUser?: RawEvent;
}

function looksLikeSubstantiveAssistantText(ctx: RuleContext, event: RawEvent): boolean {
  const text = normalizedConversationText(payloadText(ctx, event));
  if (!text || isPlaceholder(text)) return false;
  const words = text.split(" ").filter(Boolean).length;
  // A direct question supplies its own strong conversational cue; ordinary
  // response prose must be longer to avoid treating newly-rendered UI labels
  // as assistant turns.
  if (endsWithQuestion(text)) return text.length >= 12 && words >= 3;
  return text.length >= 24 && words >= 4;
}

function priorStrongUserTurn(
  ctx: RuleContext,
  candidate: RawEvent,
  candidateIndex: number,
): RawEvent | undefined {
  const candidateMs = ctx.ms[candidateIndex]!;
  for (let j = candidateIndex - 1; j >= 0; j--) {
    if (candidateMs - ctx.ms[j]! > 120_000) break;
    const event = ctx.events[j]!;
    if (!sameConversationContext(candidate, event) || !isConversationBubble(event)) {
      continue;
    }
    if (inferUserBubble(ctx, event, j)) return event;
  }
  return undefined;
}

/**
 * Resolve only the immediately preceding assistant turn. Explicitly-labelled
 * assistant/AI-proxy events keep their source semantics. A native role-less AX
 * bubble additionally needs substantial prose, a confirmed prior submitted
 * user bubble, response-like ordering, and the exact same chat context.
 */
function priorAssistantTurn(
  ctx: RuleContext,
  currentUser: RawEvent,
  currentIndex: number,
  currentInference: UserBubbleInference,
  withinMs: number,
): AssistantTurnInference | undefined {
  const currentMs = ctx.ms[currentIndex]!;
  const currentDraftMs = currentInference.draft
    ? Date.parse(currentInference.draft.ts)
    : undefined;

  for (let j = currentIndex - 1; j >= 0; j--) {
    if (currentMs - ctx.ms[j]! > withinMs) break;
    const event = ctx.events[j]!;
    if (!sameConversationContext(currentUser, event)) continue;

    if (event.source === "ai_proxy" && event.type === "ai_response") {
      return { event };
    }
    if (!isConversationBubble(event)) continue;

    // Never step past an intervening user turn to borrow an older response.
    if (inferUserBubble(ctx, event, j)) return undefined;

    const eventRole = role(event);
    if (eventRole === "assistant" || eventRole === "teacher") return { event };
    if (!isRolelessBubble(event) || !looksLikeSubstantiveAssistantText(ctx, event)) {
      continue;
    }

    // A response arriving after the next draft began is not safely attributable
    // as the turn that draft answers or corrects.
    if (currentDraftMs !== undefined && ctx.ms[j]! >= currentDraftMs) continue;

    const priorUser = priorStrongUserTurn(ctx, event, j);
    if (!priorUser) continue;
    const responseDelay = ctx.ms[j]! - Date.parse(priorUser.ts);
    if (responseDelay < 500 || responseDelay > 120_000) continue;
    return { event, priorUser };
  }
  return undefined;
}

function endsWithQuestion(text: string): boolean {
  return /\?\s*["'\u2019)\]}]*$/.test(text.trim());
}

/** A user message that follows an assistant message ending in "?". */
export function answeredQuestion(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e, i) => {
    const user = inferUserBubble(ctx, e, i);
    if (!user) return;
    const question = priorAssistantTurn(ctx, e, i, user, 120_000);
    const qText = question ? payloadText(ctx, question.event) : undefined;
    if (!question || !qText || !endsWithQuestion(qText)) return;

    const signals = userInferenceSignals(e, user, "user_answer");
    signals.push({ id: question.event.id, p: 0.6, tag: "prior_question" });
    if (question.priorUser) {
      signals.push({ id: question.priorUser.id, p: 0.25, tag: "roleless_reply_order" });
    }

    out.push(
      mkAction(ctx, {
        action: "answered_question",
        app: e.app,
        window: e.window,
        startTs: question.event.ts,
        endTs: e.ts,
        text: payloadText(ctx, e),
        scored: score(signals),
        payload: { question: qText },
        reconstructedBy: "answeredQuestion",
      }),
    );
  });
  return out;
}

function extractRejected(text: string): string | undefined {
  const m = text.match(
    /(?:don'?t|do not|avoid|instead of|rather than|not)\s+([^.;\n]+)/i,
  );
  if (!m) return undefined;
  return m[1]!
    .trim()
    .replace(/^(rely on|relying on|use|using|go with|pick|choose|do)\s+/i, "");
}

/** A corrective user message following an assistant turn => `corrected_agent`. */
export function correctedAgent(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e, i) => {
    const user = inferUserBubble(ctx, e, i);
    if (!user) return;
    const text = payloadText(ctx, e);
    if (!text || !isExplicitCorrectionText(text)) return;
    const prior = priorAssistantTurn(ctx, e, i, user, 180_000);
    if (!prior) return;

    const signals = userInferenceSignals(e, user, "corrective_message");
    signals.push({ id: prior.event.id, p: 0.5, tag: "prior_assistant" });
    if (prior.priorUser) {
      signals.push({ id: prior.priorUser.id, p: 0.25, tag: "roleless_reply_order" });
    }

    out.push(
      mkAction(ctx, {
        action: "corrected_agent",
        app: e.app,
        window: e.window,
        startTs: prior.event.ts,
        endTs: e.ts,
        text,
        scored: score(signals),
        payload: { rejects: extractRejected(text) },
        reconstructedBy: "correctedAgent",
      }),
    );
  });
  return out;
}

/** Assistant/teacher turn in a learner context => `taught_learner`. */
export function taughtLearner(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  const isLearner = (s: string) => /learner|student|tutor|teaching/i.test(s);
  ctx.events.forEach((e) => {
    const teaching =
      (e.source === "accessibility" &&
        e.type === "conversation_bubble_added" &&
        (role(e) === "assistant" || role(e) === "teacher")) ||
      (e.source === "ai_proxy" && e.type === "ai_response");
    if (!teaching) return;
    if (!isLearner(e.app) && !isLearner(e.window)) return;
    out.push(
      mkAction(ctx, {
        action: "taught_learner",
        app: e.app,
        window: e.window,
        startTs: e.ts,
        endTs: e.ts,
        text: payloadText(ctx, e),
        scored: score([{ id: e.id, p: 0.7, tag: "teaching_turn" }]),
        reconstructedBy: "taughtLearner",
      }),
    );
  });
  return out;
}

// Only treat assistant text as a response if this app is an active conversation
// (a recent Enter or real draft), so static page text isn't mistaken for replies.
function inConversation(ctx: RuleContext, i: number, bubble: RawEvent): boolean {
  const enter = before(ctx, i, 600_000, {
    source: "input_events",
    type: "key_down",
    app: bubble.app,
    where: (ev) =>
      sameConversationContext(bubble, ev) &&
      (ev.payload as Record<string, unknown>).key === "Enter",
  });
  if (enter) return true;
  return !!before(ctx, i, 600_000, {
    source: "accessibility",
    type: "focused_text_changed",
    app: bubble.app,
    where: (ev) =>
      sameConversationContext(bubble, ev) && !isPlaceholder(payloadText(ctx, ev)),
  });
}

/**
 * Assistant bubbles in an active conversation => `received_response`. Streaming
 * replies arrive as a growing run of bubbles; we group them and keep the final
 * (longest) text, so one reply = one action.
 */
export function receivedResponse(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  let run: RawEvent[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const first = run[0]!;
    const last = run[run.length - 1]!;
    out.push(
      mkAction(ctx, {
        action: "received_response",
        app: first.app,
        window: first.window,
        startTs: first.ts,
        endTs: last.ts,
        text: payloadText(ctx, last),
        scored: score(
          run.map((ev, idx) => ({
            id: ev.id,
            p: idx === 0 ? 0.6 : 0.15,
            tag: "assistant_bubble",
          })),
        ),
        payload: { role: "assistant", chunks: run.length },
        reconstructedBy: "receivedResponse",
      }),
    );
    run = [];
  };
  ctx.events.forEach((e, i) => {
    if (e.source !== "accessibility" || e.type !== "conversation_bubble_added") return;
    const text = payloadText(ctx, e);
    const assistant =
      !!text &&
      text.trim().length >= 24 &&
      !isPlaceholder(text) &&
      !inferUserBubble(ctx, e, i) &&
      inConversation(ctx, i, e);
    if (!assistant) {
      flush(); // a user turn (or non-reply) closes the assistant run
      return;
    }
    const prev = run[run.length - 1];
    if (
      prev &&
      (!sameConversationContext(prev, e) ||
        Date.parse(e.ts) - Date.parse(prev.ts) >= 30_000)
    ) {
      flush();
    }
    run.push(e);
  });
  flush();
  return out;
}

export const conversationRules = [
  submittedMessage,
  typedDraft,
  answeredQuestion,
  correctedAgent,
  taughtLearner,
  receivedResponse,
];
