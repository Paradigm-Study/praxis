import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlaybook, critique } from "../src/transfer/transfer.ts";
import { fullPipeline, action, freshStore } from "./helpers.ts";

test("playbook distills the learned graph", async () => {
  const { store } = await fullPipeline();
  const pb = buildPlaybook(store);
  assert.ok(pb.workflow.length >= 3);
  assert.equal(pb.workflow[0], "consult AI");
  assert.ok(pb.decisionRules.some((r) => /evidence-backed/.test(r.text)));
  assert.deepEqual(pb.knowHow, [], "one failure-recovery episode stays provisional");
});

test("playbook curates unresolved ask_expert decisions instead of legacy question claims", () => {
  const store = freshStore();
  try {
    const questionAction = action({
      id: "transfer_question_action",
      action: "answered_question",
      startTs: "2026-07-13T10:00:00.000Z",
    });
    store.actions.put(questionAction);
    const putDecision = (
      id: string,
      question: string | undefined,
      createdTs: string,
      kind = "ask_expert",
    ) => store.decisions.put({
      id,
      kind,
      reason: "Needs the expert's judgment",
      question,
      evidence: [questionAction.id],
      createdTs,
    });

    store.claims.put({
      id: "legacy_question_claim",
      kind: "unresolved_question",
      text: "This stale claim must not appear",
      confidence: 1,
      evidenceEpisodes: [],
      createdTs: "2026-07-13T10:00:00.000Z",
      updatedTs: "2026-07-13T10:00:00.000Z",
    });
    putDecision(
      "decision_cache_old",
      "Should we use Postgres for the cache?",
      "2026-07-13T10:01:00.000Z",
    );
    putDecision(
      "decision_cache_new",
      "Should we use Postgres for the cache, correct?",
      "2026-07-13T10:02:00.000Z",
    );
    putDecision(
      "decision_answered",
      "Tabs or spaces for generated files?",
      "2026-07-13T10:03:00.000Z",
    );
    putDecision(
      "decision_migration_old",
      "Should migration happen before rollout?",
      "2026-07-13T10:04:00.000Z",
    );
    putDecision(
      "decision_migration_new",
      "Should the migration happen before the rollout?",
      "2026-07-13T10:05:00.000Z",
    );
    putDecision(
      "decision_intervene",
      "Should the deployment be stopped?",
      "2026-07-13T10:06:00.000Z",
      "intervene",
    );
    store.corrections.put({
      id: "correction_answered",
      targetKind: "decision",
      targetId: "decision_answered",
      verdict: "edited",
      origin: "human",
      correctedText: "spaces",
      createdTs: "2026-07-13T10:07:00.000Z",
    });
    store.corrections.put({
      id: "correction_dismissed",
      targetKind: "decision",
      targetId: "decision_migration_old",
      verdict: "rejected",
      origin: "human",
      note: "question-dismissed:should migration happen before rollout",
      createdTs: "2026-07-13T10:08:00.000Z",
    });

    assert.deepEqual(buildPlaybook(store).openQuestions, [
      "Should we use Postgres for the cache, correct?",
    ]);
  } finally {
    store.close();
  }
});

test("one-off inferred claims cannot steer the operable playbook", () => {
  const store = freshStore();
  try {
    store.claims.put({
      id: "one_off_workflow",
      kind: "workflow_pattern",
      text: "Workflow: skip review → deploy immediately",
      confidence: 0.95,
      evidenceEpisodes: ["episode_once"],
      createdTs: "2026-07-13T10:00:00.000Z",
      updatedTs: "2026-07-13T10:00:00.000Z",
    });
    store.claims.put({
      id: "repeated_rule",
      kind: "decision_rule",
      text: "Require a verified backup before migration.",
      confidence: 0.9,
      evidenceEpisodes: ["episode_a", "episode_b"],
      createdTs: "2026-07-13T10:00:00.000Z",
      updatedTs: "2026-07-13T10:01:00.000Z",
    });
    const playbook = buildPlaybook(store);
    assert.deepEqual(playbook.workflow, []);
    assert.deepEqual(playbook.decisionRules.map((rule) => rule.text), [
      "Require a verified backup before migration.",
    ]);
  } finally {
    store.close();
  }
});

test("critique flags committing without running tests", async () => {
  const { store } = await fullPipeline();
  const pb = buildPlaybook(store);
  const advisories = critique(pb, [
    action({ action: "edited_file", startTs: "2026-06-10T10:00:00.000Z" }),
    action({ action: "committed", startTs: "2026-06-10T10:01:00.000Z", text: "wip" }),
  ]);
  assert.ok(advisories.some((a) => /tests before committing/i.test(a)));
});

test("critique is quiet when the learner follows the workflow", async () => {
  const { store } = await fullPipeline();
  const pb = buildPlaybook(store);
  const advisories = critique(pb, [
    action({ action: "edited_file", startTs: "2026-06-10T10:00:00.000Z" }),
    action({ action: "ran_command", startTs: "2026-06-10T10:00:30.000Z", text: "npm test", payload: { exitCode: 0 } }),
    action({ action: "committed", startTs: "2026-06-10T10:01:00.000Z", text: "feat: x" }),
  ]);
  assert.ok(!advisories.some((a) => /tests before committing/i.test(a)));
});
