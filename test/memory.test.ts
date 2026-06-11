import { test } from "node:test";
import assert from "node:assert/strict";
import { fullPipeline, freshStore } from "./helpers.ts";
import { buildGraph } from "../src/memory/graph.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";

test("model observations become role-agnostic claims (a non-code session)", () => {
  const store = freshStore();
  store.episodes.put({
    id: "episode_x", type: "context_episode",
    startTs: "2026-06-10T12:00:00.000Z", endTs: "2026-06-10T12:05:00.000Z",
    summary: "SDR qualifying a lead", actions: [], artifacts: [],
    decisionPoints: [], rejectedPaths: [], uncertainty: [],
  });
  store.observations.put({
    id: "obs_x", bundleId: "b", episodeId: "episode_x",
    intent: "qualifying a lead",
    inferredPreference: "Researches the company on LinkedIn before the first outreach",
    decisionPoint: "Qualifies on budget before booking a meeting",
    acceptedOptions: ["personalized first line"],
    rejectedOptions: ["generic template blast"],
    uncertainty: [], evidence: [], model: "claude-sonnet-4-6",
    createdTs: "2026-06-10T12:05:00.000Z",
  });
  const { claims } = buildGraph(store, { newId: makeSeededIdGen() });
  assert.ok(claims.some((c) => c.kind === "taste_rule" && /LinkedIn/.test(c.text)));
  assert.ok(claims.some((c) => c.kind === "decision_rule" && /budget/.test(c.text)));
  assert.ok(claims.some((c) => c.kind === "know_how" && /personalized/.test(c.text)));
  assert.ok(claims.some((c) => c.kind === "decision_rule" && /Avoids.*generic/i.test(c.text)));
  assert.ok(!claims.some((c) => c.kind === "artifact_type"), "no code-template noise on non-code work");
  store.close();
});

test("decision_rule claim matches the design doc", async () => {
  const { graph } = await fullPipeline();
  const rule = graph.claims.find((c) => c.kind === "decision_rule");
  assert.ok(rule);
  assert.equal(
    rule!.text,
    "Prefer evidence-backed action reconstruction over video-only inference.",
  );
  assert.ok(rule!.confidence >= 0.85);
});

test("every claim links to at least one evidence episode", async () => {
  const { graph } = await fullPipeline();
  assert.ok(graph.claims.length >= 5);
  for (const c of graph.claims) {
    assert.ok(c.evidenceEpisodes.length >= 1, `claim ${c.kind} has no evidence`);
  }
});

test("workflow reused across days raises confidence + adds reused_across_days edges", async () => {
  const { graph } = await fullPipeline(); // two days
  const wf = graph.claims.find((c) => c.kind === "workflow_pattern");
  assert.ok(wf);
  assert.equal(wf!.evidenceEpisodes.length, 2);
  assert.ok(wf!.confidence > 0.8, `expected raised confidence, got ${wf!.confidence}`);
  assert.ok(graph.edges.some((e) => e.kind === "reused_across_days"));
});

test("graph wires typed edges (observed/caused/followed/contradicted)", async () => {
  const { graph } = await fullPipeline();
  const kinds = new Set(graph.edges.map((e) => e.kind));
  for (const k of [
    "observed_in_episode",
    "caused_file_change",
    "followed_passed_test",
    "contradicted_by_correction",
  ]) {
    assert.ok(kinds.has(k), `missing edge kind ${k}`);
  }
});
