import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawEvent } from "../src/core/types.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import { reconstructEvents } from "../src/reconstructor/reconstructor.ts";

const START = Date.parse("2026-07-13T12:00:00.000Z");

function nativeEvent(input: {
  id: string;
  seconds: number;
  source: RawEvent["source"];
  type: string;
  payload: Record<string, unknown>;
  app?: string;
  window?: string;
}): RawEvent {
  return {
    id: input.id,
    ts: new Date(START + input.seconds * 1000).toISOString(),
    source: input.source,
    app: input.app ?? "Claude",
    window: input.window ?? "Praxis architecture",
    type: input.type,
    payload: input.payload,
    blobRefs: [],
    hash: `hash-${input.id}`,
  };
}

function draft(id: string, seconds: number, value: string, window?: string): RawEvent {
  return nativeEvent({
    id,
    seconds,
    source: "accessibility",
    type: "focused_text_changed",
    payload: { role: "textfield", value },
    window,
  });
}

function enter(id: string, seconds: number, window?: string): RawEvent {
  return nativeEvent({
    id,
    seconds,
    source: "input_events",
    type: "key_down",
    payload: { key: "Enter", mods: [] },
    window,
  });
}

// This is the exact role-less payload shape emitted by ConversationScrape.swift.
function bubble(id: string, seconds: number, text: string, window?: string): RawEvent {
  return nativeEvent({
    id,
    seconds,
    source: "accessibility",
    type: "conversation_bubble_added",
    payload: { text },
    window,
  });
}

function reconstruct(events: RawEvent[]) {
  return reconstructEvents(events, { newId: makeSeededIdGen() });
}

test("native role-less bubbles reconstruct an answered assistant question", () => {
  const opening = "Help me decide how to roll out the capture service.";
  const question = "Should we ship now?";
  const answer = "Yes, start with the pilot team and watch the readiness status.";
  const actions = reconstruct([
    draft("opening-draft", 0, opening),
    enter("opening-enter", 1),
    bubble("opening-user", 1.2, opening),
    bubble("assistant-question", 4, question),
    draft("answer-draft", 7, answer),
    enter("answer-enter", 8),
    bubble("answer-user", 8.2, answer),
  ]);

  const answered = actions.filter((action) => action.action === "answered_question");
  assert.equal(answered.length, 1);
  assert.equal(answered[0]!.text, answer);
  assert.equal(answered[0]!.payload?.question, question);
  assert.ok(answered[0]!.evidence.includes("answer-draft"));
  assert.ok(answered[0]!.evidence.includes("answer-enter"));
  assert.ok(answered[0]!.evidence.includes("assistant-question"));
});

test("native role-less bubbles reconstruct a correction of an assistant turn", () => {
  const opening = "Update the release route using the current implementation.";
  const response = "I replaced the existing release route with a new endpoint.";
  const correction = "No, keep the existing route and add the validation separately.";
  const actions = reconstruct([
    draft("opening-draft", 0, opening),
    enter("opening-enter", 1),
    bubble("opening-user", 1.2, opening),
    bubble("assistant-response", 4, response),
    draft("correction-draft", 7, correction),
    enter("correction-enter", 8),
    bubble("correction-user", 8.2, correction),
  ]);

  const corrections = actions.filter((action) => action.action === "corrected_agent");
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0]!.text, correction);
  assert.ok(corrections[0]!.evidence.includes("correction-draft"));
  assert.ok(corrections[0]!.evidence.includes("correction-enter"));
  assert.ok(corrections[0]!.evidence.includes("assistant-response"));
});

test("role-less assistant inference requires an earlier confirmed user turn", () => {
  const question = "Should we ship this release to the pilot team first?";
  const answer = "Yes, ship it to the pilot team first.";
  const correction = "No, keep the existing route and change only the validation.";

  const answerActions = reconstruct([
    bubble("unanchored-question", 0, question),
    draft("answer-draft", 3, answer),
    enter("answer-enter", 4),
    bubble("answer-user", 4.2, answer),
  ]);
  assert.equal(
    answerActions.some((action) => action.action === "answered_question"),
    false,
  );

  const correctionActions = reconstruct([
    bubble(
      "unanchored-response",
      10,
      "I replaced the existing release route with a new endpoint.",
    ),
    draft("correction-draft", 13, correction),
    enter("correction-enter", 14),
    bubble("correction-user", 14.2, correction),
  ]);
  assert.equal(
    correctionActions.some((action) => action.action === "corrected_agent"),
    false,
  );
});

test("a prior role-less user question is never reclassified as an assistant question", () => {
  const userQuestion = "Should we ship this release to the pilot team first?";
  const followup = "Yes, that is still the rollout I prefer.";
  const actions = reconstruct([
    draft("question-draft", 0, userQuestion),
    enter("question-enter", 1),
    bubble("question-user", 1.2, userQuestion),
    draft("followup-draft", 4, followup),
    enter("followup-enter", 5),
    bubble("followup-user", 5.2, followup),
  ]);

  assert.equal(
    actions.some((action) => action.action === "answered_question"),
    false,
  );
});

test("native role-less turns never correlate across windows", () => {
  const opening = "Help me decide how to roll out the capture service.";
  const question = "Should we ship the capture service to the pilot team first?";
  const correction = "No, keep the existing route and change only the validation.";
  const actions = reconstruct([
    draft("window-a-draft", 0, opening, "Project A"),
    enter("window-a-enter", 1, "Project A"),
    bubble("window-a-user", 1.2, opening, "Project A"),
    bubble("window-a-question", 4, question, "Project A"),
    draft("window-b-draft", 7, correction, "Project B"),
    enter("window-b-enter", 8, "Project B"),
    bubble("window-b-user", 8.2, correction, "Project B"),
  ]);

  assert.equal(
    actions.some(
      (action) =>
        action.action === "answered_question" || action.action === "corrected_agent",
    ),
    false,
  );
});

test("a role-less current bubble needs both matching draft and Enter evidence", () => {
  const opening = "Help me decide how to roll out the capture service.";
  const question = "Should we ship the capture service to the pilot team first?";
  const actions = reconstruct([
    draft("opening-draft", 0, opening),
    enter("opening-enter", 1),
    bubble("opening-user", 1.2, opening),
    bubble("assistant-question", 4, question),
    bubble("unproven-answer", 7, "Yes, ship it to the pilot team first."),
  ]);

  assert.equal(
    actions.some((action) => action.action === "answered_question"),
    false,
  );
});
