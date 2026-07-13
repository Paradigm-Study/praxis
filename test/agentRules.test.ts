import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { makeIngest } from "../src/capture/ingest.ts";
import { transcriptLineToInputs } from "../src/capture/sources/agentSessions.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import {
  reconstruct,
  reconstructEvents,
} from "../src/reconstructor/reconstructor.ts";
import { freshStore } from "./helpers.ts";

const SESSION_ID = "3f9c2b1e-8d4a-4c6f-9e21-7ab5c0d4e812";

function fixtureLines(): string[] {
  return readFileSync(
    new URL("./fixtures/agent-session.jsonl", import.meta.url),
    "utf8",
  )
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

test("reconstructs agent tools and transcript completion", () => {
  const store = freshStore();
  try {
    const ingest = makeIngest(store).ingest;
    for (const line of fixtureLines()) {
      for (const input of transcriptLineToInputs(line)) ingest(input);
    }

    const actions = reconstruct(store, { newId: makeSeededIdGen() });
    const prompts = actions.filter((action) => action.action === "submitted_message");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]?.text ?? "", /add a \/health endpoint/i);
    assert.deepEqual(prompts[0]?.reconstructedBy, ["agent.agentSubmittedPrompt"]);
    assert.equal(prompts[0]?.payload?.structuredAgentContext, true);
    const edited = actions.filter((action) => action.action === "edited_file");
    assert.equal(edited.length, 3);
    assert.ok(
      edited.some((action) => action.text === "src/routes/index.ts"),
      "expected the route-index edit",
    );
    for (const action of edited) {
      assert.deepEqual(action.reconstructedBy, ["agent.agentEditedFile"]);
      assert.ok(
        action.confidence >= 0.9,
        `expected corroborated edit confidence, got ${action.confidence}`,
      );
    }

    const commands = actions.filter((action) => action.action === "ran_command");
    assert.equal(commands.length, 2);
    for (const command of commands) {
      assert.deepEqual(command.reconstructedBy, ["agent.agentRanCommand"]);
      assert.equal(command.payload?.sessionKey, SESSION_ID);
    }
    assert.ok(
      commands.some((action) => action.text?.includes("ls src/routes")),
      "expected the route-listing command",
    );
    assert.ok(
      commands.some((action) => action.text?.includes("npx vitest run")),
      "expected the test command",
    );

    const completions = actions.filter(
      (action) => action.action === "received_response",
    );
    assert.equal(completions.length, 1);
    const completion = completions[0]!;
    assert.deepEqual(completion.reconstructedBy, ["agent.agentCompletedTask"]);
    assert.match(completion.text ?? "", /Added the \/health endpoint/);
    assert.ok(completion.uncertainty && completion.uncertainty.length > 0);

    const eventIds = new Set(store.events.range().map((event) => event.id));
    for (const action of [...edited, ...commands, completion]) {
      assert.ok(action.evidence.length > 0);
      for (const evidenceId of action.evidence) {
        assert.ok(
          eventIds.has(evidenceId),
          `${action.action} refers to missing evidence ${evidenceId}`,
        );
      }
    }

    const events = store.events.range();
    const firstIds = reconstructEvents(events).map((action) => action.id);
    const secondIds = reconstructEvents(events).map((action) => action.id);
    assert.deepEqual(secondIds, firstIds);
  } finally {
    store.close();
  }
});

test("a corrective Claude turn becomes an explicit evidence-backed decision", () => {
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T10:00:00.000Z",
      sessionId: SESSION_ID,
      cwd: "/Users/dev/acme-api",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I will replace the existing route." }],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-10T10:00:01.000Z",
      sessionId: SESSION_ID,
      cwd: "/Users/dev/acme-api",
      message: { role: "user", content: "No, keep the existing route and add a separate health handler." },
    }),
  ];
  const store = freshStore();
  try {
    const ingest = makeIngest(store).ingest;
    for (const line of lines) for (const input of transcriptLineToInputs(line)) ingest(input);
    const actions = reconstruct(store, { newId: makeSeededIdGen() });
    assert.ok(actions.some((action) => action.action === "submitted_message"));
    const correction = actions.find((action) => action.action === "corrected_agent");
    assert.match(correction?.text ?? "", /keep the existing route/);
    assert.deepEqual(correction?.reconstructedBy, ["agent.agentCorrectedPrompt"]);
    assert.equal(correction?.evidence.length, 2);
  } finally {
    store.close();
  }
});

