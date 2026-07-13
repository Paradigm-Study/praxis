import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "node:test";
import { startStudio } from "../src/studio/server.ts";
import { freshStore } from "./helpers.ts";

async function portOf(server: Server): Promise<number> {
  if (!server.address()) await new Promise((resolve) => server.once("listening", resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function timestamp(index: number): string {
  return new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString();
}

test("desktop snapshot APIs enforce query ceilings, projections, and the Electron byte cap", async () => {
  const store = freshStore();
  const privateMarker = "must-not-cross-snapshot-api";
  const wide = "x".repeat(20_000);
  const medium = "m".repeat(1_000);

  for (let index = 0; index < 450; index += 1) {
    const ts = timestamp(index);
    store.events.append({
      id: `event_${index}`,
      ts,
      source: "synthetic",
      app: "Test",
      window: wide,
      type: "large_snapshot_event",
      payload: { privateMarker, wide },
      blobRefs: Array.from({ length: 40 }, (_, item) => `blob_${item}_${"b".repeat(300)}`),
      hash: `hash_${index}`,
    });
    store.actions.put({
      id: `action_${index}`,
      type: "user_action",
      action: "edited_file",
      app: "Test",
      window: wide,
      startTs: ts,
      endTs: ts,
      text: wide,
      confidence: 0.9,
      evidence: Array.from({ length: 40 }, (_, item) => `event_${item}_${"e".repeat(300)}`),
      uncertainty: Array.from({ length: 20 }, () => medium),
      payload: { privateMarker, wide },
      reconstructedBy: Array.from({ length: 20 }, () => medium),
    });
    if (index < 60) {
      store.decisions.put({
        id: `decision_${index}`,
        kind: "ask_expert",
        reason: wide,
        question: wide,
        evidence: Array.from({ length: 80 }, (_, item) => `event_${item}_${"e".repeat(300)}`),
        createdTs: ts,
      });
    }
    if (index < 250) {
      store.episodes.put({
        id: `episode_${index}`,
        type: "context_episode",
        startTs: ts,
        endTs: ts,
        summary: wide,
        actions: Array.from({ length: 180 }, (_, item) => `action_${index}_${item}_${"a".repeat(200)}`),
        artifacts: Array.from({ length: 50 }, () => medium),
        decisionPoints: Array.from({ length: 30 }, () => medium),
        rejectedPaths: Array.from({ length: 30 }, () => medium),
        uncertainty: Array.from({ length: 30 }, () => medium),
        payload: { privateMarker },
      });
      store.observations.put({
        id: `observation_${index}`,
        bundleId: `bundle_${index}`,
        episodeId: `episode_${index}`,
        intent: wide,
        task: wide,
        decisionPoint: wide,
        acceptedOptions: Array.from({ length: 25 }, () => medium),
        rejectedOptions: Array.from({ length: 25 }, () => medium),
        inferredPreference: wide,
        uncertainty: Array.from({ length: 25 }, () => medium),
        suggestedQuestion: wide,
        options: Array.from({ length: 25 }, () => medium),
        evidence: Array.from({ length: 80 }, (_, item) => `evidence_${item}_${"e".repeat(300)}`),
        model: "test",
        createdTs: ts,
      });
    }
    store.claims.put({
      id: `claim_${index}`,
      kind: "workflow_pattern",
      text: wide,
      confidence: 0.9,
      evidenceEpisodes: Array.from({ length: 80 }, (_, item) => `episode_${item}_${"e".repeat(300)}`),
      ...(index === 449 ? { provenance: "explicit_user_rule" as const } : {}),
      createdTs: ts,
      updatedTs: ts,
    });
    store.graph.putNode({
      id: `node_${index}`,
      kind: "workflow_pattern",
      label: wide,
      confidence: 0.9,
      claimId: `claim_${index}`,
      data: { privateMarker, wide },
      createdTs: ts,
      updatedTs: ts,
    });
    store.graph.putEdge({
      id: `edge_${index}`,
      from: `node_${index}`,
      to: `episode_${index}`,
      kind: "observed_in_episode",
      data: { privateMarker, wide },
      createdTs: ts,
    });
    store.corrections.put({
      id: `correction_${index}`,
      targetKind: "episode",
      targetId: `episode_${index}`,
      verdict: "edited",
      origin: "human",
      correctedText: wide,
      note: wide,
      createdTs: ts,
    });
  }

  const server = startStudio(store, 0);
  const base = `http://127.0.0.1:${await portOf(server)}`;
  try {
    const checks = [
      ["feed", `${base}/api/feed`, 300],
      ["actions", `${base}/api/actions`, 400],
      ["episodes", `${base}/api/episodes?limit=999`, 200],
      ["claims", `${base}/api/claims?limit=999`, 400],
      ["observations", `${base}/api/observations?limit=999`, 200],
      ["corrections", `${base}/api/corrections?limit=999`, 400],
      ["decisions", `${base}/api/decisions`, 50],
    ] as const;
    for (const [name, url, maximum] of checks) {
      const response = await fetch(url);
      const body = await response.text();
      const rows = JSON.parse(body) as unknown[];
      assert.equal(response.status, 200, name);
      assert.ok(rows.length > 0 && rows.length <= maximum, `${name} respects its row ceiling`);
      assert.ok(Buffer.byteLength(body, "utf8") < 5_000_000, `${name} stays under Electron's cap`);
    }

    const feedBody = await fetch(`${base}/api/feed`).then((response) => response.text());
    const feed = JSON.parse(feedBody) as Array<Record<string, unknown>>;
    assert.equal(feedBody.includes(privateMarker), false);
    assert.equal(feed[0]?.id, "event_449", "feed preserves newest rows");
    assert.ok(feed.every((event) => JSON.stringify(event.payload) === "{}"));

    const actionBody = await fetch(`${base}/api/actions`).then((response) => response.text());
    const actions = JSON.parse(actionBody) as Array<Record<string, unknown>>;
    assert.equal(actionBody.includes(privateMarker), false);
    assert.equal(actions[0]?.id, "action_449", "actions preserve newest rows");
    assert.equal(actions.some((action) => Object.hasOwn(action, "payload")), false);

    const questionResponse = await fetch(`${base}/api/questions`);
    const questionBody = await questionResponse.text();
    const questions = JSON.parse(questionBody) as { agent: unknown[]; cards: unknown[] };
    assert.equal(questionResponse.status, 200);
    assert.ok(questions.agent.length <= 8);
    assert.ok(questions.cards.length <= 100);
    assert.ok(Buffer.byteLength(questionBody, "utf8") < 5_000_000);

    const episodeBody = await fetch(`${base}/api/episodes?limit=999`).then((response) => response.text());
    const episodes = JSON.parse(episodeBody) as Array<Record<string, unknown>>;
    assert.equal(episodeBody.includes(privateMarker), false);
    assert.equal(episodes.some((episode) => Object.hasOwn(episode, "payload")), false);
    assert.ok(episodes.some((episode) => episode.id === "episode_249"), "newest episode survives byte trimming");

    const claims = await fetch(`${base}/api/claims?limit=999`).then((response) => response.json()) as Array<{
      id: string;
      provenance?: string;
    }>;
    assert.equal(
      claims.find((claim) => claim.id === "claim_449")?.provenance,
      "explicit_user_rule",
      "claim trust provenance survives the desktop API projection",
    );

    const graphResponse = await fetch(`${base}/api/graph?nodes=999&edges=999`);
    const graphBody = await graphResponse.text();
    const graph = JSON.parse(graphBody) as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };
    assert.equal(graphResponse.status, 200);
    assert.ok(graph.nodes.length > 0 && graph.nodes.length <= 400);
    assert.ok(graph.edges.length > 0 && graph.edges.length <= 400);
    assert.ok(Buffer.byteLength(graphBody, "utf8") < 5_000_000);
    assert.equal(graphBody.includes(privateMarker), false);
    assert.equal(graph.nodes.some((node) => Object.hasOwn(node, "data")), false);
    assert.equal(graph.edges.some((edge) => Object.hasOwn(edge, "data")), false);
  } finally {
    await close(server);
    store.close();
  }
});
