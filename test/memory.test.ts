import { test } from "node:test";
import assert from "node:assert/strict";
import { fullPipeline, freshStore } from "./helpers.ts";
import { buildGraph } from "../src/memory/graph.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import { trustedClaims } from "../src/memory/consolidate.ts";

test("model observations become role-agnostic claims (a non-code session)", () => {
  const store = freshStore();
  store.actions.put({
    id: "action_x", type: "user_action", action: "answered_question", app: "Meet",
    startTs: "2026-06-10T12:00:00.000Z", endTs: "2026-06-10T12:00:01.000Z",
    text: "Qualified the lead", confidence: 0.98, evidence: ["raw_x"],
  });
  store.episodes.put({
    id: "episode_x", type: "context_episode",
    startTs: "2026-06-10T12:00:00.000Z", endTs: "2026-06-10T12:05:00.000Z",
    summary: "SDR qualifying a lead", actions: ["action_x"], artifacts: [],
    decisionPoints: [], rejectedPaths: [], uncertainty: [],
  });
  store.observations.put({
    id: "obs_x", bundleId: "b", episodeId: "episode_x",
    intent: "qualifying a lead",
    inferredPreference: "Researches the company on LinkedIn before the first outreach",
    decisionPoint: "Qualifies on budget before booking a meeting",
    acceptedOptions: ["personalized first line"],
    rejectedOptions: ["generic template blast"],
    uncertainty: [], evidence: ["action_x"], model: "claude-sonnet-4-6",
    createdTs: "2026-06-10T12:05:00.000Z",
  });
  const { claims } = buildGraph(store, { newId: makeSeededIdGen() });
  assert.ok(claims.some((c) => c.kind === "taste_rule" && /LinkedIn/.test(c.text)));
  assert.ok(claims.some((c) => c.kind === "decision_rule" && /budget/.test(c.text)));
  assert.equal(
    claims.some((c) => /personalized first line|generic template blast/i.test(c.text)),
    false,
    "one episode's accepted/rejected options must remain in the episode receipt",
  );
  assert.ok(!claims.some((c) => c.kind === "artifact_type"), "no code-template noise on non-code work");
  store.close();
});

test("observer questions remain in Questions and never become durable memory claims", () => {
  const store = freshStore();
  store.episodes.put({
    id: "episode_question",
    type: "context_episode",
    startTs: "2026-07-13T12:00:00.000Z",
    endTs: "2026-07-13T12:05:00.000Z",
    summary: "reviewing a rollout",
    actions: [],
    artifacts: [],
    decisionPoints: [],
    rejectedPaths: [],
    uncertainty: [],
  });
  store.observations.put({
    id: "obs_question",
    bundleId: "bundle_question",
    episodeId: "episode_question",
    acceptedOptions: [],
    rejectedOptions: [],
    uncertainty: ["The rollout order is unclear"],
    suggestedQuestion: "Should the database migration happen before the rollout?",
    decisionPoint: "Always migrate before rollout",
    inferredPreference: "Prefers risky in-place migrations",
    evidence: [],
    model: "semantic-test-observer",
    createdTs: "2026-07-13T12:05:00.000Z",
  });
  const { claims } = buildGraph(store, { newId: makeSeededIdGen() });
  assert.equal(claims.length, 0, "unresolved speculative fields are not memory");
  store.close();
});

