import { test } from "node:test";
import assert from "node:assert/strict";
import { toMs } from "../src/core/time.ts";
import { fullPipeline } from "./helpers.ts";

/**
 * The Definition of Success from the design doc — Praxis must be able to answer
 * each of these from the ledger, with evidence. One assertion per question.
 */
test("Definition of Success: all answerable with evidence", async () => {
  const { store, actions, episodes, graph } = await fullPipeline();
  const ep = episodes[0]!;

  // What did the user do?
  assert.ok(actions.length > 0);

  // In what order? (actions are time-sorted)
  for (let i = 1; i < actions.length; i++) {
    assert.ok(toMs(actions[i]!.startTs) >= toMs(actions[i - 1]!.startTs));
  }

  // In which app/tool/artifact?
  assert.ok(actions.every((a) => a.app));
  assert.ok(ep.artifacts.length > 0);

  // What did they reject?
  assert.deepEqual(ep.rejectedPaths, ["video-only inference"]);

  // What did they accept?
  assert.ok(actions.some((a) => a.action === "accepted_suggestion"));

  // What did they correct?
  assert.ok(actions.some((a) => a.action === "corrected_agent"));

  // What pattern does this reveal?
  assert.ok(graph.claims.some((c) => c.kind === "workflow_pattern"));

  // What evidence supports that claim? (claims → episodes → actions → raw events)
  const claim = graph.claims.find((c) => c.kind === "decision_rule")!;
  assert.ok(claim.evidenceEpisodes.length >= 1);
  const evEp = store.episodes.get(claim.evidenceEpisodes[0]!)!;
  const evActions = store.actions.byIds(evEp.actions);
  assert.ok(evActions.length > 0);
  assert.ok(evActions.every((a) => a.evidence.every((id) => store.events.get(id))));

  store.close();
});

test("pipeline is idempotent — re-running never duplicates rows", async () => {
  const { store } = await fullPipeline();
  const a0 = store.actions.count();
  const e0 = store.episodes.count();
  const c0 = store.claims.count();
  // Re-run the derived stages several times (as the live loop does each tick).
  const { reconstruct } = await import("../src/reconstructor/reconstructor.ts");
  const { fuse } = await import("../src/fuser/fuser.ts");
  const { buildGraph } = await import("../src/memory/graph.ts");
  for (let i = 0; i < 4; i++) {
    reconstruct(store);
    fuse(store);
    buildGraph(store);
  }
  assert.equal(store.actions.count(), a0, "action rows must not grow");
  assert.equal(store.episodes.count(), e0, "episode rows must not grow");
  assert.equal(store.claims.count(), c0, "claim rows must not grow");
  store.close();
});

test("blobs are content-addressed and resolvable from events", async () => {
  const { store } = await fullPipeline();
  const withBlob = store.events.range().find((e) => e.blobRefs.length > 0)!;
  assert.ok(store.blobs.has(withBlob.blobRefs[0]!));
  store.close();
});
