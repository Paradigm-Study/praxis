import { test } from "node:test";
import assert from "node:assert/strict";
import { fullPipeline } from "./helpers.ts";
import { reconstructEvents } from "../src/reconstructor/reconstructor.ts";
import { score } from "../src/reconstructor/confidence.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import type { RawEvent } from "../src/core/types.ts";

test("confidence counts each raw event as one independent signal", () => {
  const scored = score([
    { id: "raw_file", p: 0.9, tag: "file_changed" },
    { id: "raw_file", p: 0.4, tag: "diff" },
    { id: "raw_save", p: 0.6, tag: "cmd_s" },
  ]);

  assert.equal(scored.confidence, 0.96);
  assert.deepEqual(scored.evidence, ["raw_file", "raw_save"]);
  assert.deepEqual(scored.signals, ["file_changed", "cmd_s"]);
});

test("universal AX scraper: role-less bubble still reconstructs the submit", () => {
  const text = "what is the firehose architecture";
  const mk = (o: Partial<RawEvent> & { id: string; ts: string; type: string; source: RawEvent["source"]; payload: Record<string, unknown> }): RawEvent => ({
    app: "ChatGPT", window: "ChatGPT", blobRefs: [], hash: "h" + o.id, ...o,
  });
  const events: RawEvent[] = [
    mk({ id: "d", ts: "2026-06-08T12:00:00.000Z", source: "accessibility", type: "focused_text_changed", payload: { role: "textfield", value: text } }),
    mk({ id: "k", ts: "2026-06-08T12:00:01.000Z", source: "input_events", type: "key_down", payload: { key: "Enter", mods: [] } }),
    // generic scraper emits the bubble with NO role:
    mk({ id: "b", ts: "2026-06-08T12:00:01.300Z", source: "accessibility", type: "conversation_bubble_added", payload: { text } }),
  ];
  const actions = reconstructEvents(events, { newId: makeSeededIdGen() });
  const submit = actions.find((a) => a.action === "submitted_message");
  assert.ok(submit, "expected a submitted_message from a role-less bubble");
  assert.equal(submit!.text, text);
  assert.ok(submit!.evidence.length >= 2, "bubble should corroborate the submit");
});

test("OCR screen-match strengthens submitted_message confidence", () => {
  const draft = "please reconstruct exact actions from the ledger";
  const mk = (o: Partial<RawEvent> & { id: string; ts: string; type: string; source: RawEvent["source"] }): RawEvent => ({
    app: "Codex", window: "Codex", payload: {}, blobRefs: [], hash: "h" + o.id, ...o,
  });
  const base: RawEvent[] = [
    mk({ id: "d", ts: "2026-06-08T12:00:00.000Z", source: "accessibility", type: "focused_text_changed", payload: { role: "textfield", value: draft } }),
    mk({ id: "k", ts: "2026-06-08T12:00:01.000Z", source: "input_events", type: "key_down", payload: { key: "Enter", mods: [] } }),
  ];
  const frame = (id: string, ocrText: string): RawEvent =>
    mk({ id, ts: "2026-06-08T12:00:00.500Z", source: "screen_video", type: "frame", payload: { ocrText }, blobRefs: ["b"] });

  const conf = (evs: RawEvent[]) =>
    reconstructEvents(evs, { newId: makeSeededIdGen() }).find((a) => a.action === "submitted_message")!.confidence;

  const noFrame = conf(base);
  const mismatch = conf([...base, frame("f1", "totally unrelated text")]);
  const match = conf([...base, frame("f2", "header " + draft + " footer")]);

  assert.ok(match > mismatch, `OCR match (${match}) should beat bare frame (${mismatch})`);
  assert.ok(mismatch >= noFrame);
});

test("every action is evidence-backed with confidence in [0,1]", async () => {
  const { actions } = await fullPipeline();
  assert.ok(actions.length >= 20);
  for (const a of actions) {
    assert.ok(a.confidence >= 0 && a.confidence <= 1, `conf ${a.action}`);
    assert.ok(a.evidence.length >= 1, `evidence ${a.action}`);
    assert.equal(
      new Set(a.evidence).size,
      a.evidence.length,
      `duplicate evidence ${a.action}`,
    );
    assert.equal(a.type, "user_action");
  }
});