test("assistant tool use between text and a corrective turn does not hide the correction", () => {
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T10:00:00.000Z",
      sessionId: SESSION_ID,
      message: { role: "assistant", content: [{ type: "text", text: "I will replace the route." }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T10:00:01.000Z",
      sessionId: SESSION_ID,
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "route.ts" } }],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-10T10:00:02.000Z",
      sessionId: SESSION_ID,
      message: { role: "user", content: "Actually, keep the route and add a handler." },
    }),
  ];
  const store = freshStore();
  try {
    const ingest = makeIngest(store).ingest;
    for (const line of lines) for (const input of transcriptLineToInputs(line)) ingest(input);
    const actions = reconstruct(store, { newId: makeSeededIdGen() });
    assert.match(actions.find((item) => item.action === "corrected_agent")?.text ?? "", /keep the route/);
  } finally {
    store.close();
  }
});

test("a later no-tool turn never borrows old tool activity as completion evidence", () => {
  const lines = [
    JSON.stringify({ type: "user", timestamp: "2026-07-10T10:00:00.000Z", sessionId: SESSION_ID, message: { role: "user", content: "Edit the route." } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:01.000Z", sessionId: SESSION_ID, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tool_1", name: "Write", input: { file_path: "route.ts" } }] } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:02.000Z", sessionId: SESSION_ID, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "The route is updated." }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-10T10:00:03.000Z", sessionId: SESSION_ID, message: { role: "user", content: "What time is it?" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-10T10:00:04.000Z", sessionId: SESSION_ID, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "It is ten." }] } }),
  ];
  const store = freshStore();
  try {
    const ingest = makeIngest(store).ingest;
    for (const line of lines) for (const input of transcriptLineToInputs(line)) ingest(input);
    const completions = reconstruct(store, { newId: makeSeededIdGen() })
      .filter((item) => item.action === "received_response");
    assert.equal(completions.length, 1);
    assert.match(completions[0]?.text ?? "", /route is updated/);
    assert.doesNotMatch(completions[0]?.text ?? "", /ten/);
  } finally {
    store.close();
  }
});

