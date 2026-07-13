import assert from "node:assert/strict";
import { test } from "node:test";
import type { Correction, Observation } from "../src/core/types.ts";
import {
  isActionQuestionWorthy,
  isMeaningfulCorrection,
  isQuestionWorthy,
  normalizeQuestion,
  questionWasResolved,
  sameQuestion,
  actionQuestionWasResolved,
  uniqueQuestionDecisions,
} from "../src/agent/questionQuality.ts";
import { action } from "./helpers.ts";

function observation(partial: Partial<Observation> = {}): Observation {
  return {
    id: "obs_1",
    bundleId: "bundle_1",
    acceptedOptions: [],
    rejectedOptions: [],
    uncertainty: ["The decision order is unclear"],
    suggestedQuestion: "Should the migration happen before or after the rollout?",
    evidence: ["action_1"],
    model: "semantic-test-observer",
    createdTs: "2026-07-13T00:00:00.000Z",
    ...partial,
  };
}

test("question identity is stable without collapsing opposite directions", () => {
  assert.equal(normalizeQuestion("  Ship before deploy? "), "ship before deploy");
  assert.equal(sameQuestion("Ship before deploy?", "ship before deploy."), true);
  assert.equal(
    sameQuestion(
      "Should the database migration happen before the production rollout?",
      "Should the production rollout happen before the database migration?",
    ),
    false,
  );
  assert.equal(
    sameQuestion(
      "Should we use Postgres instead of SQLite?",
      "Should we use SQLite instead of Postgres?",
    ),
    false,
  );
  assert.equal(sameQuestion("Use Postgres?", "Use SQLite?"), false);
});

test("opposite directives stay unique and cannot inherit a dismissal", () => {
  const enable = "Should we enable detailed audit logging for the production rollout?";
  const disable = "Should we disable detailed audit logging for the production rollout?";
  const keep = "Should we keep detailed screen evidence after the production rollout?";
  const remove = "Should we remove detailed screen evidence after the production rollout?";
  const alwaysEncrypt = "Should we always encrypt detailed audit logs before cloud upload?";
  const neverEncrypt = "Should we never encrypt detailed audit logs before cloud upload?";
  const requireApproval = "Should local approval be required before deleting captured evidence?";
  const notRequireApproval = "Should local approval not be required before deleting captured evidence?";

  assert.equal(sameQuestion(enable, disable), false);
  assert.equal(sameQuestion(keep, remove), false);
  assert.equal(sameQuestion(alwaysEncrypt, neverEncrypt), false);
  assert.equal(sameQuestion(requireApproval, notRequireApproval), false);
  assert.equal(
    sameQuestion(
      "Should external display context be allowed during the team demo?",
      "Should external display context be disallowed during the team demo?",
    ),
    false,
  );

  const decisions = uniqueQuestionDecisions([
    {
      id: "decision_disable",
      kind: "ask_expert",
      reason: "verify",
      question: disable,
      evidence: ["action_disable"],
      createdTs: "2026-07-13T00:00:03.000Z",
    },
    {
      id: "decision_enable",
      kind: "ask_expert",
      reason: "verify",
      question: enable,
      evidence: ["action_enable"],
      createdTs: "2026-07-13T00:00:02.000Z",
    },
    {
      id: "decision_enable_old",
      kind: "ask_expert",
      reason: "verify",
      question: enable,
      evidence: ["action_enable_old"],
      createdTs: "2026-07-13T00:00:01.000Z",
    },
  ], 10);
  assert.deepEqual(decisions.map((decision) => decision.id), [
    "decision_disable",
    "decision_enable",
  ]);
  assert.equal(
    uniqueQuestionDecisions([
      {
        id: "decision_never_encrypt",
        kind: "ask_expert",
        reason: "verify",
        question: neverEncrypt,
        evidence: ["action_never_encrypt"],
        createdTs: "2026-07-13T00:00:02.000Z",
      },
      {
        id: "decision_always_encrypt",
        kind: "ask_expert",
        reason: "verify",
        question: alwaysEncrypt,
        evidence: ["action_always_encrypt"],
        createdTs: "2026-07-13T00:00:01.000Z",
      },
    ], 10).length,
    2,
  );

  const dismissal: Correction = {
    id: "corr_enable",
    targetKind: "decision",
    targetId: "old_enable_question",
    verdict: "rejected",
    origin: "human",
    note: `question-dismissed:${normalizeQuestion(enable)}`,
    createdTs: "2026-07-13T00:00:00.000Z",
  };
  assert.equal(
    questionWasResolved("new_disable_question", disable, [dismissal]),
    false,
    "dismissing enable must not suppress the opposite disable question",
  );
  assert.equal(
    actionQuestionWasResolved("new_remove_action", remove, [{
      ...dismissal,
      targetKind: "action",
      note: `question-dismissed:${normalizeQuestion(keep)}`,
    }]),
    false,
    "dismissing keep must not suppress the opposite remove review card",
  );
  assert.equal(
    questionWasResolved("new_never_encrypt", neverEncrypt, [{
      ...dismissal,
      note: `question-dismissed:${normalizeQuestion(alwaysEncrypt)}`,
    }]),
    false,
    "dismissing always must not suppress the opposite never question",
  );
  assert.equal(
    questionWasResolved("new_optional_approval", notRequireApproval, [{
      ...dismissal,
      note: `question-dismissed:${normalizeQuestion(requireApproval)}`,
    }]),
    false,
    "dismissing required must not suppress the opposite not-required question",
  );
});

