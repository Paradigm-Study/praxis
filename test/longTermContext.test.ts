import { test } from "node:test";
import assert from "node:assert/strict";
import type { Claim, Observation } from "../src/core/types.ts";
import { decide } from "../src/agent/policy.ts";
import { retrieveLongTermContext } from "../src/agent/retrieve.ts";
import { AgentLoop } from "../src/agent/loop.ts";
import type { Observer } from "../src/observer/observer.ts";
import { action, freshStore, fullPipeline } from "./helpers.ts";

function claim(partial: Partial<Claim> & { text: string }): Claim {
  return {
    id: partial.id ?? `claim_${partial.text.slice(0, 8)}`,
    kind: partial.kind ?? "decision_rule",
    text: partial.text,
    confidence: partial.confidence ?? 0.9,
    evidenceEpisodes: partial.evidenceEpisodes ?? ["episode_1", "episode_2"],
    createdTs: partial.createdTs ?? "2026-06-01T00:00:00.000Z",
    updatedTs: partial.updatedTs ?? "2026-06-01T00:00:00.000Z",
  };
}

function observation(partial: Partial<Observation>): Observation {
  return {
    id: partial.id ?? "obs_1",
    bundleId: partial.bundleId ?? "bundle_1",
    episodeId: partial.episodeId ?? "episode_1",
    intent: partial.intent,
    task: partial.task,
    decisionPoint: partial.decisionPoint,
    acceptedOptions: partial.acceptedOptions ?? [],
    rejectedOptions: partial.rejectedOptions ?? [],
    inferredPreference: partial.inferredPreference,
    uncertainty: partial.uncertainty ?? [],
    suggestedQuestion: partial.suggestedQuestion,
    options: partial.options,
    evidence: partial.evidence ?? ["action_1"],
    model: partial.model ?? "claude-sonnet-4-6",
    createdTs: partial.createdTs ?? "2026-06-10T12:00:00.000Z",
  };
}

function consequentialAction() {
  return action({
    id: "action_1",
    action: "corrected_agent",
    startTs: "2026-06-10T11:59:00.000Z",
    text: "Choose the database implementation",
  });
}

test("retrieval is bounded to the current situation — relevant claims only", () => {
  const store = freshStore();
  // Long-term memory holds claims about several unrelated topics.
  store.claims.put(claim({ id: "c_db", text: "Prefer Postgres over MySQL for the database." }));
  store.claims.put(claim({ id: "c_edits", kind: "taste_rule", text: "Reviews AI-proposed edits before accepting them." }));
  store.claims.put(claim({ id: "c_lint", kind: "workflow_pattern", text: "Runs the linter before committing." }));

  const obs = observation({
    intent: "Choosing the database engine for the new service.",
    suggestedQuestion: "I think you switched to Postgres for the database. Correct?",
  });

  const relevant = retrieveLongTermContext(store, obs);
  const ids = relevant.map((c) => c.id);
  assert.ok(ids.includes("c_db"), "the database claim is relevant to a database question");
  assert.ok(!ids.includes("c_edits"), "unrelated edit-review claim is excluded");
  assert.ok(!ids.includes("c_lint"), "unrelated linter claim is excluded");
  store.close();
});

test("retrieval is bounded by a limit — not a dump of everything", () => {
  const store = freshStore();
  for (let i = 0; i < 12; i++) {
    store.claims.put(claim({ id: `c_${i}`, text: `Prefer Postgres database approach number ${i}.` }));
  }
  const obs = observation({
    intent: "Choosing the Postgres database engine.",
    suggestedQuestion: "Are we standardizing on the Postgres database?",
  });
  const relevant = retrieveLongTermContext(store, obs, { limit: 3 });
  assert.equal(relevant.length, 3, "retrieval respects the bound");
  store.close();
});

test("long-term context applies claim rejection/editing and excludes one-offs", () => {
  const store = freshStore();
  try {
    store.claims.put(claim({
      id: "context_once",
      text: "Prefer SQLite for the database.",
      evidenceEpisodes: ["episode_once"],
    }));
    const obs = observation({ intent: "Choose a database for the service." });
    assert.deepEqual(retrieveLongTermContext(store, obs), []);
    store.corrections.put({
      id: "context_edit",
      targetKind: "claim",
      targetId: "context_once",
      verdict: "edited",
      origin: "human",
      correctedText: "Prefer Postgres for the service database.",
      createdTs: "2026-07-13T00:00:00.000Z",
    });
    assert.deepEqual(
      retrieveLongTermContext(store, obs).map((item) => item.text),
      ["Prefer Postgres for the service database."],
    );
    store.corrections.put({
      id: "context_reject",
      targetKind: "claim",
      targetId: "context_once",
      verdict: "rejected",
      origin: "human",
      createdTs: "2026-07-13T00:01:00.000Z",
    });
    assert.deepEqual(retrieveLongTermContext(store, obs), []);
  } finally {
    store.close();
  }
});