test("ordinary follow-up prompts are not mislabeled as corrections", () => {
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T10:00:00.000Z",
      sessionId: SESSION_ID,
      cwd: "/Users/dev/acme-api",
      message: { role: "assistant", content: [{ type: "text", text: "The tests pass." }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-10T10:00:01.000Z",
      sessionId: SESSION_ID,
      cwd: "/Users/dev/acme-api",
      message: { role: "user", content: "No blockers remain; run the release tests." },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T10:00:02.000Z",
      sessionId: SESSION_ID,
      cwd: "/Users/dev/acme-api",
      message: { role: "assistant", content: [{ type: "text", text: "Ready for the next task." }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-10T10:00:03.000Z",
      sessionId: SESSION_ID,
      cwd: "/Users/dev/acme-api",
      message: { role: "user", content: "Add error handling instead of crashing." },
    }),
  ];
  const store = freshStore();
  try {
    const ingest = makeIngest(store).ingest;
    for (const line of lines) for (const input of transcriptLineToInputs(line)) ingest(input);
    const actions = reconstruct(store, { newId: makeSeededIdGen() });
    assert.equal(actions.filter((action) => action.action === "submitted_message").length, 2);
    assert.equal(actions.some((action) => action.action === "corrected_agent"), false);
  } finally {
    store.close();
  }
});

test("Actually questions and stop commands remain ordinary submitted prompts", () => {
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T10:00:00.000Z",
      sessionId: SESSION_ID,
      message: { role: "assistant", content: [{ type: "text", text: "The server is running." }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-10T10:00:01.000Z",
      sessionId: SESSION_ID,
      message: { role: "user", content: "Actually, what time is it?" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T10:00:02.000Z",
      sessionId: SESSION_ID,
      message: { role: "assistant", content: [{ type: "text", text: "It is ten." }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-10T10:00:03.000Z",
      sessionId: SESSION_ID,
      message: { role: "user", content: "Stop the dev server." },
    }),
  ];
  const store = freshStore();
  try {
    const ingest = makeIngest(store).ingest;
    for (const line of lines) for (const input of transcriptLineToInputs(line)) ingest(input);
    const actions = reconstruct(store, { newId: makeSeededIdGen() });
    assert.equal(actions.filter((action) => action.action === "submitted_message").length, 2);
    assert.equal(actions.some((action) => action.action === "corrected_agent"), false);
  } finally {
    store.close();
  }
});

test("a distant or non-adjacent cue is not treated as a correction", () => {
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T10:00:00.000Z",
      sessionId: SESSION_ID,
      cwd: "/Users/dev/acme-api",
      message: { role: "assistant", content: [{ type: "text", text: "I will replace it." }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-10T10:10:01.000Z",
      sessionId: SESSION_ID,
      cwd: "/Users/dev/acme-api",
      message: { role: "user", content: "No, keep it." },
    }),
  ];
  const store = freshStore();
  try {
    const ingest = makeIngest(store).ingest;
    for (const line of lines) for (const input of transcriptLineToInputs(line)) ingest(input);
    const actions = reconstruct(store, { newId: makeSeededIdGen() });
    assert.equal(actions.some((action) => action.action === "corrected_agent"), false);
  } finally {
    store.close();
  }
});

test("failed Claude edits and cross-session tool results never become edited_file", () => {
  const otherSession = "7c58dcf8-9364-49c0-9917-155004025c80";
  const successfulSession = "bdf0a44f-c108-455e-86a7-b3194945142f";
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T11:00:00.000Z",
      sessionId: SESSION_ID,
      cwd: "/Users/dev/acme-api",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "shared-tool-id",
          name: "Edit",
          input: { file_path: "src/failed.ts" },
        }],
      },
    }),
    // This tempting success has the same tool id but belongs to another
    // transcript. It must not validate SESSION_ID's edit.
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-10T11:00:01.000Z",
      sessionId: otherSession,
      cwd: "/Users/dev/other-repo",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "shared-tool-id",
          content: "File updated successfully",
        }],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-10T11:00:02.000Z",
      sessionId: SESSION_ID,
      cwd: "/Users/dev/acme-api",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "shared-tool-id",
          is_error: true,
          content: "Edit failed: old text was not found",
        }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T11:00:03.000Z",
      sessionId: successfulSession,
      cwd: "/Users/dev/good-repo",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "good-tool-id",
          name: "Write",
          input: { file_path: "src/succeeded.ts" },
        }],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-10T11:00:04.000Z",
      sessionId: successfulSession,
      cwd: "/Users/dev/good-repo",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "good-tool-id",
          content: "File created successfully",
        }],
      },
    }),
  ];
  const store = freshStore();
  try {
    const ingest = makeIngest(store).ingest;
    for (const line of lines) for (const input of transcriptLineToInputs(line)) ingest(input);
    const edits = reconstruct(store, { newId: makeSeededIdGen() })
      .filter((action) => action.action === "edited_file");
    assert.equal(edits.length, 1);
    assert.equal(edits[0]?.text, "src/succeeded.ts");
    assert.equal(edits[0]?.payload?.sessionKey, successfulSession);
  } finally {
    store.close();
  }
});

test("Claude Bash outcomes correlate by session and preserve failures", () => {
  const otherSession = "a26cb40a-2689-4f37-b8cc-0c1e90574bb5";
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T11:10:00.000Z",
      sessionId: SESSION_ID,
      cwd: "/Users/dev/acme-api",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "shared-bash-id",
          name: "Bash",
          input: { command: "pnpm test" },
        }],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-10T11:10:01.000Z",
      sessionId: otherSession,
      cwd: "/Users/dev/other-repo",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "shared-bash-id",
          content: "Tests passed",
        }],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-10T11:10:02.000Z",
      sessionId: SESSION_ID,
      cwd: "/Users/dev/acme-api",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "shared-bash-id",
          is_error: true,
          content: "Tests failed",
        }],
      },
    }),
    // An invocation without its own result remains an attempt, not a durable
    // `ran_command` fact.
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T11:10:03.000Z",
      sessionId: otherSession,
      cwd: "/Users/dev/other-repo",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "missing-result",
          name: "Bash",
          input: { command: "pnpm lint" },
        }],
      },
    }),
  ];
  const store = freshStore();
  try {
    const ingest = makeIngest(store).ingest;
    for (const line of lines) for (const input of transcriptLineToInputs(line)) ingest(input);
    const commands = reconstruct(store, { newId: makeSeededIdGen() })
      .filter((action) => action.action === "ran_command");
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.text, "pnpm test");
    assert.equal(commands[0]?.payload?.sessionKey, SESSION_ID);
    assert.equal(commands[0]?.payload?.exitCode, 1);
    assert.equal(commands[0]?.payload?.succeeded, false);
    assert.equal(commands[0]?.evidence.length, 2);
  } finally {
    store.close();
  }
});
