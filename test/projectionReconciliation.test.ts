import assert from "node:assert/strict";
import { test } from "node:test";
import { makeIngest } from "../src/capture/ingest.ts";
import { fuse } from "../src/fuser/fuser.ts";
import { buildGraph } from "../src/memory/graph.ts";
import { reconstruct } from "../src/reconstructor/reconstructor.ts";
import type { ActionEvent, Episode } from "../src/core/types.ts";
import { action, freshStore } from "./helpers.ts";

const T0 = "2026-07-13T12:00:00.000Z";

function uncertainError(id: string, text: string, ts: string): ActionEvent {
  return action({
    id,
    action: "encountered_error",
    app: "Terminal",
    startTs: ts,
    text,
    confidence: 0.5,
    uncertainty: ["needs verification"],
    payload: { signalKinds: ["terminal_error"] },
  });
}

function episode(id: string, actionIds: string[], ts: string, artifacts: string[] = []): Episode {
  return {
    id,
    type: "context_episode",
    startTs: ts,
    endTs: ts,
    summary: "Uncertain activity",
    actions: actionIds,
    artifacts,
    decisionPoints: [],
    rejectedPaths: [],
    uncertainty: [],
  };
}

test("rolling action reconciliation retracts stale interpretations but preserves raw events and corrections", () => {
  const store = freshStore();
  try {
    makeIngest(store).ingest({
      ts: T0,
      source: "terminal",
      app: "Terminal",
      window: "tests",
      type: "command_run",
      payload: {
        cmd: "npm test",
        exitCode: 1,
        output: "TypeError: boom\n    at run (src/example.ts:12:5)",
      },
    });
    store.actions.put(uncertainError("stale_window_action", "stale OCR", T0));
    store.actions.put(uncertainError(
      "historical_action",
      "older retained evidence",
      "2026-07-13T10:00:00.000Z",
    ));
    store.corrections.put({
      id: "correction_stale",
      origin: "human",
      targetKind: "action",
      targetId: "stale_window_action",
      verdict: "rejected",
      createdTs: "2026-07-13T12:01:00.000Z",
    });
    const rawCount = store.events.count();

    const projected = reconstruct(store, {
      range: { startTs: "2026-07-13T11:00:00.000Z" },
      reconcile: true,
    });
    assert.ok(projected.some((item) => item.action === "encountered_error"));
    assert.equal(store.actions.get("stale_window_action"), undefined);
    assert.ok(store.actions.get("historical_action"), "outside-range history is preserved");
    assert.equal(store.events.count(), rawCount, "raw evidence is immutable");
    assert.equal(store.corrections.byTarget("stale_window_action").length, 1);
  } finally {
    store.close();
  }
});

test("rolling reconstruction keeps one meeting when paired audio crosses the cutoff", () => {
  const store = freshStore();
  const ingest = makeIngest(store).ingest;
  try {
    ingest({
      ts: "2026-07-13T12:00:00.000Z",
      source: "audio",
      app: "Zoom",
      window: "Team call",
      type: "transcript_segment",
      payload: { channel: "system", text: "Here is the release plan." },
    });
    reconstruct(store);
    assert.equal(store.actions.range().filter((item) => item.action === "listened_audio").length, 1);

    ingest({
      ts: "2026-07-13T12:00:04.000Z",
      source: "audio",
      app: "Zoom",
      window: "Team call",
      type: "transcript_segment",
      payload: { channel: "mic", text: "I agree, let us ship phase one." },
    });
    reconstruct(store, {
      range: { startTs: "2026-07-13T12:00:02.000Z" },
      reconcile: true,
    });
    const audio = store.actions.range().filter((item) =>
      ["attended_meeting", "listened_audio", "spoke_aloud"].includes(item.action)
    );
    assert.equal(audio.length, 1);
    assert.equal(audio[0]!.action, "attended_meeting");
    assert.equal(audio[0]!.startTs, "2026-07-13T12:00:00.000Z");
  } finally {
    store.close();
  }
});