test("policy avoids re-asking what long-term memory already established", () => {
  const obs = observation({
    uncertainty: ["unsure why the user picked this database"],
    suggestedQuestion: "I think you switched to Postgres for the database. Correct?",
  });
  const established = claim({ text: "Prefer Postgres over MySQL for the database.", confidence: 0.9 });

  const decision = decide({
    observation: obs,
    actions: [consequentialAction()],
    claims: [],
    longTermContext: [established],
  });

  assert.notEqual(decision.kind, "ask_expert", "must not re-ask an already-established thing");
  assert.ok(
    decision.grounding?.some((g) => /Postgres/.test(g)),
    "the decision is grounded in the established long-term fact",
  );
});

test("policy still asks when long-term memory has nothing relevant", () => {
  const obs = observation({
    uncertainty: ["unsure why the user picked this database"],
    suggestedQuestion: "I think you switched to Postgres for the database. Correct?",
  });
  const unrelated = claim({ kind: "taste_rule", text: "Reviews AI-proposed edits before accepting them." });

  const decision = decide({
    observation: obs,
    actions: [consequentialAction()],
    claims: [],
    longTermContext: [unrelated],
  });

  assert.equal(decision.kind, "ask_expert", "with nothing established, the agent still asks");
});

test("policy does NOT treat a non-answer-bearing claim as established", () => {
  // An unresolved_question is the OPPOSITE of established knowledge — a lexical
  // match against it must never suppress a real question.
  const obs = observation({
    uncertainty: ["unsure why the user picked this database"],
    suggestedQuestion: "I think you switched to Postgres for the database. Correct?",
  });
  const openQuestion = claim({
    kind: "unresolved_question",
    text: "Was the switch to a Postgres database identified correctly?",
    confidence: 0.9,
  });

  const decision = decide({
    observation: obs,
    actions: [consequentialAction()],
    claims: [],
    longTermContext: [openQuestion],
  });

  assert.equal(decision.kind, "ask_expert", "an unresolved question cannot establish an answer");
});

test("policy still asks when a claim only shares a generic term with the question", () => {
  // "Prefer MySQL database." shares only the generic word "database" with a
  // question about switching to Postgres — it does not answer that question, so
  // a symmetric overlap that fires on the short claim would be wrong.
  const obs = observation({
    uncertainty: ["unsure why the user picked this database"],
    suggestedQuestion: "I think you switched to Postgres for the database. Correct?",
  });
  const tangential = claim({ kind: "decision_rule", text: "Prefer MySQL database.", confidence: 0.9 });

  const decision = decide({
    observation: obs,
    actions: [consequentialAction()],
    claims: [],
    longTermContext: [tangential],
  });

  assert.equal(
    decision.kind,
    "ask_expert",
    "a claim that covers only a minority of the question's terms is not 'established'",
  );
});

test("end to end: retrieved long-term context flows into the loop's decision", async () => {
  const { store } = await fullPipeline();
  // fullPipeline persists a high-confidence decision_rule:
  // "Prefer evidence-backed action reconstruction over video-only inference."
  const rule = store.claims.all().find((c) => c.kind === "decision_rule")!;
  assert.ok(rule, "the pipeline produced a long-term decision_rule");

  // An observer that re-raises a question the long-term memory already answers.
  const observer: Observer = {
    model: "test-observer",
    async observe(bundle, opts) {
      return observation({
        id: opts?.newId ? opts.newId("obs") : "obs_e2e",
        bundleId: bundle.id,
        episodeId: opts?.episodeId,
        intent: "Deciding how to reconstruct user actions.",
        uncertainty: ["unsure whether to trust video-only inference"],
        suggestedQuestion:
          "I think you chose evidence-backed action reconstruction over video-only inference. Correct?",
        evidence: ["a"],
      });
    },
  };

  let captured: { kind: string; grounding?: string[] } | undefined;
  const loop = new AgentLoop(store, {
    observer,
    minEpisodeActions: 1,
    observeIntervalMs: 0,
    // Wide window so the (dated) fixtures are observable (the loop refuses to
    // observe episodes that ended outside its window - restart-staleness guard).
    windowMs: 10 * 365 * 86_400_000,
    onDecision: (d) => {
      captured = { kind: d.kind, grounding: d.grounding };
    },
  });

  const result = await loop.tick();
  assert.ok(result, "the loop observed and decided");
  assert.notEqual(captured?.kind, "ask_expert", "the loop did not re-ask the established question");
  assert.ok(
    captured?.grounding?.some((g) => /reconstruction/.test(g)),
    "the decision was grounded in retrieved long-term context",
  );
  store.close();
});