test("historical ambient or dangling observation evidence cannot rebuild semantic memory", () => {
  const store = freshStore();
  try {
    const cases = [
      { id: "ambient", action: "opened_file", evidence: "action_ambient", keep: false },
      { id: "dangling", action: "opened_file", evidence: "missing_action", keep: false },
      { id: "substantive", action: "edited_file", evidence: "action_substantive", keep: true },
    ] as const;
    for (const [index, item] of cases.entries()) {
      const actionId = `action_${item.id}`;
      store.actions.put({
        id: actionId,
        type: "user_action",
        action: item.action,
        app: "Editor",
        startTs: `2026-07-${10 + index}T12:00:00.000Z`,
        endTs: `2026-07-${10 + index}T12:00:01.000Z`,
        text: `${item.id}.ts`,
        confidence: 0.99,
        evidence: [`raw_${item.id}`],
      });
      store.episodes.put({
        id: `episode_${item.id}`,
        type: "context_episode",
        startTs: `2026-07-${10 + index}T12:00:00.000Z`,
        endTs: `2026-07-${10 + index}T12:01:00.000Z`,
        summary: item.id,
        actions: [actionId],
        artifacts: [],
        decisionPoints: [],
        rejectedPaths: [],
        uncertainty: [],
      });
      store.observations.put({
        id: `observation_${item.id}`,
        bundleId: `bundle_${item.id}`,
        episodeId: `episode_${item.id}`,
        decisionPoint: `Decision from ${item.id} evidence`,
        acceptedOptions: [],
        rejectedOptions: [],
        uncertainty: [],
        evidence: [item.evidence],
        model: "legacy-remote-observer",
        createdTs: `2026-07-${10 + index}T12:01:00.000Z`,
      });
    }

    const texts = buildGraph(store).claims.map((claim) => claim.text);
    assert.deepEqual(texts, ["Decision from substantive evidence"]);
  } finally {
    store.close();
  }
});

test("question answers propagate to memory without preserving the speculative proposal", () => {
  const store = freshStore();
  try {
    store.episodes.put({
      id: "episode_answer",
      type: "context_episode",
      startTs: "2026-07-13T12:00:00.000Z",
      endTs: "2026-07-13T12:05:00.000Z",
      summary: "reviewing a rollout",
      actions: [],
      artifacts: [],
      decisionPoints: [],
      rejectedPaths: [],
      uncertainty: [],
    });
    store.observations.put({
      id: "obs_answer",
      bundleId: "bundle_answer",
      episodeId: "episode_answer",
      decisionPoint: "Always migrate before rollout",
      inferredPreference: "Prefers risky in-place migrations",
      acceptedOptions: [],
      rejectedOptions: [],
      uncertainty: ["The rollout order is unclear"],
      suggestedQuestion: "Should the database migration happen before the rollout?",
      evidence: [],
      model: "semantic-test-observer",
      createdTs: "2026-07-13T12:05:00.000Z",
    });
    store.decisions.put({
      id: "decision_answer",
      kind: "ask_expert",
      reason: "verify",
      question: "Should the database migration happen before the rollout?",
      observationId: "obs_answer",
      evidence: [],
      createdTs: "2026-07-13T12:05:01.000Z",
    });
    assert.equal(buildGraph(store).claims.length, 0);

    store.corrections.put({
      id: "corr_answer",
      targetKind: "decision",
      targetId: "decision_answer",
      verdict: "edited",
      origin: "human",
      correctedText: "Back up first, migrate second, then roll out.",
      createdTs: "2026-07-13T12:06:00.000Z",
    });
    const answered = buildGraph(store).claims;
    assert.deepEqual(answered.map((claim) => claim.text), [
      "Answer to “Should the database migration happen before the rollout?”: Back up first, migrate second, then roll out.",
    ]);
    assert.equal(answered[0]?.kind, "decision_heuristic");
    assert.equal(answered[0]?.evidenceEpisodes.length, 1);
    assert.deepEqual(
      trustedClaims(answered, store.corrections.all()),
      [],
      "a contextual answer stays provisional until repeated or claim-reviewed",
    );

    store.corrections.put({
      id: "corr_dismiss",
      targetKind: "decision",
      targetId: "decision_answer",
      verdict: "rejected",
      origin: "human",
      createdTs: "2026-07-13T12:07:00.000Z",
    });
    assert.equal(buildGraph(store).claims.length, 0, "dismissal retracts the prior answer");
  } finally {
    store.close();
  }
});