test("a meeting longer than the rolling horizon keeps full coverage, ids, and review links", () => {
  const store = freshStore();
  const ingest = makeIngest(store).ingest;
  const ts = (seconds: number) =>
    new Date(Date.parse(T0) + seconds * 1000).toISOString();
  const appendMeeting = (fromSeconds: number, throughSeconds: number) => {
    for (let seconds = fromSeconds; seconds <= throughSeconds; seconds += 10) {
      const channel = seconds % 20 === 0 ? "system" : "mic";
      ingest({
        ts: ts(seconds),
        source: "audio",
        app: "Zoom",
        window: "Architecture review",
        type: "transcript_segment",
        payload: {
          channel,
          text:
            channel === "system"
              ? `Remote architecture update at ${seconds} seconds.`
              : `Local implementation response at ${seconds} seconds.`,
        },
      });
    }
  };

  try {
    // Materialize the first thirty minutes, as the startup/full-history tick
    // would, then attach human/model history to the resulting episode.
    appendMeeting(0, 30 * 60);
    reconstruct(store);
    const initialMeeting = store.actions
      .range()
      .find((item) => item.action === "attended_meeting");
    assert.ok(initialMeeting);
    const initialEpisode = fuse(store)[0];
    assert.ok(initialEpisode);
    store.observations.put({
      id: "long_meeting_observation",
      bundleId: "long_meeting_bundle",
      episodeId: initialEpisode.id,
      intent: "Architecture review in progress",
      uncertainty: [],
      acceptedOptions: [],
      rejectedOptions: [],
      evidence: initialMeeting.evidence,
      model: "mock",
      createdTs: ts(30 * 60),
    });
    store.corrections.put({
      id: "long_meeting_review",
      origin: "human",
      targetKind: "episode",
      targetId: initialEpisode.id,
      verdict: "confirmed",
      createdTs: ts(30 * 60 + 1),
    });

    // At 45 minutes, a 30-minute live window plus the fixed 10-minute
    // correlation pre-roll begins five minutes after the true meeting start.
    // The persisted crossing action must extend the raw read back to time zero.
    appendMeeting(30 * 60 + 10, 45 * 60);
    reconstruct(store, {
      range: { startTs: ts(15 * 60) },
      reconcile: true,
    });
    const meetings = store.actions
      .range()
      .filter((item) => item.action === "attended_meeting");
    assert.equal(meetings.length, 1);
    assert.equal(meetings[0]!.id, initialMeeting.id, "the evidence anchor remains stable");
    assert.equal(meetings[0]!.startTs, T0);
    assert.equal(
      meetings[0]!.endTs,
      ts(45 * 60),
      "the full 45-minute span remains covered",
    );

    const episodes = fuse(store);
    assert.equal(episodes.length, 1);
    assert.equal(
      episodes[0]!.id,
      initialEpisode.id,
      "the reviewed episode is not re-keyed",
    );
    assert.equal(store.observations.byEpisode(initialEpisode.id).length, 1);
    assert.equal(store.corrections.byTarget(initialEpisode.id).length, 1);
  } finally {
    store.close();
  }
});

test("rolling reconstruction retains the failed run that establishes a retry", () => {
  const store = freshStore();
  const ingest = makeIngest(store).ingest;
  try {
    ingest({
      ts: "2026-07-13T12:00:00.000Z",
      source: "terminal",
      app: "Terminal",
      window: "tests",
      type: "command_run",
      payload: { cmd: "pnpm test", exitCode: 1, output: "tests failed" },
    });
    reconstruct(store);
    ingest({
      ts: "2026-07-13T12:09:00.000Z",
      source: "terminal",
      app: "Terminal",
      window: "tests",
      type: "command_run",
      payload: { cmd: "pnpm test", exitCode: 0, output: "tests passed" },
    });
    reconstruct(store, {
      range: { startTs: "2026-07-13T12:05:00.000Z" },
      reconcile: true,
    });
    const retries = store.actions.range().filter((item) => item.action === "retried");
    assert.equal(retries.length, 1);
    assert.equal(retries[0]!.startTs, "2026-07-13T12:00:00.000Z");
    assert.equal(retries[0]!.endTs, "2026-07-13T12:09:00.000Z");
  } finally {
    store.close();
  }
});

