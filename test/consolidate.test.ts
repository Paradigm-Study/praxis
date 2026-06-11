import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidate, evidenceCoverage } from "../src/memory/consolidate.ts";
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
