import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructEvents } from "../src/reconstructor/reconstructor.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import type { ActionEvent, EventSource, RawEvent } from "../src/core/types.ts";

const T0 = Date.parse("2026-06-08T12:00:00.000Z");
let n = 0;

function ev(
  offsetSec: number,
  source: EventSource,
  type: string,
  payload: Record<string, unknown>,
  blobRefs: string[] = [],
  app = "iTerm2",
): RawEvent {
  const id = `e${++n}`;
  return {
    id,
    ts: new Date(T0 + offsetSec * 1000).toISOString(),
    source,
    app,
    window: app,
    type,
    payload,
    blobRefs,
    hash: `h${id}`,
  };
}

function errors(actions: ActionEvent[]): ActionEvent[] {
  return actions.filter((a) => a.action === "encountered_error");
}

test("terminal stack trace + agent tool error corroborate to >= 0.6", () => {
  const events = [
    ev(0, "terminal", "command_run", {
      cmd: "npm test",
      exitCode: 1,
      output: "Error: boom\n    at run (src/foo.ts:12:5)\n    at main (src/cli.ts:3:1)",
    }),
    ev(5, "ai_proxy", "tool_result", {
      is_error: true,
      content: "Command failed with exit code 1: npm test",
      sessionKey: "sess-1",
    }),
  ];
  const found = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.equal(found.length, 1, "one clustered encountered_error");
  const a = found[0]!;
  assert.ok(a.confidence >= 0.6, `corroborated confidence ${a.confidence} >= 0.6`);
  assert.equal(a.evidence.length, 2, "evidence spans both channels");
  assert.match(String(a.payload?.errorText), /boom/);
  assert.ok(!a.uncertainty, "corroborated error carries no uncertainty note");
});

test("a lone OCR error frame stays weak (< 0.6) with honest uncertainty", () => {
  const events = [
    ev(0, "screen_video", "frame", {
      ocrText: "TypeError: cannot read properties of undefined",
    }, [], "Cursor"),
  ];
  const found = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.equal(found.length, 1);
  const a = found[0]!;
  assert.ok(a.confidence < 0.6, `lone signal stays weak: ${a.confidence}`);
  assert.ok(a.uncertainty?.length, "carries an uncertainty note");
});

test("repeated frames of the same error do not corroborate past 0.6", () => {
  const events = [0, 5, 10, 15, 20].map((s) =>
    ev(s, "screen_video", "frame", { ocrText: "Error: boom at startup" }, [], "Cursor"),
  );
  const found = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.equal(found.length, 1, "one sighting, not five");
  assert.ok(found[0]!.confidence < 0.6, `repeats stay weak: ${found[0]!.confidence}`);
});

test("error keyword without a stack-frame-like line does not fire", () => {
  const events = [
    ev(0, "terminal", "command_run", {
      cmd: "npm test",
      exitCode: 0,
      output: "0 failed, 73 passed",
    }),
  ];
  assert.equal(errors(reconstructEvents(events, { newId: makeSeededIdGen() })).length, 0);
});

test("agent tool_result without is_error does not fire", () => {
  const events = [
    ev(0, "ai_proxy", "tool_result", {
      is_error: false,
      content: "grep found: error handling docs",
    }),
  ];
  assert.equal(errors(reconstructEvents(events, { newId: makeSeededIdGen() })).length, 0);
});

test("terminal output offloaded to a blob is resolved via ctx.blob", () => {
  const blobText =
    'Traceback (most recent call last):\n  File "app.py", line 3, in <module>\nZeroDivisionError: division by zero';
  const events = [
    ev(0, "terminal", "command_run", { cmd: "python app.py", exitCode: 1 }, ["blob1"]),
  ];
  const found = errors(
    reconstructEvents(events, {
      newId: makeSeededIdGen(),
      blob: (h) => (h === "blob1" ? blobText : undefined),
    }),
  );
  assert.equal(found.length, 1);
  assert.match(String(found[0]!.payload?.errorText), /ZeroDivisionError/);
});

test("signals far apart split into separate error occurrences", () => {
  const events = [
    ev(0, "screen_video", "frame", { ocrText: "Error: first failure" }, [], "Cursor"),
    ev(300, "screen_video", "frame", { ocrText: "Error: much later failure" }, [], "Cursor"),
  ];
  const found = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.equal(found.length, 2, "a 5-minute gap is a new occurrence");
});

test("reconstruction is idempotent — same evidence, same action ids", () => {
  const events = [
    ev(0, "terminal", "command_run", {
      cmd: "npm test",
      output: "Error: boom\n    at run (src/foo.ts:12:5)",
    }),
    ev(4, "ai_proxy", "tool_result", { is_error: true, content: "npm test failed" }),
  ];
  const a = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  const b = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.deepEqual(
    a.map((x) => x.id),
    b.map((x) => x.id),
  );
});