test("screen-only OCR errors and ambient file sightings never become questions", () => {
  const ocrError = action({
    id: "action_1",
    action: "encountered_error",
    app: "Codex",
    startTs: "2026-07-13T00:00:00.000Z",
    text: "error shown in conversation text",
    confidence: 0.92,
    uncertainty: ["matched an error token"],
    payload: { signalKinds: ["screen_ocr"] },
  });
  const file = action({
    id: "action_file",
    action: "opened_file",
    startTs: "2026-07-13T00:00:01.000Z",
    text: "dist/app.js",
    confidence: 0.4,
    uncertainty: ["first filesystem sighting"],
  });
  assert.equal(isQuestionWorthy(observation(), [ocrError]), false);
  assert.equal(isActionQuestionWorthy(ocrError), false);
  assert.equal(isActionQuestionWorthy(file), false);
});

test("a semantic question tied to corroborated consequential activity is eligible", () => {
  const structuredError = action({
    id: "action_1",
    action: "encountered_error",
    app: "Terminal",
    startTs: "2026-07-13T00:00:00.000Z",
    text: "TypeError in the build",
    confidence: 0.85,
    uncertainty: ["root cause is unclear"],
    payload: { signalKinds: ["terminal_error", "agent_tool_error"] },
  });
  assert.equal(isQuestionWorthy(observation(), [structuredError]), true);
  assert.equal(isActionQuestionWorthy(structuredError), true);
});

test("dismissals resolve semantic duplicates and option labels are not corrections", () => {
  const correction: Correction = {
    id: "corr_1",
    targetKind: "decision",
    targetId: "old_question_id",
    verdict: "rejected",
    origin: "human",
    note: "question-dismissed:should migration happen before rollout",
    createdTs: "2026-07-13T00:00:00.000Z",
  };
  assert.equal(
    questionWasResolved(
      "new_question_id",
      "Should migration happen before rollout?",
      [correction],
    ),
    true,
  );
  assert.equal(isMeaningfulCorrection("Close, but not quite"), false);
  assert.equal(isMeaningfulCorrection("No — correct it"), false);
  assert.equal(isMeaningfulCorrection("No — I’ll correct it"), false);
  assert.equal(isMeaningfulCorrection("The migration should run after the backup"), true);

  const actionDismissal: Correction = {
    ...correction,
    id: "corr_action",
    targetKind: "action",
    targetId: "old_action_id",
    note: "question-dismissed:reviewed the installer options",
  };
  assert.equal(
    actionQuestionWasResolved(
      "new_action_id",
      "I think you reviewed the installer options. Correct?",
      [actionDismissal],
    ),
    true,
  );
});
