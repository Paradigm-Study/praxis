import type { ActionEvent, RawEvent } from "../../core/types.ts";
import type { RuleContext } from "../evidence.ts";
import { after, before, payloadText } from "../evidence.ts";
import { P, score, type Signal } from "../confidence.ts";
import { mkAction } from "../rule.ts";

const CORRECTIVE =
  /\b(no|nope|don'?t|do not|instead|actually|that'?s wrong|not quite|stop|avoid|rather than|incorrect|wrong)\b/i;

function role(e: RawEvent): string | undefined {
  const r = (e.payload as Record<string, unknown>).role;
  return typeof r === "string" ? r : undefined;
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
      where: (ev) => !isPlaceholder(payloadText(ctx, ev)),
    });
    // The user's bubble: an explicit role:"user", OR — for the universal AX
    // scraper, which emits role-less bubbles — a bubble whose text matches the
    // draft. This is what makes submit reconstruction work for any chat app.
    const draftVal = draft ? payloadText(ctx, draft) : undefined;
    const bubble = after(ctx, i, 4000, {
      source: "accessibility",
      type: "conversation_bubble_added",
      app: e.app,
      where: (ev) => {
        const r = role(ev);
        if (r === "user") return true;
        if (r !== undefined && r !== "unknown") return false;
        const bt = payloadText(ctx, ev);
        return (
          !!draftVal && !!bt &&
          bt.toLowerCase().includes(draftVal.toLowerCase().slice(0, 24))
        );
      },
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

/** A user message that follows an assistant message ending in "?". */
export function answeredQuestion(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e, i) => {
    if (
      e.source !== "accessibility" ||
      e.type !== "conversation_bubble_added" ||
      role(e) !== "user"
    )
      return;
    const question =
      before(ctx, i, 120_000, {
        source: "accessibility",
        type: "conversation_bubble_added",
        where: (ev) => role(ev) === "assistant",
      }) ??
      before(ctx, i, 120_000, { source: "ai_proxy", type: "ai_response" });
    const qText = question ? payloadText(ctx, question) : undefined;
    if (!question || !qText || !qText.trim().endsWith("?")) return;

    out.push(
      mkAction(ctx, {
        action: "answered_question",
        app: e.app,
        window: e.window,
        startTs: question.ts,
        endTs: e.ts,
        text: payloadText(ctx, e),
        scored: score([
          { id: e.id, p: P.userBubble, tag: "user_answer" },
          { id: question.id, p: 0.6, tag: "prior_question" },
        ]),
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
    if (
      e.source !== "accessibility" ||
      e.type !== "conversation_bubble_added" ||
      role(e) !== "user"
    )
      return;
    const text = payloadText(ctx, e);
    if (!text || !CORRECTIVE.test(text)) return;
    const prior =
      before(ctx, i, 180_000, {
        source: "accessibility",
        type: "conversation_bubble_added",
        where: (ev) => role(ev) === "assistant",
      }) ?? before(ctx, i, 180_000, { source: "ai_proxy", type: "ai_response" });
    if (!prior) return;

    out.push(
      mkAction(ctx, {
        action: "corrected_agent",
        app: e.app,
        window: e.window,
        startTs: prior.ts,
        endTs: e.ts,
        text,
        scored: score([
          { id: e.id, p: P.userBubble, tag: "corrective_message" },
          { id: prior.id, p: 0.5, tag: "prior_assistant" },
        ]),
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

// Is this bubble the user's own message (vs. the assistant's reply)?
function isUserBubble(ctx: RuleContext, bubble: RawEvent, i: number): boolean {
  if (role(bubble) === "user") return true;
  const bt = (payloadText(ctx, bubble) ?? "").toLowerCase();
  if (!bt) return false;
  const draft = before(ctx, i, 12_000, {
    source: "accessibility",
    type: "focused_text_changed",
    app: bubble.app,
    where: (ev) => !isPlaceholder(payloadText(ctx, ev)),
  });
  const dv = draft ? (payloadText(ctx, draft) ?? "").toLowerCase() : "";
  if (dv && bt.includes(dv.slice(0, 24))) return true; // user's typed text echoed
  // Fallback only for the bubble *immediately* after Enter (the echoed submit);
  // a reply arriving a couple seconds later is the assistant, not the user.
  return !!before(ctx, i, 2000, {
    source: "input_events",
    type: "key_down",
    app: bubble.app,
    where: (ev) => (ev.payload as Record<string, unknown>).key === "Enter",
  });
}

// Only treat assistant text as a response if this app is an active conversation
// (a recent Enter or real draft), so static page text isn't mistaken for replies.
function inConversation(ctx: RuleContext, i: number, app: string): boolean {
  const enter = before(ctx, i, 600_000, {
    source: "input_events",
    type: "key_down",
    app,
    where: (ev) => (ev.payload as Record<string, unknown>).key === "Enter",
  });
  if (enter) return true;
  return !!before(ctx, i, 600_000, {
    source: "accessibility",
    type: "focused_text_changed",
    app,
    where: (ev) => !isPlaceholder(payloadText(ctx, ev)),
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
      !isUserBubble(ctx, e, i) &&
      inConversation(ctx, i, e.app);
    if (!assistant) {
      flush(); // a user turn (or non-reply) closes the assistant run
      return;
    }
    const prev = run[run.length - 1];
    if (prev && (prev.app !== e.app || Date.parse(e.ts) - Date.parse(prev.ts) >= 30_000)) {
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
