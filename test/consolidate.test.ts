import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimTextSimilarity,
  consolidate,
  evidenceCoverage,
} from "../src/memory/consolidate.ts";
import { explicitDirectiveConflict } from "../src/core/textOpposition.ts";
import type { Claim } from "../src/core/types.ts";

function claim(kind: string, text: string, eps: string[], conf = 0.8): Claim {
  return {
    id: "c_" + text.slice(0, 8) + eps.join(""),
    kind, text, confidence: conf, evidenceEpisodes: eps,
    createdTs: "t", updatedTs: "t",
  };
}

test("near-duplicate rewordings merge into one canonical entry", () => {
  const claims = [
    claim("taste_rule", "Prefers lightweight conversational status checks over inspecting logs", ["e1"]),
    claim("taste_rule", "Strongly prefers conversational status checks rather than manual log inspection", ["e2"]),
    claim("taste_rule", "Prefers casual conversational status checks over manually inspecting logs", ["e3"], 0.7),
  ];
  const profile = consolidate(claims);
  assert.equal(profile.length, 1, "3 rewordings of one idea → 1 entry");
  assert.equal(profile[0]!.variants.length, 2, "the other phrasings are kept, not discarded");
  assert.deepEqual([...profile[0]!.evidenceEpisodes].sort(), ["e1", "e2", "e3"]);
});

test("distinct claims do NOT merge (the safe failure mode is under-merging)", () => {
  const claims = [
    claim("taste_rule", "Prefers long-running background agents with auto re-invocation", ["e1"]),
    claim("taste_rule", "Prefers adversarial multi-perspective validation before finalizing", ["e2"]),
    claim("decision_rule", "Avoids running benchmarks without cost caps", ["e3"]),
  ];
  const profile = consolidate(claims);
  assert.equal(profile.length, 3, "genuinely different ideas stay separate");
});

test("opposite directional choices never merge", () => {
  const claims = [
    claim("decision_rule", "Prefer Postgres over SQLite for local storage", ["e1"]),
    claim("decision_rule", "Prefer SQLite over Postgres for local storage", ["e2"]),
  ];
  assert.equal(consolidate(claims).length, 2);
});

test("opposite polarity and negation never merge", () => {
  assert.equal(consolidate([
    claim("taste_rule", "Prefer verbose logs", ["e1"]),
    claim("taste_rule", "Avoid verbose logs", ["e2"]),
  ]).length, 2);
  assert.equal(consolidate([
    claim("decision_rule", "Use auto-deploy for previews", ["e1"]),
    claim("decision_rule", "Do not use auto-deploy for previews", ["e2"]),
  ]).length, 2);
  assert.equal(consolidate([
    claim("taste_rule", "Prefer using verbose logs", ["e1"]),
    claim("taste_rule", "Prefer not using verbose logs", ["e2"]),
  ]).length, 2);
  assert.equal(consolidate([
    claim("taste_rule", "Would rather use verbose logs", ["e1"]),
    claim("taste_rule", "Would rather not use verbose logs", ["e2"]),
  ]).length, 2);
});

test("explicit opposite directives over the same target never merge", () => {
  const pairs = [
    [
      "Always enable detailed audit logs for production rollout",
      "Always disable detailed audit logs for production rollout",
    ],
    [
      "Always allow external display context during team demos",
      "Always disallow external display context during team demos",
    ],
    [
      "Always include screen images in cloud observer context",
      "Always exclude screen images from cloud observer context",
    ],
    [
      "Always keep local capture logs after a successful rollout",
      "Always remove local capture logs after a successful rollout",
    ],
    [
      "Always retain raw audio evidence after incident review",
      "Always delete raw audio evidence after incident review",
    ],
    [
      "Always activate screen capture during a team demo",
      "Always deactivate screen capture during a team demo",
    ],
    [
      "Always permit installer downloads from the release page",
      "Always forbid installer downloads from the release page",
    ],
    [
      "Always encrypt detailed audit logs before cloud upload",
      "Never encrypt detailed audit logs before cloud upload",
    ],
    [
      "Require local approval before deleting captured evidence",
      "Do not require local approval before deleting captured evidence",
    ],
  ] as const;

  for (const [left, right] of pairs) {
    assert.equal(claimTextSimilarity(left, right), 0, `${left} <> ${right}`);
    assert.equal(
      consolidate([
        claim("decision_rule", left, ["e1"]),
        claim("decision_rule", right, ["e2"]),
      ]).length,
      2,
      `${left} and ${right} must remain separate`,
    );
  }
});