test("rolling reconstruction retains conversational context before the cutoff", () => {
  const store = freshStore();
  const ingest = makeIngest(store).ingest;
  try {
    ingest({
      ts: "2026-07-13T12:00:00.000Z",
      source: "accessibility",
      app: "ChatGPT",
      window: "Project chat",
      type: "conversation_bubble_added",
      payload: { role: "assistant", text: "We should rely on video-only inference for this decision." },
    });
    reconstruct(store);
    ingest({
      ts: "2026-07-13T12:02:00.000Z",
      source: "accessibility",
      app: "ChatGPT",
      window: "Project chat",
      type: "conversation_bubble_added",
      payload: { role: "user", text: "No, do not rely on video-only inference." },
    });
    reconstruct(store, {
      range: { startTs: "2026-07-13T12:01:00.000Z" },
      reconcile: true,
    });
    const corrections = store.actions.range().filter((item) => item.action === "corrected_agent");
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0]!.startTs, "2026-07-13T12:00:00.000Z");
    assert.match(corrections[0]!.text ?? "", /do not rely on video-only inference/i);
  } finally {
    store.close();
  }
});

test("filtered or partial reconstructions cannot destructively reconcile", () => {
  const store = freshStore();
  try {
    assert.throws(
      () => reconstruct(store, { range: { sources: ["terminal"] }, reconcile: true }),
      /cannot reconcile actions/,
    );
  } finally {
    store.close();
  }
});

test("episode reconciliation removes obsolete projections without cascading human history", () => {
  const store = freshStore();
  try {
    store.actions.put(action({
      id: "active_action",
      action: "edited_file",
      startTs: T0,
      payload: { path: "src/example.ts" },
    }));
    store.episodes.put(episode("obsolete_episode", [], "2026-07-13T11:00:00.000Z"));
    store.corrections.put({
      id: "episode_feedback",
      origin: "human",
      targetKind: "episode",
      targetId: "obsolete_episode",
      verdict: "rejected",
      createdTs: "2026-07-13T11:05:00.000Z",
    });
    store.observations.put({
      id: "historical_observation",
      bundleId: "bundle",
      episodeId: "obsolete_episode",
      uncertainty: [],
      acceptedOptions: [],
      rejectedOptions: [],
      evidence: [],
      model: "mock",
      createdTs: "2026-07-13T11:04:00.000Z",
    });

    const active = fuse(store);
    assert.equal(active.length, 1);
    assert.equal(store.episodes.get("obsolete_episode"), undefined);
    assert.equal(store.episodes.count(), 1);
    assert.equal(store.corrections.byTarget("obsolete_episode").length, 1);
    assert.equal(store.observations.get("historical_observation")?.episodeId, "obsolete_episode");
  } finally {
    store.close();
  }
});

test("rejecting an action suppresses its candidates across duplicate episode projections", () => {
  const store = freshStore();
  try {
    const corrected = action({
      id: "corrected_action",
      action: "corrected_agent",
      startTs: T0,
      text: "Prefer evidence-backed reconstruction",
      payload: { rejects: "video-only inference" },
    });
    store.actions.put(corrected);
    store.episodes.put(episode("episode_a", [corrected.id], corrected.startTs));
    store.episodes.put(episode("episode_b", [corrected.id], "2026-07-14T12:00:00.000Z"));
    buildGraph(store);
    assert.equal(store.claims.byKind("decision_rule").length, 1);

    store.corrections.put({
      id: "action_feedback",
      origin: "human",
      targetKind: "action",
      targetId: corrected.id,
      verdict: "rejected",
      createdTs: "2026-07-13T12:11:00.000Z",
    });
    const rebuilt = buildGraph(store);
    assert.equal(rebuilt.claims.length, 0);
    assert.equal(store.claims.count(), 0);
    assert.deepEqual(store.graph.counts(), { nodes: 0, edges: 0 });
  } finally {
    store.close();
  }
});

