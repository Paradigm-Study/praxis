import { test } from "node:test";
import assert from "node:assert/strict";
import {
  consolidate,
  applyCorrections,
  evidenceCoverage,
  priorityOf,
} from "../src/memory/consolidate.ts";
import { renderSkill, skillStats } from "../src/transfer/skill.ts";
import type { Claim, Correction } from "../src/core/types.ts";

function claim(kind: string, text: string, eps: string[], conf = 0.8): Claim {
  return {
    id: "c_" + text.slice(0, 10).replace(/\s/g, "") + eps.join(""),
    kind, text, confidence: conf, evidenceEpisodes: eps,
    createdTs: "t", updatedTs: "t",
  };
}
function correction(targetId: string, verdict: Correction["verdict"], correctedText?: string): Correction {
  return {
    id: "corr_" + targetId + verdict,
    targetKind: "claim",
    targetId,
    verdict,
    origin: "human",
    correctedText,
    createdTs: "t",
  };
}

// ---------------------------------------------------------------------------
// Priority tiers (dot-skill's "Layer 0 never violate")
// ---------------------------------------------------------------------------

test("priorityOf: corrections are hard; durable high-conf decisions are hard", () => {
  assert.equal(priorityOf("correction", "provisional", 0.5), "hard");
  assert.equal(priorityOf("decision_rule", "durable", 0.9), "hard");
});

test("priorityOf: durable→strong, provisional→soft, questions→context", () => {
  assert.equal(priorityOf("taste_rule", "durable", 0.7), "strong");
  assert.equal(priorityOf("decision_rule", "durable", 0.7), "strong"); // durable but <0.8 conf
  assert.equal(priorityOf("taste_rule", "provisional", 0.9), "soft");
  assert.equal(priorityOf("unresolved_question", "durable", 0.9), "context");
});

test("consolidate stamps every entry with a priority tier", () => {
  const profile = consolidate([
    claim("decision_rule", "Always run tests before committing", ["e1", "e2"], 0.9),
    claim("taste_rule", "Prefers terse prose", ["e1"]),
    claim("unresolved_question", "Why did they skip the lint step?", ["e3"]),
  ]);
  const byKind = (k: string) => profile.find((p) => p.kind === k)!;
  assert.equal(byKind("decision_rule").priority, "hard");
  assert.equal(byKind("taste_rule").priority, "soft"); // one episode → provisional → soft
  assert.equal(byKind("unresolved_question").priority, "context");
});

// ---------------------------------------------------------------------------
// Correction feedback (dot-skill's correction_handler) — NON-DESTRUCTIVE
// ---------------------------------------------------------------------------

test("applyCorrections: rejected claim is dropped, edited claim is rewritten, raw is untouched", () => {
  const raw = [
    claim("taste_rule", "WRONG inferred preference", ["e1"]),
    claim("decision_rule", "vague guess about a decision", ["e2"], 0.6),
  ];
  const corrections = [
    correction(raw[0]!.id, "rejected"),
    correction(raw[1]!.id, "edited", "Caps the agent's benchmark spend before running"),
  ];
  const out = applyCorrections(raw, corrections);
  assert.equal(out.length, 1, "rejected claim removed from the view");
  assert.equal(out[0]!.text, "Caps the agent's benchmark spend before running", "edited text wins");
  assert.ok(out[0]!.confidence >= 0.9, "a user edit is strong signal");
  assert.equal(out[0]!.provenance, "human_reviewed", "review trust survives bounded correction views");
  // Non-destructive: the input array and its claims are unchanged.
  assert.equal(raw.length, 2, "raw list not mutated");
  assert.equal(raw[1]!.text, "vague guess about a decision", "raw claim object not mutated");
  assert.equal(raw[1]!.provenance, undefined, "raw claim trust is not mutated");
});

test("applyCorrections: confirmation decorates the effective claim as human reviewed", () => {
  const raw = [claim("taste_rule", "Prefers compact status updates", ["e1"])];
  const out = applyCorrections(raw, [correction(raw[0]!.id, "confirmed")]);
  assert.equal(out[0]?.provenance, "human_reviewed");
  assert.equal(raw[0]?.provenance, undefined, "the stored derivation remains unchanged");
});

test("rejected claims are absent from the consolidated profile", () => {
  const raw = [
    claim("taste_rule", "Prefers dark mode everywhere", ["e1"]),
    claim("taste_rule", "Hates semicolons", ["e2"]),
  ];
  const corrections = [correction(raw[1]!.id, "rejected")];
  const profile = consolidate(raw, { corrections });
  assert.ok(!profile.some((p) => /semicolons/.test(p.canonical)), "rejected claim gone");
  assert.ok(profile.some((p) => /dark mode/.test(p.canonical)), "others kept");
});

