import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionEvent, Episode } from "../src/core/types.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import { buildGraph } from "../src/memory/graph.ts";
import { action, freshStore } from "./helpers.ts";

const EPISODE_COUNT = 120;

function edgeIdentity(from: string, to: string, kind: string): string {
  return JSON.stringify([from, to, kind]);
}

test("large graph rebuild uses bounded snapshots instead of per-edge lookups", () => {
  const store = freshStore();
  try {
    const actions: ActionEvent[] = [];
    const episodes: Episode[] = [];
    for (let index = 0; index < EPISODE_COUNT; index += 1) {
      const ts = new Date(Date.UTC(2026, 0, index + 1, 12)).toISOString();
      const prefix = `scale_${index}`;
      const episodeActions = [
        action({
          id: `${prefix}_prompt`,
          action: "submitted_message",
          startTs: ts,
          text: "Implement the verified change.",
        }),
        action({
          id: `${prefix}_edit`,
          action: "edited_file",
          startTs: ts,
          text: `src/feature-${index}.ts`,
          payload: { path: `src/feature-${index}.ts` },
        }),
        action({
          id: `${prefix}_test`,
          action: "ran_command",
          startTs: ts,
          text: "pnpm test",
          payload: { exitCode: 0 },
        }),
        action({
          id: `${prefix}_commit`,
          action: "committed",
          startTs: ts,
          text: "Commit verified change",
        }),
      ];
      actions.push(...episodeActions);
      episodes.push({
        id: `${prefix}_episode`,
        type: "context_episode",
        startTs: ts,
        endTs: ts,
        summary: "Implement and verify a change",
        actions: episodeActions.map((item) => item.id),
        artifacts: [`src/feature-${index}.ts`],
        decisionPoints: [],
        rejectedPaths: [],
        uncertainty: [],
      });
    }
    store.actions.putMany(actions);
    store.episodes.putMany(episodes);

    const first = buildGraph(store, { newId: makeSeededIdGen() });
    assert.ok(first.edges.length > EPISODE_COUNT * 4, "fixture produces a large edge projection");
    const firstEdgeIds = new Map(
      first.edges.map((edge) => [
        edgeIdentity(edge.from, edge.to, edge.kind),
        edge.id,
      ]),
    );

    let nodeSnapshots = 0;
    let edgeSnapshots = 0;
    let claimSnapshots = 0;
    let edgeLookups = 0;
    let nodeLookups = 0;
    let correctionTargetLookups = 0;
    const readNodes = store.graph.nodes;
    const readEdges = store.graph.edges;
    const readClaims = store.claims.all;
    const findEdge = store.graph.findEdge;
    const findNode = store.graph.findNode;
    const correctionsByTarget = store.corrections.byTarget;
    store.graph.nodes = (limit) => {
      nodeSnapshots += 1;
      return readNodes(limit);
    };
    store.graph.edges = (limit) => {
      edgeSnapshots += 1;
      return readEdges(limit);
    };
    store.claims.all = () => {
      claimSnapshots += 1;
      return readClaims();
    };
    store.graph.findEdge = (from, to, kind) => {
      edgeLookups += 1;
      return findEdge(from, to, kind);
    };
    store.graph.findNode = (kind, label) => {
      nodeLookups += 1;
      return findNode(kind, label);
    };
    store.corrections.byTarget = (targetId) => {
      correctionTargetLookups += 1;
      return correctionsByTarget(targetId);
    };

    const rebuilt = buildGraph(store, { newId: makeSeededIdGen() });
    assert.equal(nodeSnapshots, 1, "nodes are preloaded once");
    assert.equal(edgeSnapshots, 1, "edges are preloaded once");
    assert.equal(claimSnapshots, 1, "claims are preloaded once");
    assert.equal(edgeLookups, 0, "edge identity is resolved from the snapshot map");
    assert.equal(nodeLookups, 0, "node identity is resolved from the snapshot map");
    assert.equal(
      correctionTargetLookups,
      0,
      "workflow reviews use the already-loaded correction snapshot",
    );
    assert.deepEqual(
      new Map(
        rebuilt.edges.map((edge) => [
          edgeIdentity(edge.from, edge.to, edge.kind),
          edge.id,
        ]),
      ),
      firstEdgeIds,
      "snapshot lookup preserves stable edge ids",
    );
  } finally {
    store.close();
  }
});
