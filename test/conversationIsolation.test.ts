import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawEvent } from "../src/core/types.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import { reconstructEvents } from "../src/reconstructor/reconstructor.ts";

const T0 = Date.parse("2026-07-10T12:00:00.000Z");

function bubble(
  id: string,
  offsetSeconds: number,
  role: "assistant" | "user",
  text: string,
  app: string,
  window: string,
  context: Record<string, unknown> = {},
): RawEvent {
  return {
    id,
    ts: new Date(T0 + offsetSeconds * 1000).toISOString(),
    source: "accessibility",
    app,
    window,
    type: "conversation_bubble_added",
    payload: { role, text, ...context },
    blobRefs: [],
    hash: `hash-${id}`,
  };
}

function actions(events: RawEvent[], action: string) {
  return reconstructEvents(events, { newId: makeSeededIdGen() })
    .filter((candidate) => candidate.action === action);
}

test("AX answers never borrow questions from another app or window", () => {
  const crossApp = [
    bubble("slack-question", 0, "assistant", "Should we deploy the API now?", "Slack", "#release"),
    bubble("claude-answer", 1, "user", "Yes, deploy it.", "Claude", "Acme API"),
  ];
  assert.equal(actions(crossApp, "answered_question").length, 0);

  const crossWindow = [
    bubble("project-a-question", 10, "assistant", "Should I replace the route?", "Claude", "Project A"),
    bubble("project-b-answer", 11, "user", "No, keep it.", "Claude", "Project B"),
  ];
  assert.equal(actions(crossWindow, "answered_question").length, 0);
});

test("AX corrections stay inside the same app, window, and conversation id", () => {
  const crossWindow = [
    bubble("window-a-response", 0, "assistant", "I will replace the existing route.", "Claude", "Project A"),
    bubble("window-b-correction", 1, "user", "No, keep the existing route.", "Claude", "Project B"),
  ];
  assert.equal(actions(crossWindow, "corrected_agent").length, 0);

  const crossSession = [
    bubble(
      "session-a-response",
      10,
      "assistant",
      "I will replace the existing route.",
      "Claude",
      "Project",
      { conversationId: "conversation-a" },
    ),
    bubble(
      "session-b-correction",
      11,
      "user",
      "No, keep the existing route.",
      "Claude",
      "Project",
      { conversationId: "conversation-b" },
    ),
  ];
  assert.equal(actions(crossSession, "corrected_agent").length, 0);
});

test("AX question and correction pairs still reconstruct in one context", () => {
  const events = [
    bubble(
      "same-question",
      0,
      "assistant",
      "Should I replace the existing route?",
      "Claude",
      "Project before rename",
      { conversationId: "conversation-a" },
    ),
    bubble(
      "same-correction",
      1,
      "user",
      "No, keep the existing route.",
      "Claude",
      "Project after rename",
      { conversationId: "conversation-a" },
    ),
  ];
  assert.equal(actions(events, "answered_question").length, 1);
  assert.equal(actions(events, "corrected_agent").length, 1);
});