test("a failed graph rebuild rolls back the complete materialized projection", () => {
  const store = freshStore();
  try {
    const first = action({
      id: "first_projection_action",
      action: "corrected_agent",
      startTs: T0,
      text: "Prefer evidence-backed reconstruction",
      payload: { rejects: "video-only inference" },
    });
    store.actions.put(first);
    store.episodes.put(episode("first_projection_episode", [first.id], T0));
    buildGraph(store);
    const before = {
      claims: store.claims.all(),
      nodes: store.graph.nodes(),
      edges: store.graph.edges(),
    };

    const second = action({
      id: "second_projection_action",
      action: "corrected_agent",
      startTs: "2026-07-14T12:00:00.000Z",
      text: "Always verify the backup before migration",
      payload: { rejects: "unverified migration" },
    });
    store.actions.put(second);
    store.episodes.put(episode(
      "second_projection_episode",
      [second.id],
      "2026-07-14T12:00:00.000Z",
    ));
    const originalPutNode = store.graph.putNode;
    store.graph.putNode = () => {
      throw new Error("injected projection failure");
    };
    assert.throws(() => buildGraph(store), /injected projection failure/);
    store.graph.putNode = originalPutNode;

    assert.deepEqual(store.claims.all(), before.claims);
    assert.deepEqual(store.graph.nodes(), before.nodes);
    assert.deepEqual(store.graph.edges(), before.edges);
  } finally {
    store.close();
  }
});

test("a nested graph rebuild does not commit its caller-owned transaction", () => {
  const store = freshStore();
  try {
    const candidate = action({
      id: "nested_projection_action",
      action: "corrected_agent",
      startTs: T0,
      text: "Prefer evidence-backed reconstruction",
      payload: { rejects: "video-only inference" },
    });
    store.actions.put(candidate);
    store.episodes.put(episode("nested_projection_episode", [candidate.id], T0));

    store.db.exec("BEGIN IMMEDIATE");
    buildGraph(store);
    assert.equal(store.db.isTransaction, true);
    assert.equal(store.claims.count(), 1);
    store.db.exec("ROLLBACK");

    assert.equal(store.claims.count(), 0);
    assert.deepEqual(store.graph.counts(), { nodes: 0, edges: 0 });
  } finally {
    if (store.db.isTransaction) store.db.exec("ROLLBACK");
    store.close();
  }
});

test("editing an action cannot preserve its false semantic kind in memory", () => {
  const store = freshStore();
  try {
    const falseCorrection = action({
      id: "false_corrected_agent",
      action: "corrected_agent",
      startTs: T0,
      text: "Prefer deleting the existing route",
      payload: { rejects: "keeping the route" },
    });
    store.actions.put(falseCorrection);
    store.episodes.put(episode("episode_false_action", [falseCorrection.id], T0));
    assert.ok(buildGraph(store).claims.some((claim) => claim.kind === "decision_rule"));
    store.corrections.put({
      id: "action_reinterpretation",
      origin: "human",
      targetKind: "action",
      targetId: falseCorrection.id,
      verdict: "edited",
      correctedText: "I was only reading the proposed route change.",
      createdTs: "2026-07-13T12:01:00.000Z",
    });
    const rebuilt = buildGraph(store).claims;
    assert.deepEqual(rebuilt, []);
  } finally {
    store.close();
  }
});

test("answering or dismissing a decision question does not confirm or rewrite evidence actions", () => {
  const store = freshStore();
  try {
    const corrected = action({
      id: "corrected_action",
      action: "corrected_agent",
      startTs: T0,
      text: "Prefer evidence-backed reconstruction",
      payload: { rejects: "video-only inference" },
    });
    store.actions.put(corrected);
    store.episodes.put(episode("episode_a", [corrected.id], corrected.startTs));
    const before = buildGraph(store).claims.find((claim) => claim.kind === "decision_rule")!;
    store.decisions.put({
      id: "decision_error",
      kind: "ask_expert",
      reason: "verify",
      question: "Was this interpretation right?",
      evidence: [corrected.id],
      createdTs: "2026-07-13T12:11:00.000Z",
    });
    store.corrections.put({
      id: "decision_answer",
      origin: "human",
      targetKind: "decision",
      targetId: "decision_error",
      verdict: "edited",
      correctedText: "No — that was only on screen",
      createdTs: "2026-07-13T12:12:00.000Z",
    });
    const after = buildGraph(store).claims.find((claim) => claim.kind === "decision_rule")!;
    assert.equal(after.id, before.id);
    assert.equal(after.text, before.text);
    assert.equal(after.confidence, before.confidence);
  } finally {
    store.close();
  }
});

