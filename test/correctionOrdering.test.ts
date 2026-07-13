import assert from "node:assert/strict";
import { test } from "node:test";
import type { Episode, Observation } from "../src/core/types.ts";
import { retrieveLongTermContext } from "../src/agent/retrieve.ts";
import {
  applyCorrections,
  trustedClaims,
} from "../src/memory/consolidate.ts";
import { buildGraph } from "../src/memory/graph.ts";
import { action, freshStore } from "./helpers.ts";

const TS = "2026-07-13T12:00:00.000Z";

test("same-timestamp reject then confirm follows insertion order through trust", () => {
  const store = freshStore();
  try {
    const corrected = action({
      id: "ordering_action",
      action: "corrected_agent",
      startTs: TS,
      text: "Prefer database migrations before production rollouts.",
    });
    const episode: Episode = {
      id: "ordering_episode",
      type: "context_episode",
      startTs: TS,
      endTs: TS,
      summary: "Set the safe rollout order",
      actions: [corrected.id],
      artifacts: [],
      decisionPoints: [],
      rejectedPaths: [],
      uncertainty: [],
    };
    store.actions.put(corrected);
    store.episodes.put(episode);
    const target = buildGraph(store).claims.find(
      (claim) => claim.kind === "decision_rule",
    );
    assert.ok(target);

    // The ids are intentionally reverse-lexical. Ordering by id would make the
    // earlier rejection win; insertion order must make confirmation latest.
    store.corrections.put({
      id: "zz_reject_first",
      targetKind: "claim",
      targetId: target.id,
      verdict: "rejected",
      origin: "human",
      createdTs: TS,
    });
    store.corrections.put({
      id: "aa_confirm_second",
      targetKind: "claim",
      targetId: target.id,
      verdict: "confirmed",
      origin: "human",
      createdTs: TS,
    });

    const expected = ["rejected", "confirmed"];
    assert.deepEqual(store.corrections.all().map((item) => item.verdict), expected);
    assert.deepEqual(
      store.corrections.byTarget(target.id).map((item) => item.verdict),
      expected,
    );
    assert.deepEqual(
      store.corrections.recent(2).map((item) => item.verdict),
      expected,
    );
    assert.equal(store.corrections.recent(1)[0]?.verdict, "confirmed");

    const corrections = store.corrections.all();
    assert.equal(applyCorrections([target], corrections)[0]?.id, target.id);
    const rebuilt = buildGraph(store);
    assert.equal(rebuilt.claims.some((claim) => claim.id === target.id), true);
    assert.equal(rebuilt.nodes.some((node) => node.claimId === target.id), true);
    assert.equal(
      trustedClaims(store.claims.all(), corrections).some(
        (claim) => claim.id === target.id,
      ),
      true,
    );

    const observation: Observation = {
      id: "ordering_context",
      bundleId: "ordering_bundle",
      intent: "Plan database migrations before production rollouts.",
      acceptedOptions: [],
      rejectedOptions: [],
      uncertainty: [],
      evidence: [],
      model: "test",
      createdTs: TS,
    };
    assert.equal(
      retrieveLongTermContext(store, observation).some(
        (claim) => claim.id === target.id,
      ),
      true,
      "the final confirmation restores the claim to trusted retrieval",
    );
  } finally {
    store.close();
  }
});
