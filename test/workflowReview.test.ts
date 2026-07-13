import assert from "node:assert/strict";
import { test } from "node:test";
import type { Server } from "node:http";
import type { Correction, Episode } from "../src/core/types.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import { buildGraph } from "../src/memory/graph.ts";
import { buildPlaybook } from "../src/transfer/transfer.ts";
import { startStudio } from "../src/studio/server.ts";
import {
  parseWorkflowReview,
  WORKFLOW_REVIEW_NOTE,
  WORKFLOW_REVIEW_SCHEMA,
} from "../src/workflow/review.ts";
import { action, freshStore } from "./helpers.ts";

function episode(): Episode {
  return {
    id: "episode_review",
    type: "context_episode",
    startTs: "2026-06-10T10:00:00.000Z",
    endTs: "2026-06-10T10:05:00.000Z",
    summary: "Implemented and checked a change",
    actions: ["act_prompt", "act_edit", "act_test"],
    artifacts: ["src/example.ts"],
    decisionPoints: [],
    rejectedPaths: [],
    uncertainty: [],
  };
}

function review(steps: string[], createdTs = "2026-06-10T10:06:00.000Z"): Correction {
  return {
    id: `corr_${createdTs}_${steps[0]}`,
    targetKind: "episode",
    targetId: "episode_review",
    verdict: "edited",
    origin: "human",
    correctedText: JSON.stringify({
      schema: WORKFLOW_REVIEW_SCHEMA,
      title: "Ship a safe change",
      intent: "Change behavior without regressions",
      steps: steps.map((title, index) => ({
        id: `step_${index}`,
        title,
        actor: index === 0 ? "person" : "agent",
      })),
    }),
    note: WORKFLOW_REVIEW_NOTE,
    createdTs,
  };
}

function seededStore() {
  const store = freshStore();
  store.actions.put(action({ id: "act_prompt", action: "submitted_message", startTs: "2026-06-10T10:00:00.000Z" }));
  store.actions.put(action({ id: "act_edit", action: "edited_file", startTs: "2026-06-10T10:01:00.000Z" }));
  store.actions.put(action({ id: "act_test", action: "ran_command", startTs: "2026-06-10T10:02:00.000Z" }));
  store.episodes.put(episode());
  return store;
}

