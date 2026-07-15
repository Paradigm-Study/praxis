import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleForEpisode, buildBundle } from "../src/observer/bundle.ts";
import { MockObserver } from "../src/observer/observer.ts";
import { decide } from "../src/agent/policy.ts";
import { AgentLoop } from "../src/agent/loop.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import { action, fullPipeline, freshStore, ingestFixtures } from "./helpers.ts";

test("offline loop does not manufacture actionable decisions for the Studio", async () => {
  const store = freshStore();
  await ingestFixtures(store);
  // Wide window so the (dated) fixtures are reconstructed; mock observer.
  const loop = new AgentLoop(store, {
    observer: new MockObserver(),
    newId: makeSeededIdGen(),
    windowMs: 10 * 365 * 86_400_000,
  });
  const r = await loop.tick();
  assert.ok(r, "first tick should observe (not throttled)");
  assert.notEqual(r.decision.kind, "ask_expert");
  assert.notEqual(r.decision.kind, "mark_uncertainty");
  const recent = store.decisions.recent(5);
  assert.equal(
    recent.some((decision) => decision.kind === "ask_expert" || decision.kind === "mark_uncertainty"),
    false,
    "offline reconstruction must not manufacture questions",
  );

  // Idle/duplicate ticks must not pile up decision rows (throttle + stable ids).
  await loop.tick();
  await loop.tick();
  assert.equal(store.decisions.recent(99).length, recent.length, "decisions must not grow");
  store.close();
});

test("bundle surfaces OCR'd screen text", async () => {
  const { store, episodes, newId } = await fullPipeline();
  const bundle = bundleForEpisode(store, episodes[0]!, newId);
  assert.ok(
    bundle.frameText.some((t) => /exact action reconstruction/.test(t)),
    "expected OCR text from the captured frame in the bundle",
  );
});

test("includeImages attaches only genuine images (magic-byte sniffed)", async () => {
  const { store, episodes, newId } = await fullPipeline();
  const ep = episodes[0]!;

  // The fixtures' fake "PNGDATA:…" frames must be filtered out — a corrupt
  // blob sent as an image block would fail the whole API request.
  const noReal = buildBundle(store, {
    endTs: ep.endTs, windowSeconds: 600, includeImages: true, newId,
  });
  assert.equal(noReal.frameImages?.length ?? 0, 0);

  // A frame with real PNG magic bytes IS included, with the sniffed type.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("praxis-test-frame"),
  ]);
  const { makeIngest } = await import("../src/capture/ingest.ts");
  makeIngest(store).ingest({
    ts: ep.endTs, source: "screen_video", app: "Codex", window: "Codex",
    type: "frame", payload: { ocrText: "real frame" },
    blobs: [{ kind: "image", data: png }],
  });
  const withReal = buildBundle(store, {
    endTs: ep.endTs, windowSeconds: 600, includeImages: true, newId,
  });
  assert.equal(withReal.frameImages?.length, 1);
  assert.equal(withReal.frameImages![0]!.mediaType, "image/png");
  assert.ok(withReal.frameImages![0]!.base64.length > 0);
});

test("observer output is evidence-linked, never raw fact", async () => {
  const { store, episodes, newId } = await fullPipeline();
  const ep = episodes[0]!;
  const bundle = bundleForEpisode(store, ep, newId);
  const obs = await new MockObserver().observe(bundle, { episodeId: ep.id, newId });

  assert.ok(obs.evidence.length >= 1, "observation must cite evidence");
  assert.equal(obs.model, "mock");
  assert.ok(obs.intent && obs.intent.length > 0);
  assert.deepEqual(obs.acceptedOptions, []);
  assert.deepEqual(obs.rejectedOptions, []);
  assert.equal(obs.suggestedQuestion, undefined);
});

test("policy asks only when a semantic observation cites consequential activity", () => {
  const grounded = action({
    id: "action_decision",
    action: "corrected_agent",
    startTs: "2026-06-10T12:00:00.000Z",
    text: "Use the evidence-backed approach",
  });
  const obs = {
    id: "obs_semantic",
    bundleId: "bundle_semantic",
    acceptedOptions: [],
    rejectedOptions: [],
    uncertainty: ["The intended rollout order is unclear"],
    suggestedQuestion: "Should the rollout happen before or after the migration?",
    evidence: [grounded.id],
    model: "semantic-test-observer",
    createdTs: "2026-06-10T12:01:00.000Z",
  };
  const decision = decide({
    observation: obs,
    actions: [grounded],
    claims: [],
  });
  assert.equal(decision.kind, "ask_expert");
  assert.equal(decision.question, obs.suggestedQuestion);
});

test("policy does not surface mock-observer uncertainty", () => {
  const uncertain = action({
    action: "edited_file",
    startTs: "2026-06-10T12:00:00.000Z",
    text: "src/index.ts",
    confidence: 0.5,
    uncertainty: ["weak evidence"],
  });
  const decision = decide({
    observation: {
      id: "obs_mock",
      bundleId: "bundle_mock",
      acceptedOptions: [],
      rejectedOptions: [],
      uncertainty: ["weak evidence"],
      suggestedQuestion: "Was this file edit classified correctly?",
      evidence: [uncertain.id],
      model: "mock",
      createdTs: "2026-06-10T12:01:00.000Z",
    },
    actions: [uncertain],
    claims: [],
  });
  assert.equal(decision.kind, "keep_observing");
});

test("policy intervenes in learner mode when advisories exist", async () => {
  const { store, episodes, graph, newId } = await fullPipeline();
  const ep = episodes[0]!;
  const bundle = bundleForEpisode(store, ep, newId);
  const obs = await new MockObserver().observe(bundle, { episodeId: ep.id, newId });
  const decision = decide({
    observation: obs,
    actions: [],
    claims: graph.claims,
    learnerMode: true,
    advisories: ["tests should precede commit"],
  });
  assert.equal(decision.kind, "intervene");
  assert.deepEqual(decision.advisories, ["tests should precede commit"]);
});