test("generic episode rejection suppresses all candidates derived from that episode", () => {
  const store = freshStore();
  try {
    const corrected = action({
      id: "corrected_action",
      action: "corrected_agent",
      startTs: T0,
      text: "Prefer evidence-backed reconstruction",
      payload: { rejects: "video-only inference" },
    });
    store.actions.put(corrected);
    store.episodes.put(episode("episode_a", [corrected.id], T0));
    buildGraph(store);
    assert.ok(store.claims.count() > 0);
    store.corrections.put({
      id: "episode_rejection",
      origin: "human",
      targetKind: "episode",
      targetId: "episode_a",
      verdict: "rejected",
      createdTs: "2026-07-13T12:01:00.000Z",
    });
    const rebuilt = buildGraph(store);
    assert.equal(rebuilt.claims.length, 0);
    assert.equal(store.claims.count(), 0);

    store.corrections.put({
      id: "later_workflow_review",
      origin: "human",
      targetKind: "episode",
      targetId: "episode_a",
      verdict: "edited",
      correctedText: JSON.stringify({
        schema: "paradigm.workflow.review.v1",
        title: "Reviewed workflow",
        steps: [{ id: "step_1", title: "Review evidence", actor: "person" }],
      }),
      note: "paradigm.workflow.review.v1",
      createdTs: "2026-07-13T12:02:00.000Z",
    });
    assert.equal(
      buildGraph(store).claims.length,
      0,
      "workflow review cannot accidentally unmask a generic episode rejection",
    );
  } finally {
    store.close();
  }
});

test("editing an episode replaces inferred claims with the authored meaning", () => {
  const store = freshStore();
  try {
    const corrected = action({
      id: "episode_action",
      action: "corrected_agent",
      startTs: T0,
      text: "Prefer the speculative path",
    });
    store.actions.put(corrected);
    store.episodes.put(episode("episode_edit", [corrected.id], T0));
    assert.ok(buildGraph(store).claims.some((claim) => /speculative path/.test(claim.text)));
    store.corrections.put({
      id: "episode_meaning",
      origin: "human",
      targetKind: "episode",
      targetId: "episode_edit",
      verdict: "edited",
      correctedText: "This session only compared rollout options; it set no standing rule.",
      createdTs: "2026-07-13T12:01:00.000Z",
    });
    const rebuilt = buildGraph(store).claims;
    assert.deepEqual(rebuilt, []);
  } finally {
    store.close();
  }
});

test("rejected observations retract their model-derived claims", () => {
  const store = freshStore();
  try {
    const submitted = action({
      id: "observation_evidence",
      action: "submitted_message",
      startTs: T0,
      text: "Qualify the lead before scheduling.",
    });
    store.actions.put(submitted);
    store.episodes.put(episode("episode_a", [submitted.id], T0));
    store.observations.put({
      id: "observation_a",
      bundleId: "bundle_a",
      episodeId: "episode_a",
      intent: "qualify a lead",
      decisionPoint: "Qualifies budget before scheduling",
      acceptedOptions: [],
      rejectedOptions: [],
      uncertainty: [],
      evidence: [submitted.id],
      model: "claude",
      createdTs: T0,
    });
    assert.equal(buildGraph(store).claims.some((claim) => claim.kind === "decision_rule"), true);
    store.corrections.put({
      id: "observation_rejection",
      origin: "human",
      targetKind: "observation",
      targetId: "observation_a",
      verdict: "rejected",
      createdTs: "2026-07-13T12:01:00.000Z",
    });
    assert.equal(buildGraph(store).claims.some((claim) => claim.kind === "decision_rule"), false);
    assert.equal(buildGraph(store).claims.some((claim) => claim.kind === "decision_rule"), false);
    assert.deepEqual(store.graph.counts(), { nodes: 0, edges: 0 });
  } finally {
    store.close();
  }
});