test("correction wording cannot promote ordinary follow-ups into trusted memory", () => {
  const store = freshStore();
  try {
    const putCorrection = (id: string, text: string, day: string) => {
      const actionId = `action_${id}`;
      store.actions.put({
        id: actionId,
        type: "user_action",
        action: "corrected_agent",
        app: "Claude Code",
        startTs: `${day}T12:00:00.000Z`,
        endTs: `${day}T12:00:01.000Z`,
        text,
        confidence: 0.98,
        evidence: [`raw_${id}`],
      });
      store.episodes.put({
        id: `episode_${id}`,
        type: "context_episode",
        startTs: `${day}T12:00:00.000Z`,
        endTs: `${day}T12:01:00.000Z`,
        summary: text,
        actions: [actionId],
        artifacts: [],
        decisionPoints: [],
        rejectedPaths: [],
        uncertainty: [],
      });
    };
    putCorrection("actually", "Actually, what time is it?", "2026-07-11");
    putCorrection("stop", "Stop the dev server.", "2026-07-12");
    putCorrection("choice", "Actually, keep the existing route instead.", "2026-07-13");
    putCorrection("dont", "Don't do that.", "2026-07-14");
    putCorrection("dont_file", "No, don't delete that file.", "2026-07-15");

    const claims = buildGraph(store).claims;
    assert.deepEqual(claims.map((claim) => claim.text).sort(), [
      "Contextual correction: don't delete that file.",
      "Contextual choice: keep the existing route instead.",
    ].sort());
    assert.deepEqual(trustedClaims(claims, store.corrections.all()), []);
  } finally {
    store.close();
  }
});