async function portOf(server: Server): Promise<number> {
  if (!server.address()) await new Promise((resolve) => server.once("listening", resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("workflow review envelope is strict and bounded", () => {
  assert.equal(parseWorkflowReview("not json"), undefined);
  assert.equal(parseWorkflowReview(JSON.stringify({ schema: WORKFLOW_REVIEW_SCHEMA, title: "x", steps: [] })), undefined);
  assert.equal(parseWorkflowReview(review(["Inspect", "Edit"]).correctedText)?.steps.length, 2);
});

test("a reviewed procedure replaces the heuristic workflow claim", () => {
  const store = seededStore();
  try {
    store.corrections.put(review(["Inspect evidence", "Make the smallest edit", "Verify outcome"]));
    const graph = buildGraph(store, { persist: false, newId: makeSeededIdGen() });
    const workflows = graph.claims.filter((claim) => claim.kind === "workflow_pattern");
    assert.equal(workflows.length, 1);
    assert.equal(workflows[0]?.text, "Workflow: Inspect evidence → Make the smallest edit → Verify outcome");
    assert.equal(workflows[0]?.confidence, 0.99);
    buildGraph(store, { newId: makeSeededIdGen() });
    assert.equal(store.claims.byKind("workflow_pattern").length, 1);
    assert.equal(store.graph.nodes().filter((node) => node.kind === "workflow_pattern").length, 1);
  } finally {
    store.close();
  }
});

test("rejecting one episode removes its edges from a shared workflow claim", () => {
  const store = freshStore();
  let sequence = 0;
  const newId = (prefix: string) => `${prefix}_${++sequence}`;
  const seed = (episodeId: string, day: string) => {
    const actions = ["submitted_message", "edited_file", "ran_command"].map((actionType, index) => {
      const id = `${episodeId}_action_${index}`;
      store.actions.put(action({
        id,
        action: actionType,
        startTs: `${day}T10:0${index}:00.000Z`,
        ...(actionType === "edited_file" ? { payload: { path: "src/example.ts" } } : {}),
      }));
      return id;
    });
    store.episodes.put({
      id: episodeId,
      type: "context_episode",
      startTs: `${day}T10:00:00.000Z`,
      endTs: `${day}T10:03:00.000Z`,
      summary: "Implemented and checked a change",
      actions,
      artifacts: ["src/example.ts"],
      decisionPoints: [],
      rejectedPaths: [],
      uncertainty: [],
    });
  };

  try {
    seed("episode_a", "2026-06-10");
    seed("episode_b", "2026-06-11");
    buildGraph(store, { newId });
    const before = store.claims.byKind("workflow_pattern")[0]!;
    assert.deepEqual(before.evidenceEpisodes, ["episode_a", "episode_b"]);

    store.corrections.put({
      id: "corr_reject_a",
      targetKind: "episode",
      targetId: "episode_a",
      verdict: "rejected",
      origin: "human",
      note: WORKFLOW_REVIEW_NOTE,
      createdTs: "2026-06-12T10:00:00.000Z",
    });
    buildGraph(store, { newId });

    const after = store.claims.byKind("workflow_pattern")[0]!;
    assert.deepEqual(after.evidenceEpisodes, ["episode_b"]);
    const node = store.graph.nodes().find((item) => item.claimId === after.id)!;
    const observedEpisodes = store.graph.incident(node.id)
      .filter((edge) => edge.from === node.id && edge.kind === "observed_in_episode")
      .map((edge) => edge.to);
    assert.deepEqual(observedEpisodes, ["episode_b"]);
    assert.equal(
      store.graph.incident(node.id).some((edge) => edge.from === node.id && edge.to === "episode_a"),
      false,
    );
    assert.equal(
      store.graph.incident(node.id).some((edge) => edge.kind === "reused_across_days"),
      false,
      "single-day evidence must not retain the former multi-day reuse edge",
    );
  } finally {
    store.close();
  }
});

test("correction API round-trips into graph, playbook, and joined workflow evidence", async () => {
  const store = seededStore();
  buildGraph(store, { newId: makeSeededIdGen() });
  const server = startStudio(store, 0);
  const port = await portOf(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const proposed = review(["Frame the intent", "Do the work", "Verify the result"]);
    const response = await fetch(`${base}/api/correction`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        targetKind: proposed.targetKind,
        targetId: proposed.targetId,
        verdict: proposed.verdict,
        correctedText: proposed.correctedText,
        note: proposed.note,
      }),
    });
    assert.equal(response.status, 200);
    const playbook = await fetch(`${base}/api/playbook`).then((item) => item.json()) as { workflow: string[] };
    assert.deepEqual(playbook.workflow, ["Frame the intent", "Do the work", "Verify the result"]);
    const evidence = await fetch(`${base}/api/workflows?limit=1`).then((item) => item.json()) as {
      items: Array<{ episode: Episode; actions: Array<{ id: string }> }>;
      nextCursor: string | null;
    };
    assert.equal(evidence.items[0]?.episode.id, "episode_review");
    assert.deepEqual(evidence.items[0]?.actions.map((action) => action.id), ["act_prompt", "act_edit", "act_test"]);
    assert.equal(evidence.nextCursor, null);
    assert.equal(store.claims.byKind("workflow_pattern")[0]?.text, "Workflow: Frame the intent → Do the work → Verify the result");
  } finally {
    await close(server);
    store.close();
  }
});

test("workflow correction and graph materialization roll back together on failure", async () => {
  const store = seededStore();
  const originalPutEdge = store.graph.putEdge;
  store.graph.putEdge = () => { throw new Error("injected graph write failure"); };
  const server = startStudio(store, 0);
  const base = `http://127.0.0.1:${await portOf(server)}`;
  try {
    const proposed = review(["Frame the intent", "Do the work", "Verify the result"]);
    const response = await fetch(`${base}/api/correction`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify(proposed),
    });
    assert.equal(response.status, 500);
    assert.equal(store.corrections.all().length, 0);
    assert.equal(store.claims.count(), 0);
    assert.deepEqual(store.graph.counts(), { nodes: 0, edges: 0 });
  } finally {
    store.graph.putEdge = originalPutEdge;
    await close(server);
    store.close();
  }
});

test("the latest human review is the operable playbook workflow", () => {
  const store = seededStore();
  try {
    buildGraph(store, { newId: makeSeededIdGen() });
    store.corrections.put(review(["Old first step", "Old second step"]));
    store.corrections.put(review(["Frame the outcome", "Perform the work", "Check the result"], "2026-06-10T10:07:00.000Z"));
    assert.deepEqual(buildPlaybook(store).workflow, [
      "Frame the outcome",
      "Perform the work",
      "Check the result",
    ]);
  } finally {
    store.close();
  }
});