test("submitted_message: strong corroboration → high confidence, >=3 evidence", async () => {
  const { actions } = await fullPipeline();
  const submits = actions.filter((a) => a.action === "submitted_message");
  assert.ok(submits.length >= 2);
  const strong = submits[0]!;
  assert.ok(strong.confidence >= 0.95, `expected >=0.95, got ${strong.confidence}`);
  assert.ok(strong.evidence.length >= 3);
});

test("weak evidence → weak action with explicit uncertainty", async () => {
  const { actions } = await fullPipeline();
  const weak = actions.find((a) => a.action.startsWith("possibly_reading"));
  assert.ok(weak, "expected a possibly_reading_* action");
  assert.ok(weak!.confidence < 0.6);
  assert.ok(weak!.uncertainty && weak!.uncertainty.length > 0);
  assert.match(weak!.uncertainty![0]!, /no AX text/i);
});

test("failure cycle: ran_command, inspected_failure, retried all present", async () => {
  const { actions } = await fullPipeline();
  const types = new Set(actions.map((a) => a.action));
  for (const t of ["ran_command", "inspected_failure", "retried", "committed"]) {
    assert.ok(types.has(t), `missing ${t}`);
  }
  const retry = actions.find((a) => a.action === "retried");
  assert.equal(retry!.payload!.previousExitCode, 1);
});

test("corrected_agent extracts the rejected path 'video-only inference'", async () => {
  const { actions } = await fullPipeline();
  const corr = actions.find((a) => a.action === "corrected_agent");
  assert.ok(corr);
  assert.equal(corr!.payload!.rejects, "video-only inference");
});

test("reconstructs at least 15 distinct action types across the session", async () => {
  const { actions } = await fullPipeline();
  const kinds = new Set(
    actions.map((a) => a.action.replace(/possibly_reading_.*/, "possibly_reading")),
  );
  assert.ok(kinds.size >= 15, `only ${kinds.size} distinct types`);
});

test("placeholder composer text is NOT reconstructed as typing", () => {
  const mk = (o: Partial<RawEvent> & { id: string; ts: string; type: string; source: RawEvent["source"]; payload: Record<string, unknown> }): RawEvent => ({
    app: "Claude", window: "Claude", blobRefs: [], hash: "h" + o.id, ...o,
  });
  const events: RawEvent[] = [
    mk({ id: "p1", ts: "2026-06-10T12:00:00.000Z", source: "accessibility", type: "focused_text_changed", payload: { role: "textfield", value: "Type / for commands" } }),
    mk({ id: "p2", ts: "2026-06-10T12:00:02.000Z", source: "accessibility", type: "focused_text_changed", payload: { role: "textfield", value: "Reply to Claude…" } }),
  ];
  const drafts = reconstructEvents(events, { newId: makeSeededIdGen() }).filter((a) => a.action === "typed_draft");
  assert.equal(drafts.length, 0, "placeholders must not become typed_draft");
});

test("assistant reply reconstructs as received_response (not as the user's message)", () => {
  const mk = (o: Partial<RawEvent> & { id: string; ts: string; type: string; source: RawEvent["source"]; payload: Record<string, unknown> }): RawEvent => ({
    app: "Claude", window: "Claude", blobRefs: [], hash: "h" + o.id, ...o,
  });
  const userText = "explain the firehose architecture in detail please";
  const events: RawEvent[] = [
    mk({ id: "d", ts: "2026-06-10T12:00:00.000Z", source: "accessibility", type: "focused_text_changed", payload: { role: "textfield", value: userText } }),
    mk({ id: "k", ts: "2026-06-10T12:00:01.000Z", source: "input_events", type: "key_down", payload: { key: "Enter", mods: [] } }),
    mk({ id: "ub", ts: "2026-06-10T12:00:01.300Z", source: "accessibility", type: "conversation_bubble_added", payload: { text: userText } }),
    mk({ id: "ab", ts: "2026-06-10T12:00:04.000Z", source: "accessibility", type: "conversation_bubble_added", payload: { text: "The firehose captures raw OS events through broad taps and writes a normalized ledger." } }),
  ];
  const actions = reconstructEvents(events, { newId: makeSeededIdGen() });
  const resp = actions.filter((a) => a.action === "received_response");
  assert.equal(resp.length, 1, "exactly one assistant response");
  assert.match(resp[0]!.text!, /firehose captures raw OS events/);
  assert.ok(!resp.some((a) => a.text === userText), "the user's own message must not be a response");
});