test("claim rejection and editing remain stable overrides across full rebuilds", () => {
  const store = freshStore();
  try {
    const corrected = action({
      id: "corrected_action",
      action: "corrected_agent",
      startTs: T0,
      text: "Prefer evidence-backed reconstruction",
      payload: { rejects: "video-only inference" },
    });
    store.actions.put(corrected);
    store.episodes.put(episode("episode_a", [corrected.id], T0));
    const target = buildGraph(store).claims.find((claim) => claim.kind === "decision_rule")!;
    store.corrections.put({
      id: "claim_rejection",
      origin: "human",
      targetKind: "claim",
      targetId: target.id,
      verdict: "rejected",
      createdTs: "2026-07-13T12:01:00.000Z",
    });
    assert.equal(buildGraph(store).claims.some((claim) => claim.id === target.id), false);
    assert.equal(buildGraph(store).claims.some((claim) => claim.id === target.id), false);
    assert.equal(store.graph.nodes().some((node) => node.claimId === target.id), false);

    store.corrections.put({
      id: "claim_edit",
      origin: "human",
      targetKind: "claim",
      targetId: target.id,
      verdict: "edited",
      correctedText: "Prefer directly verified evidence over visual inference.",
      createdTs: "2026-07-13T12:02:00.000Z",
    });
    for (let index = 0; index < 2; index += 1) {
      const rebuilt = buildGraph(store);
      assert.equal(
        rebuilt.claims.find((claim) => claim.id === target.id)?.text,
        "Prefer directly verified evidence over visual inference.",
      );
      assert.equal(
        store.graph.nodes().find((node) => node.claimId === target.id)?.label,
        "Prefer directly verified evidence over visual inference.",
      );
    }
  } finally {
    store.close();
  }
});

test("full graph rebuild removes stale claims, nodes, and edges of every kind", () => {
  const store = freshStore();
  try {
    for (const [index, kind] of [
      "workflow_pattern",
      "artifact_type",
      "unresolved_question",
    ].entries()) {
      const claimId = `stale_claim_${index}`;
      const nodeId = `stale_node_${index}`;
      store.claims.put({
        id: claimId,
        kind: kind as "workflow_pattern" | "artifact_type" | "unresolved_question",
        text: `stale ${kind}`,
        confidence: 0.9,
        evidenceEpisodes: ["missing_episode"],
        createdTs: T0,
        updatedTs: T0,
      });
      store.graph.putNode({
        id: nodeId,
        kind,
        label: `stale ${kind}`,
        confidence: 0.9,
        claimId,
        createdTs: T0,
        updatedTs: T0,
      });
      store.graph.putEdge({
        id: `stale_edge_${index}`,
        from: nodeId,
        to: "missing_episode",
        kind: "observed_in_episode",
        createdTs: T0,
      });
    }
    buildGraph(store);
    assert.equal(store.claims.count(), 0);
    assert.deepEqual(store.graph.counts(), { nodes: 0, edges: 0 });
  } finally {
    store.close();
  }
});

test("uncertain action interpretations remain review items and never become claim memory", () => {
  const store = freshStore();
  try {
    const legacy = action({
      id: "legacy_uncertain_correction",
      action: "corrected_agent",
      startTs: T0,
      text: "Prefer deleting the existing route",
      confidence: 0.8,
      uncertainty: ["The visible text may only quote an earlier instruction"],
      payload: { rejects: "keeping the route" },
    });
    store.actions.put(legacy);
    store.episodes.put(episode("legacy_episode", [legacy.id], T0));
    buildGraph(store);
    assert.equal(buildGraph(store).claims.length, 0);
    assert.equal(store.claims.count(), 0);
  } finally {
    store.close();
  }
});

test("dismissing an action question does not reject or promote the uncertain action", () => {
  const store = freshStore();
  try {
    const uncertain = action({
      id: "uncertain_action",
      action: "corrected_agent",
      startTs: T0,
      text: "Prefer deleting the route",
      confidence: 0.8,
      uncertainty: ["needs review"],
    });
    store.actions.put(uncertain);
    store.episodes.put(episode("episode_uncertain", [uncertain.id], T0));
    store.corrections.put({
      id: "dismiss_action_question",
      origin: "human",
      targetKind: "action",
      targetId: uncertain.id,
      verdict: "rejected",
      note: "question-dismissed:prefer deleting the route",
      createdTs: "2026-07-13T12:01:00.000Z",
    });
    assert.equal(buildGraph(store).claims.length, 0);

    store.corrections.put({
      id: "confirm_action_later",
      origin: "human",
      targetKind: "action",
      targetId: uncertain.id,
      verdict: "confirmed",
      createdTs: "2026-07-13T12:02:00.000Z",
    });
    assert.ok(buildGraph(store).claims.some((claim) => /deleting the route/.test(claim.text)));
  } finally {
    store.close();
  }
});
