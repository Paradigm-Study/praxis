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

test("a lone OCR error frame never becomes an encountered_error", () => {
  const events = [
    ev(0, "screen_video", "frame", {
      ocrText: "TypeError: cannot read properties of undefined",
    }, [], "Cursor"),
  ];
  const found = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.equal(found.length, 0);
});

test("repeated frames of the same error remain screen-only noise", () => {
  const events = [0, 5, 10, 15, 20].map((s) =>
    ev(s, "screen_video", "frame", { ocrText: "Error: boom at startup" }, [], "Cursor"),
  );
  const found = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.equal(found.length, 0);
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

test("a Claude tool error recovered in the same user turn is execution noise", () => {
  const events = [
    ev(0, "ai_proxy", "ai_request", {
      role: "user",
      preview: "Fix the route.",
      sessionKey: "sess-recovered",
    }, [], "Claude Code"),
    ev(1, "ai_proxy", "ai_request", {
      role: "tool_result",
      type: "tool_result",
      is_error: true,
      preview: "No such file: src/route.ts",
      sessionKey: "sess-recovered",
      toolUseId: "tool-failed",
    }, [], "Claude Code"),
    ev(2, "ai_proxy", "ai_response", {
      role: "assistant",
      tool: "Edit",
      toolUseId: "tool-retry",
      sessionKey: "sess-recovered",
    }, [], "Claude Code"),
    ev(3, "ai_proxy", "ai_request", {
      role: "tool_result",
      type: "tool_result",
      preview: "File updated successfully",
      sessionKey: "sess-recovered",
      toolUseId: "tool-retry",
    }, [], "Claude Code"),
    ev(4, "ai_proxy", "ai_response", {
      role: "assistant",
      stopReason: "end_turn",
      preview: "The route is fixed.",
      textHash: "final-response-hash",
      sessionKey: "sess-recovered",
    }, [], "Claude Code"),
  ];

  assert.equal(errors(reconstructEvents(events, { newId: makeSeededIdGen() })).length, 0);
});

test("a different successful tool can establish same-turn recovery", () => {
  const events = [
    ev(0, "ai_proxy", "ai_request", {
      role: "user",
      preview: "Update the route without replacing it.",
      sessionKey: "sess-different-tool",
    }, [], "Claude Code"),
    ev(1, "ai_proxy", "ai_response", {
      role: "assistant",
      tool: "Read",
      toolUseId: "tool-read",
      sessionKey: "sess-different-tool",
    }, [], "Claude Code"),
    ev(2, "ai_proxy", "ai_request", {
      role: "tool_result",
      type: "tool_result",
      is_error: true,
      preview: "No such file: src/old-route.ts",
      toolUseId: "tool-read",
      sessionKey: "sess-different-tool",
    }, [], "Claude Code"),
    ev(3, "ai_proxy", "ai_response", {
      role: "assistant",
      tool: "Edit",
      toolUseId: "tool-edit",
      sessionKey: "sess-different-tool",
    }, [], "Claude Code"),
    ev(4, "ai_proxy", "ai_request", {
      role: "tool_result",
      type: "tool_result",
      preview: "Updated src/route.ts",
      toolUseId: "tool-edit",
      sessionKey: "sess-different-tool",
    }, [], "Claude Code"),
    ev(5, "ai_proxy", "ai_response", {
      role: "assistant",
      stopReason: "end_turn",
      preview: "The existing route now has the new handler.",
      textHash: "different-tool-final",
      sessionKey: "sess-different-tool",
    }, [], "Claude Code"),
  ];

  assert.equal(errors(reconstructEvents(events, { newId: makeSeededIdGen() })).length, 0);
});

test("an unresolved Claude tool error remains an encountered_error", () => {
  const events = [
    ev(0, "ai_proxy", "ai_request", {
      role: "user",
      preview: "Fix the route.",
      sessionKey: "sess-unresolved",
    }, [], "Claude Code"),
    ev(1, "ai_proxy", "ai_request", {
      role: "tool_result",
      type: "tool_result",
      is_error: true,
      preview: "Permission denied: src/route.ts",
      sessionKey: "sess-unresolved",
      toolUseId: "tool-failed",
    }, [], "Claude Code"),
    // A final response can merely report the blocker. Without a successful
    // tool_result, it is not structural evidence that the failure recovered.
    ev(2, "ai_proxy", "ai_response", {
      role: "assistant",
      stopReason: "end_turn",
      preview: "I could not edit the route because permission was denied.",
      textHash: "blocked-response-hash",
      sessionKey: "sess-unresolved",
    }, [], "Claude Code"),
  ];

  const found = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.equal(found.length, 1);
  assert.match(String(found[0]?.payload?.errorText), /Permission denied/);
});

test("an unrelated successful tool cannot hide a still-failing operation", () => {
  const events = [
    ev(0, "ai_proxy", "ai_request", {
      role: "user",
      preview: "Fix the failing tests.",
      sessionKey: "sess-blocked",
    }, [], "Claude Code"),
    ev(1, "ai_proxy", "ai_response", {
      role: "assistant",
      tool: "Bash",
      toolUseId: "tool-bash",
      sessionKey: "sess-blocked",
    }, [], "Claude Code"),
    ev(2, "ai_proxy", "ai_request", {
      role: "tool_result",
      type: "tool_result",
      is_error: true,
      preview: "Tests failed: expected 1 but received 2",
      sessionKey: "sess-blocked",
      toolUseId: "tool-bash",
    }, [], "Claude Code"),
    ev(3, "ai_proxy", "ai_response", {
      role: "assistant",
      tool: "Read",
      toolUseId: "tool-read",
      sessionKey: "sess-blocked",
    }, [], "Claude Code"),
    ev(4, "ai_proxy", "ai_request", {
      role: "tool_result",
      type: "tool_result",
      preview: "Read 40 lines",
      sessionKey: "sess-blocked",
      toolUseId: "tool-read",
    }, [], "Claude Code"),
    ev(5, "ai_proxy", "ai_response", {
      role: "assistant",
      stopReason: "end_turn",
      preview: "The tests are still failing and I am blocked.",
      textHash: "blocked-final",
      sessionKey: "sess-blocked",
    }, [], "Claude Code"),
  ];

  const found = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.equal(found.length, 1);
  assert.match(found[0]?.text ?? "", /failed/i);
});

test("recovery in a later user turn does not erase the earlier tool error", () => {
  const events = [
    ev(0, "ai_proxy", "ai_request", {
      role: "user",
      preview: "Fix the route.",
      sessionKey: "sess-next-turn",
    }, [], "Claude Code"),
    ev(1, "ai_proxy", "ai_request", {
      role: "tool_result",
      type: "tool_result",
      is_error: true,
      preview: "Permission denied: src/route.ts",
      sessionKey: "sess-next-turn",
    }, [], "Claude Code"),
    ev(2, "ai_proxy", "ai_request", {
      role: "user",
      preview: "Try again after I fixed permissions.",
      sessionKey: "sess-next-turn",
    }, [], "Claude Code"),
    ev(3, "ai_proxy", "ai_request", {
      role: "tool_result",
      type: "tool_result",
      preview: "File updated successfully",
      sessionKey: "sess-next-turn",
    }, [], "Claude Code"),
    ev(4, "ai_proxy", "ai_response", {
      role: "assistant",
      stopReason: "end_turn",
      preview: "The route is fixed now.",
      textHash: "later-final-response-hash",
      sessionKey: "sess-next-turn",
    }, [], "Claude Code"),
  ];

  assert.equal(errors(reconstructEvents(events, { newId: makeSeededIdGen() })).length, 1);
});

test("agent recovery does not suppress an independently captured terminal error", () => {
  const terminal = ev(0, "terminal", "command_run", {
    cmd: "npm test",
    exitCode: 1,
    output: "Error: build failed\n    at run (src/build.ts:12:5)",
  });
  const failedTool = ev(1, "ai_proxy", "ai_request", {
    role: "tool_result",
    type: "tool_result",
    is_error: true,
    preview: "npm test failed",
    sessionKey: "sess-terminal",
  }, [], "Claude Code");
  const events = [
    terminal,
    failedTool,
    ev(2, "ai_proxy", "ai_request", {
      role: "tool_result",
      type: "tool_result",
      preview: "Fallback check passed",
      sessionKey: "sess-terminal",
    }, [], "Claude Code"),
    ev(3, "ai_proxy", "ai_response", {
      role: "assistant",
      stopReason: "end_turn",
      preview: "The fallback check passed.",
      textHash: "terminal-final-response-hash",
      sessionKey: "sess-terminal",
    }, [], "Claude Code"),
  ];

  const found = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]?.payload?.signalKinds, ["terminal_error"]);
  assert.deepEqual(found[0]?.evidence, [terminal.id]);
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

test("screen-only signals far apart are both ignored", () => {
  const events = [
    ev(0, "screen_video", "frame", { ocrText: "Error: first failure" }, [], "Cursor"),
    ev(300, "screen_video", "frame", { ocrText: "Error: much later failure" }, [], "Cursor"),
  ];
  const found = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.equal(found.length, 0);
});

test("matched-line extraction drops unrelated OCR and terminal headers", () => {
  const events = [
    ev(0, "screen_video", "frame", {
      ocrText: "ChatGPT File Edit View Window\nTypeError: cannot read properties of undefined",
    }, [], "Cursor"),
    ev(2, "terminal", "command_run", {
      cmd: "npm test",
      output: "Test runner header\nTypeError: cannot read properties of undefined\n    at run (src/foo.ts:12:5)",
    }),
  ];
  const found = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.text, "TypeError: cannot read properties of undefined");
  assert.doesNotMatch(String(found[0]!.payload?.errorText), /Test runner header|ChatGPT File Edit/);
});

test("success counters and error-documentation prose are negative cases", () => {
  const texts = [
    "0 errors, 73 passed",
    "Tests: 73 passed, 0 failed",
    "Error handling documentation",
    "Browse common error messages",
  ];
  for (const [index, text] of texts.entries()) {
    const found = errors(reconstructEvents([
      ev(index * 60, "screen_video", "frame", { ocrText: text }, [], "Browser"),
    ], { newId: makeSeededIdGen() }));
    assert.equal(found.length, 0, text);
  }
});

test("structured anchor keeps the id stable as older OCR frames leave the window", () => {
  const leading = ev(0, "screen_video", "frame", { ocrText: "TypeError: boom" }, [], "Cursor");
  const terminal = ev(5, "terminal", "command_run", {
    cmd: "npm test",
    output: "TypeError: boom\n    at run (src/foo.ts:12:5)",
  });
  const trailing = ev(10, "screen_video", "frame", { ocrText: "TypeError: boom" }, [], "Cursor");
  const full = errors(reconstructEvents([leading, terminal, trailing]));
  const rolled = errors(reconstructEvents([terminal, trailing]));
  assert.equal(full.length, 1);
  assert.equal(rolled.length, 1);
  assert.equal(full[0]!.id, rolled[0]!.id);
  assert.equal(full[0]!.startTs, terminal.ts);
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

test("independent terminal failures from different app/workspace contexts stay separate", () => {
  const events = [
    ev(0, "terminal", "command_run", {
      cmd: "pnpm test",
      cwd: "/Users/dev/project-a",
      output: "TypeError: project A failed\n    at run (src/a.ts:12:5)",
    }, [], "Terminal A"),
    ev(5, "terminal", "command_run", {
      cmd: "pnpm build",
      cwd: "/Users/dev/project-b",
      output: "Build failed\n    at run (src/b.ts:9:2)",
    }, [], "Terminal B"),
  ];

  const found = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((action) => action.evidence.length), [1, 1]);
  assert.deepEqual(new Set(found.map((action) => action.app)), new Set(["Terminal A", "Terminal B"]));
});

test("Claude tool failures from different sessions never corroborate each other", () => {
  const events = [
    ev(0, "ai_proxy", "tool_result", {
      role: "tool_result",
      type: "tool_result",
      is_error: true,
      preview: "Edit failed in project A",
      sessionKey: "session-a",
    }, [], "Claude Code"),
    ev(5, "ai_proxy", "tool_result", {
      role: "tool_result",
      type: "tool_result",
      is_error: true,
      preview: "Edit failed in project B",
      sessionKey: "session-b",
    }, [], "Claude Code"),
  ];

  const found = errors(reconstructEvents(events, { newId: makeSeededIdGen() }));
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((action) => action.evidence.length), [1, 1]);
});

test("nearby terminal and agent failures need shared workspace or command context", () => {
  const terminal = ev(0, "terminal", "command_run", {
    cmd: "pnpm test",
    cwd: "/Users/dev/project-a",
    output: "TypeError: project A failed\n    at run (src/a.ts:12:5)",
  }, [], "Terminal");
  const agent = ev(5, "ai_proxy", "tool_result", {
    role: "tool_result",
    type: "tool_result",
    is_error: true,
    preview: "Permission denied while editing project B",
    sessionKey: "session-b",
    cwd: "/Users/dev/project-b",
  }, [], "Claude Code");

  const separate = errors(reconstructEvents([terminal, agent], {
    newId: makeSeededIdGen(),
  }));
  assert.equal(separate.length, 2);
  assert.deepEqual(separate.map((action) => action.evidence.length), [1, 1]);

  const relatedAgent: RawEvent = {
    ...agent,
    id: "related-agent",
    hash: "hash-related-agent",
    payload: {
      ...agent.payload,
      cwd: "/Users/dev/project-a",
      preview: "pnpm test failed in project A",
    },
  };
  const correlated = errors(reconstructEvents([terminal, relatedAgent], {
    newId: makeSeededIdGen(),
  }));
  assert.equal(correlated.length, 1);
  assert.equal(correlated[0]?.evidence.length, 2);
});