test("directive guard does not broadly oppose unrelated or compound rules", () => {
  assert.equal(
    explicitDirectiveConflict(
      "Enable detailed audit logging in production",
      "Disable detailed metrics collection in production",
    ),
    false,
  );
  assert.equal(
    explicitDirectiveConflict(
      "Enable audit logging but disable telemetry",
      "Enable audit logging but disable telemetry",
    ),
    false,
  );
  assert.equal(
    explicitDirectiveConflict("Do not disable audit logging", "Enable audit logging"),
    false,
    "negating a negative directive agrees with the positive rule",
  );
  assert.equal(
    explicitDirectiveConflict("Never remove audit logs", "Keep audit logs"),
    false,
    "a generic negation must not reverse an agreeing antonym directive",
  );
});

test("correction verdicts are true last-write-wins", () => {
  const raw = [claim("decision_rule", "Use the raw rule", ["e1", "e2"] )];
  const targetId = raw[0]!.id;
  const corrections = [
    { id: "edit", targetKind: "claim" as const, targetId, verdict: "edited" as const, origin: "human" as const, correctedText: "Use the replacement", createdTs: "1" },
    { id: "confirm", targetKind: "claim" as const, targetId, verdict: "confirmed" as const, origin: "human" as const, createdTs: "2" },
  ];
  assert.equal(consolidate(raw, { corrections })[0]?.canonical, "Use the raw rule");
});

test("never merges across kinds", () => {
  const claims = [
    claim("taste_rule", "validate via conversational checks", ["e1"]),
    claim("decision_rule", "validate via conversational checks", ["e2"]), // same words, different kind
  ];
  assert.equal(consolidate(claims).length, 2);
});

test("merging is monotonic — confidence never drops below the strongest member", () => {
  const claims = [
    claim("know_how", "uses disk cached anthropic client for free deterministic reruns", ["e1"], 0.75),
    claim("know_how", "uses a disk-cached anthropic client to make reruns free and deterministic", ["e2"], 0.75),
  ];
  const [entry] = consolidate(claims);
  assert.ok(entry!.confidence >= 0.75, "noisy-OR raises, never lowers");
});

test("one-off claims are kept and labelled provisional, not deleted", () => {
  const claims = [
    claim("decision_rule", "Chose not to auto-commit the agent output", ["e1"]), // single episode
    claim("workflow_pattern", "propose then adversarial judge then synthesize", ["e1", "e2"]),
  ];
  const profile = consolidate(claims);
  const oneOff = profile.find((p) => /auto-commit/.test(p.canonical))!;
  assert.equal(oneOff.tier, "provisional");
  const recurring = profile.find((p) => /adversarial/.test(p.canonical))!;
  assert.equal(recurring.tier, "durable");
});

test("evidence coverage is fully preserved — no episode's signal is lost", () => {
  const claims = [
    claim("taste_rule", "prefers conversational status checks over logs", ["e1"]),
    claim("taste_rule", "prefers conversational status checks rather than log inspection", ["e2"]),
    claim("decision_rule", "avoids polling manually", ["e3"]),
    claim("know_how", "wires memO as opt-in with cost caps", ["e4", "e5"]),
  ];
  const profile = consolidate(claims);
  const cov = evidenceCoverage(claims, profile);
  assert.equal(cov.dropped.length, 0, "every source episode is still represented");
  assert.equal(cov.rawEpisodes, cov.profileEpisodes);
});