test("evidenceCoverage treats a rejected episode as intentional, not lost signal", () => {
  const raw = [
    claim("taste_rule", "good claim", ["e1"]),
    claim("decision_rule", "rejected claim", ["e2"]),
  ];
  const corrections = [correction(raw[1]!.id, "rejected")];
  const profile = consolidate(raw, { corrections });
  const cov = evidenceCoverage(raw, profile, corrections);
  assert.equal(cov.dropped.length, 0, "the user-rejected episode does NOT count as lost");
});

// ---------------------------------------------------------------------------
// Skill rendering — the portable SKILL.md
// ---------------------------------------------------------------------------

function sampleProfile() {
  return consolidate([
    claim("decision_rule", "Always reconstruct actions from evidence, never trust model-only inference", ["e1", "e2"], 0.9),
    claim("taste_rule", "Prefers conversational status checks over inspecting raw logs", ["e1", "e3"], 0.82),
    claim("workflow_pattern", "Workflow: propose → adversarial judge → synthesize → commit", ["e1", "e2"], 0.88),
    claim("know_how", "Uses a disk-cached client to make reruns free and deterministic", ["e2"], 0.7),
    claim("unresolved_question", "Unsure why the benchmark step was skipped", ["e4"], 0.5),
  ]);
}

test("renderSkill produces valid frontmatter and all layers", () => {
  const md = renderSkill(sampleProfile(), { generatedTs: "2026-06-10T00:00:00Z" });
  assert.match(md, /^---\nname: how-i-work\n/, "starts with YAML frontmatter + slug");
  assert.match(md, /user-invocable: true/);
  assert.match(md, /allowed-tools: Read, Write, Edit, Bash/);
  assert.match(md, /## Layer 0 — Hard constraints/);
  assert.match(md, /## Layer 1 — Decision rules & strong preferences/);
  assert.match(md, /## Layer 2 — Workflow & know-how/);
  assert.match(md, /## Layer 3 — Soft signals/);
  assert.match(md, /## Layer 4 — Open questions/);
});

test("provisional one-offs are quarantined to the soft layer, not Layer 1", () => {
  const md = renderSkill(sampleProfile(), { generatedTs: "t" });
  const l1 = md.slice(md.indexOf("Layer 1"), md.indexOf("Layer 2"));
  // The durable taste rule belongs in Layer 1; the one-off know-how does not.
  assert.match(l1, /conversational status checks/, "durable preference in Layer 1");
  assert.ok(!/disk-cached/.test(l1), "the one-off know-how is NOT in Layer 1");
  const soft = md.slice(md.indexOf("Layer 3"), md.indexOf("Layer 4"));
  assert.match(soft, /disk-cached/, "the one-off know-how is quarantined to soft signals");
});

test("renderSkill places a durable high-conf decision rule in Layer 0 and shows evidence", () => {
  const md = renderSkill(sampleProfile(), { generatedTs: "t" });
  const l0 = md.slice(md.indexOf("Layer 0"), md.indexOf("Layer 1"));
  assert.match(l0, /never trust model-only inference/, "the hard decision rule is in Layer 0");
  assert.match(l0, /confidence 0\.9\d?, 2 episodes/, "evidence count + confidence shown");
});

test("renderSkill renders a workflow as numbered steps", () => {
  const md = renderSkill(sampleProfile(), { generatedTs: "t" });
  assert.match(md, /1\. propose/);
  assert.match(md, /2\. adversarial judge/);
  assert.match(md, /4\. commit/);
});

test("durableOnly drops one-off provisional traits", () => {
  const profile = sampleProfile();
  const full = renderSkill(profile, { generatedTs: "t" });
  const durable = renderSkill(profile, { generatedTs: "t", durableOnly: true });
  assert.match(full, /benchmark step was skipped/, "open question present in full export");
  assert.ok(!/benchmark step was skipped/.test(durable), "provisional dropped in durable-only");
  assert.match(durable, /never trust model-only inference/, "durable rules survive");
});

test("custom name/title flow into the frontmatter and H1", () => {
  const md = renderSkill(sampleProfile(), { generatedTs: "t", name: "Ada's Workflow", title: "How Ada Ships" });
  assert.match(md, /\nname: ada-s-workflow\n/, "name is slugified");
  assert.match(md, /\n# How Ada Ships\n/);
});

test("empty profile renders a safe, valid skill (no crash, Layer 0 placeholder)", () => {
  const md = renderSkill([], { generatedTs: "t" });
  assert.match(md, /^---\nname: how-i-work/);
  assert.match(md, /None learned yet/);
  assert.equal(skillStats([]).entries, 0);
});
