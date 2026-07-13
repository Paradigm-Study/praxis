import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Observation } from "../src/core/types.ts";
import { decide } from "../src/agent/policy.ts";
import { maybeDispatch } from "../src/agent/dispatch.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import { action, freshStore } from "./helpers.ts";

// The policy's dispatch branch (integration wiring): a fresh, high-confidence
// `encountered_error` reconstruction must yield a `dispatch` decision that
// agent/dispatch.ts can execute — that is the ONLY path by which dispatch is
// reachable from the agent loop.

// Isolate dispatches.ndjson per test; never touch the repo's real data/.
beforeEach(() => {
  process.env.PRAXIS_DATA_DIR = mkdtempSync(join(tmpdir(), "praxis-policy-dispatch-"));
  delete process.env.PRAXIS_DISPATCH_SPAWN;
  delete process.env.BOARDROOM_URL;
});

function obs(partial: Partial<Observation> = {}): Observation {
  return {
    id: "obs_1",
    bundleId: "bundle_1",
    acceptedOptions: [],
    rejectedOptions: [],
    uncertainty: [],
    evidence: ["raw_1"],
    model: "mock",
    createdTs: "2026-06-10T12:00:00.000Z",
    ...partial,
  };
}

const ERROR_TEXT =
  'TypeError: cannot read properties of undefined\n    at build (/repo/src/build.ts:42:7)\n  File "/repo/tool.py", line 9';

function errorAction(over: Partial<Parameters<typeof action>[0]> = {}) {
  return action({
    id: "action_err1",
    action: "encountered_error",
    app: "Terminal",
    startTs: "2026-06-10T11:59:00.000Z",
    confidence: 0.8,
    text: ERROR_TEXT.split("\n")[0]!,
    payload: { errorText: ERROR_TEXT, signalKinds: ["terminal_error", "agent_tool_error"] },
    ...over,
  });
}

test("a fresh high-confidence encountered_error yields a dispatch decision", () => {
  const decision = decide({ observation: obs(), actions: [errorAction()], claims: [] });
  assert.equal(decision.kind, "dispatch");
  assert.ok(decision.task && decision.task.includes("TypeError"), "task carries the error text");
  assert.equal(decision.evidence?.[0], "action_err1", "trigger action id leads the evidence");
  assert.ok(decision.evidence?.includes("raw_1"), "observation evidence is preserved");
});

test("a stale error does not shadow other decisions", () => {
  const decision = decide({
    observation: obs(),
    actions: [
      errorAction({ startTs: "2026-06-10T11:00:00.000Z" }), // 59 min before newest
      action({ id: "action_new", action: "edited_file", startTs: "2026-06-10T11:59:00.000Z" }),
    ],
    claims: [],
  });
  assert.notEqual(decision.kind, "dispatch");
});

test("a low-confidence error does not dispatch", () => {
  const decision = decide({
    observation: obs(),
    actions: [errorAction({ confidence: 0.5 })],
    claims: [],
  });
  assert.notEqual(decision.kind, "dispatch");
});

test("ask_expert outranks dispatch when a pressing question exists", () => {
  const decision = decide({
    observation: obs({
      uncertainty: ["unsure whether the migration direction is right"],
      suggestedQuestion: "Should the migration run before or after the deploy?",
      model: "semantic-test-observer",
      evidence: ["action_err1"],
    }),
    actions: [errorAction()],
    claims: [],
  });
  assert.equal(decision.kind, "ask_expert");
});

test("decide → maybeDispatch round-trips into a dry-run dispatch record", async () => {
  const store = freshStore();
  const trigger = errorAction();
  store.actions.put(trigger);

  const observation = obs();
  const decision = decide({ observation, actions: [trigger], claims: [] });
  assert.equal(decision.kind, "dispatch");

  const record = await maybeDispatch({
    store,
    decision,
    observation,
    decisionId: "decision_test",
    newId: makeSeededIdGen(),
  });
  assert.ok(record, "the decision executes into a dispatch record");
  assert.equal(record.mode, "dry_run");
  assert.deepEqual(record.command?.slice(0, 2), ["claude", "-p"]);
  store.close();
});
