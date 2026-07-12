import { test } from "node:test";
import assert from "node:assert/strict";
import type { Claim, Episode } from "../src/core/types.ts";
import { retrieveForTask } from "../src/agent/retrieveForTask.ts";
import { freshStore } from "./helpers.ts";

function claim(partial: Partial<Claim> & { id: string; text: string }): Claim {
  return {
    id: partial.id,
    kind: partial.kind ?? "decision_rule",
    text: partial.text,
    confidence: partial.confidence ?? 0.9,
    evidenceEpisodes: partial.evidenceEpisodes ?? [],
    createdTs: partial.createdTs ?? "2026-06-01T00:00:00.000Z",
    updatedTs: partial.updatedTs ?? "2026-06-01T00:00:00.000Z",
  };
}

function episode(partial: Partial<Episode> & { id: string }): Episode {
  return {
    id: partial.id,
    type: "context_episode",
    startTs: partial.startTs ?? "2026-06-01T09:00:00.000Z",
    endTs: partial.endTs ?? "2026-06-01T10:00:00.000Z",
    summary: partial.summary ?? "test episode",
    goal: partial.goal,
    actions: partial.actions ?? [],
    artifacts: partial.artifacts ?? [],
    decisionPoints: partial.decisionPoints ?? [],
    rejectedPaths: partial.rejectedPaths ?? [],
    uncertainty: partial.uncertainty ?? [],
    boundaryReason: partial.boundaryReason,
    payload: partial.payload,
  };
}

test("exact-topic claim outranks unrelated claims; unrelated ones are excluded", () => {
  const store = freshStore();
  store.claims.put(claim({ id: "c_pg", text: "Prefer Postgres for database migrations." }));
  store.claims.put(claim({ id: "c_cake", text: "User likes dark chocolate cake for dessert." }));
  store.claims.put(claim({ id: "c_gym", text: "Goes to the gym on Tuesday mornings." }));

  const results = retrieveForTask(store, "run the postgres database migration");
  const ids = results.map((c) => c.id);
  assert.equal(ids[0], "c_pg", "on-topic claim ranks first");
  assert.ok(!ids.includes("c_cake"), "unrelated dessert claim excluded");
  assert.ok(!ids.includes("c_gym"), "unrelated gym claim excluded");
  store.close();
});

test("empty task text or empty store returns []", () => {
  const store = freshStore();
  assert.deepEqual(retrieveForTask(store, "anything"), [], "no claims → []");
  store.claims.put(claim({ id: "c_1", text: "Prefer Postgres." }));
  assert.deepEqual(retrieveForTask(store, "   "), [], "blank task → []");
  store.close();
});

test("respects the limit (default 5) and returns most relevant first", () => {
  const store = freshStore();
  for (let i = 0; i < 9; i++) {
    store.claims.put(claim({ id: `c_${i}`, text: `Postgres database migration rule number ${i}.` }));
  }
  assert.equal(retrieveForTask(store, "postgres database migration").length, 5, "default limit 5");
  assert.equal(
    retrieveForTask(store, "postgres database migration", { limit: 2 }).length,
    2,
    "explicit limit respected",
  );
  store.close();
});

test("low-confidence claims are filtered out", () => {
  const store = freshStore();
  store.claims.put(
    claim({ id: "c_weak", text: "Prefer Postgres for database migrations.", confidence: 0.2 }),
  );
  const results = retrieveForTask(store, "run the postgres database migration");
  assert.deepEqual(results, [], "a 0.2-confidence claim never surfaces");
  store.close();
});

test("cwd boost reorders: artifact-anchored claim beats a slightly better textual match", () => {
  const store = freshStore();
  // ep_api touched files under the task's cwd; ep_other did not.
  store.episodes.put(
    episode({ id: "ep_api", artifacts: ["/Users/x/proj/src/api/server.ts", "/Users/x/proj/src/api/routes.ts"] }),
  );
  store.episodes.put(episode({ id: "ep_other", artifacts: ["/elsewhere/tool/main.ts"] }));

  // c_far is the strictly BETTER textual match; c_near is on-topic but
  // slightly weaker textually, anchored to the cwd's files. The gap between
  // them is smaller than the scope boost, so scoping must flip the order.
  store.claims.put(
    claim({
      id: "c_far",
      text: "Retry failed api requests with exponential backoff delays.",
      evidenceEpisodes: ["ep_other"],
    }),
  );
  store.claims.put(
    claim({
      id: "c_near",
      text: "Api server requests sometimes fail and need retry backoff.",
      evidenceEpisodes: ["ep_api"],
    }),
  );

  const task = "retry failed api server requests with backoff";
  const baseline = retrieveForTask(store, task);
  assert.equal(baseline[0]!.id, "c_far", "without scope, the closer wording wins");

  const scoped = retrieveForTask(store, task, { cwd: "/Users/x/proj" });
  assert.equal(scoped[0]!.id, "c_near", "with cwd scope, the artifact-anchored claim wins");
  assert.ok(
    scoped.map((c) => c.id).includes("c_far"),
    "the textual match is still returned, just lower",
  );
  store.close();
});

test("path boost matches repo-relative paths against absolute episode artifacts", () => {
  const store = freshStore();
  store.episodes.put(episode({ id: "ep_a", artifacts: ["/Users/x/proj/src/api/server.ts"] }));
  store.episodes.put(episode({ id: "ep_b", artifacts: ["/Users/x/proj/docs/notes.md"] }));
  store.claims.put(
    claim({ id: "c_a", text: "Server code review takes priority.", evidenceEpisodes: ["ep_a"] }),
  );
  store.claims.put(
    claim({ id: "c_b", text: "Server code review takes priority always.", evidenceEpisodes: ["ep_b"] }),
  );

  const results = retrieveForTask(store, "review the server code", { path: "src/api/server.ts" });
  assert.equal(results[0]!.id, "c_a", "claim evidenced on the named path ranks first");
  store.close();
});

test("repo boost normalizes ssh and https remote forms", () => {
  const store = freshStore();
  store.episodes.put(episode({ id: "ep_ssh", artifacts: ["git@github.com:Acme/Widgets.git"] }));
  store.episodes.put(episode({ id: "ep_none", artifacts: ["https://github.com/other/repo"] }));
  store.claims.put(
    claim({ id: "c_widgets", text: "Widget build pipeline is flaky.", evidenceEpisodes: ["ep_ssh"] }),
  );
  store.claims.put(
    claim({ id: "c_other", text: "Widget build pipeline is flaky too.", evidenceEpisodes: ["ep_none"] }),
  );

  const results = retrieveForTask(store, "fix the widget build pipeline", {
    repo: "https://github.com/acme/widgets",
  });
  assert.equal(results[0]!.id, "c_widgets", "ssh-form artifact matches https-form repo option");
  store.close();
});

test("scope boost alone can surface a claim with no textual overlap", () => {
  const store = freshStore();
  store.episodes.put(episode({ id: "ep_cwd", artifacts: ["/Users/x/proj/README.md"] }));
  store.claims.put(
    claim({
      id: "c_anchored",
      text: "Zzz qqq xxyzzy.", // shares no trigrams with the task
      evidenceEpisodes: ["ep_cwd"],
    }),
  );
  const without = retrieveForTask(store, "deploy the frontend");
  assert.deepEqual(without, [], "no relevance, no scope → excluded");
  const withCwd = retrieveForTask(store, "deploy the frontend", { cwd: "/Users/x/proj" });
  assert.equal(withCwd.length, 1, "artifact anchoring alone surfaces the claim");
  assert.equal(withCwd[0]!.id, "c_anchored");
  store.close();
});