test("latest observation wins without same-episode confidence inflation or overriding an answer", () => {
  const store = freshStore();
  try {
    store.episodes.put({
      id: "episode_repeat",
      type: "context_episode",
      startTs: "2026-07-13T12:00:00.000Z",
      endTs: "2026-07-13T12:05:00.000Z",
      summary: "database review",
      actions: [],
      artifacts: [],
      decisionPoints: [],
      rejectedPaths: [],
      uncertainty: [],
    });
    const base = {
      bundleId: "bundle_repeat",
      episodeId: "episode_repeat",
      acceptedOptions: [],
      rejectedOptions: [],
      evidence: [],
      model: "semantic-test-observer",
    };
    store.observations.put({
      ...base,
      id: "obs_early",
      decisionPoint: "Always deploy before migrating",
      uncertainty: ["order unclear"],
      suggestedQuestion: "Should deployment happen before migration?",
      createdTs: "2026-07-13T12:01:00.000Z",
    });
    store.decisions.put({
      id: "decision_repeat",
      kind: "ask_expert",
      reason: "verify",
      question: "Should deployment happen before migration?",
      observationId: "obs_early",
      evidence: [],
      createdTs: "2026-07-13T12:01:01.000Z",
    });
    store.corrections.put({
      id: "answer_repeat",
      targetKind: "decision",
      targetId: "decision_repeat",
      verdict: "edited",
      origin: "human",
      correctedText: "No",
      createdTs: "2026-07-13T12:01:02.000Z",
    });
    store.observations.put({
      ...base,
      id: "obs_latest",
      decisionPoint: "Deploy before migrating",
      uncertainty: [],
      createdTs: "2026-07-13T12:02:00.000Z",
    });
    const claims = buildGraph(store).claims;
    assert.deepEqual(claims.map((claim) => claim.text), [
      "Answer to “Should deployment happen before migration?”: No",
    ]);
    assert.equal(claims[0]?.kind, "decision_heuristic");
  } finally {
    store.close();
  }
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

test("conservative paraphrases harden across episodes while opposite choices stay distinct", () => {
  const store = freshStore();
  try {
    for (const [id, day, preference] of [
      ["episode_pref_1", "2026-07-12", "Prefers lightweight conversational status checks over inspecting logs"],
      ["episode_pref_2", "2026-07-13", "Strongly prefers conversational status checks rather than manual log inspection"],
      ["episode_opposite", "2026-07-14", "Prefers inspecting logs over conversational status checks"],
    ] as const) {
      const actionId = `action_${id}`;
      store.actions.put({
        id: actionId,
        type: "user_action",
        action: "edited_file",
        app: "Editor",
        startTs: `${day}T12:00:00.000Z`,
        endTs: `${day}T12:00:01.000Z`,
        text: `${id}.md`,
        confidence: 0.98,
        evidence: [`raw_${id}`],
      });
      store.episodes.put({
        id,
        type: "context_episode",
        startTs: `${day}T12:00:00.000Z`,
        endTs: `${day}T12:05:00.000Z`,
        summary: "status review",
        actions: [actionId],
        artifacts: [],
        decisionPoints: [],
        rejectedPaths: [],
        uncertainty: [],
      });
      store.observations.put({
        id: `obs_${id}`,
        bundleId: `bundle_${id}`,
        episodeId: id,
        inferredPreference: preference,
        acceptedOptions: [],
        rejectedOptions: [],
        uncertainty: [],
        evidence: [actionId],
        model: "semantic-test-observer",
        createdTs: `${day}T12:05:00.000Z`,
      });
    }
    const preferences = buildGraph(store).claims.filter((claim) => claim.kind === "taste_rule");
    assert.equal(preferences.length, 2);
    const recurring = preferences.find((claim) => claim.evidenceEpisodes.length === 2);
    assert.ok(recurring);
    assert.ok(recurring.confidence > 0.9);
    assert.ok(preferences.some((claim) => /inspecting logs over conversational/.test(claim.text)));
  } finally {
    store.close();
  }
});

test("graph keeps explicit opposite directives as separate memory rules", () => {
  const pairs = [
    [
      "Always enable detailed audit logs for production rollout",
      "Always disable detailed audit logs for production rollout",
    ],
    [
      "Always allow external display context during team demos",
      "Always disallow external display context during team demos",
    ],
    [
      "Always include screen images in cloud observer context",
      "Always exclude screen images from cloud observer context",
    ],
    [
      "Always keep local capture logs after a successful rollout",
      "Always remove local capture logs after a successful rollout",
    ],
    [
      "Always retain raw audio evidence after incident review",
      "Always delete raw audio evidence after incident review",
    ],
    [
      "Always encrypt detailed audit logs before cloud upload",
      "Never encrypt detailed audit logs before cloud upload",
    ],
    [
      "Require local approval before deleting captured evidence",
      "Do not require local approval before deleting captured evidence",
    ],
  ] as const;

  for (const [pairIndex, pair] of pairs.entries()) {
    const store = freshStore();
    try {
      for (const [sideIndex, rule] of pair.entries()) {
        const id = `${pairIndex}_${sideIndex}`;
        const day = `2026-07-${String(10 + sideIndex).padStart(2, "0")}`;
        const actionId = `action_directive_${id}`;
        const episodeId = `episode_directive_${id}`;
        store.actions.put({
          id: actionId,
          type: "user_action",
          action: "edited_file",
          app: "Editor",
          startTs: `${day}T12:00:00.000Z`,
          endTs: `${day}T12:00:01.000Z`,
          text: `directive-${id}.md`,
          confidence: 0.98,
          evidence: [`raw_directive_${id}`],
        });
        store.episodes.put({
          id: episodeId,
          type: "context_episode",
          startTs: `${day}T12:00:00.000Z`,
          endTs: `${day}T12:05:00.000Z`,
          summary: "reviewing an explicit capture rule",
          actions: [actionId],
          artifacts: [],
          decisionPoints: [],
          rejectedPaths: [],
          uncertainty: [],
        });
        store.observations.put({
          id: `observation_directive_${id}`,
          bundleId: `bundle_directive_${id}`,
          episodeId,
          decisionPoint: rule,
          acceptedOptions: [],
          rejectedOptions: [],
          uncertainty: [],
          evidence: [actionId],
          model: "semantic-test-observer",
          createdTs: `${day}T12:05:00.000Z`,
        });
      }

      const first = buildGraph(store).claims.filter((claim) => claim.kind === "decision_rule");
      assert.equal(first.length, 2, `${pair[0]} <> ${pair[1]}`);
      assert.deepEqual(new Set(first.map((claim) => claim.text)), new Set(pair));
      assert.ok(first.every((claim) => claim.evidenceEpisodes.length === 1));

      const firstIds = new Set(first.map((claim) => claim.id));
      const rebuilt = buildGraph(store).claims.filter((claim) => claim.kind === "decision_rule");
      assert.equal(rebuilt.length, 2);
      assert.deepEqual(new Set(rebuilt.map((claim) => claim.id)), firstIds);
    } finally {
      store.close();
    }
  }
});

test("graph wires evidence and outcome edges without inventing correction nodes", async () => {
  const { graph } = await fullPipeline();
  const kinds = new Set(graph.edges.map((e) => e.kind));
  for (const k of [
    "observed_in_episode",
    "caused_file_change",
    "followed_passed_test",
  ]) {
    assert.ok(kinds.has(k), `missing edge kind ${k}`);
  }
});
