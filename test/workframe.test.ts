import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "../src/core/hash.ts";
import type { ActionEvent, Episode, RawEvent } from "../src/core/types.ts";
import {
  episodeToWorkFrame,
  normalizeRepoUrl,
} from "../src/mesh/workframe.ts";
import { freshStore } from "./helpers.ts";

const START_TS = "2026-07-12T17:00:00.000Z";
const END_TS = "2026-07-12T17:05:00.000Z";

function rawEvent(id: string, hash: string): RawEvent {
  return {
    id,
    ts: START_TS,
    source: "synthetic",
    app: "Codex",
    window: "praxis",
    type: "fixture",
    payload: { id },
    blobRefs: [],
    hash,
  };
}

function action(id: string, evidence: string[]): ActionEvent {
  return {
    id,
    type: "user_action",
    action: "edited_file",
    app: "Codex",
    startTs: START_TS,
    endTs: END_TS,
    confidence: 0.95,
    evidence,
  };
}

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: "episode_mesh",
    type: "context_episode",
    startTs: START_TS,
    endTs: END_TS,
    summary: "Fallback summary",
    actions: [],
    artifacts: [],
    decisionPoints: [],
    rejectedPaths: [],
    uncertainty: [],
    ...overrides,
  };
}

test("normalizeRepoUrl converges GitHub remotes on owner/repo and preserves directory names", () => {
  assert.equal(
    normalizeRepoUrl("git@github.com:Acme/Repo.git"),
    "acme/repo",
  );
  assert.equal(
    normalizeRepoUrl("ssh://git@Git.Example.COM/Acme/Repo.git"),
    "https://git.example.com/acme/repo",
  );
  assert.equal(
    normalizeRepoUrl("https://GitHub.com/Acme/Repo.git/"),
    "acme/repo",
  );
  assert.equal(normalizeRepoUrl("Acme/Repo"), "acme/repo");
  assert.equal(normalizeRepoUrl("Praxis"), "Praxis");
});

test("episodeToWorkFrame projects redacted metadata and hashed evidence", (t) => {
  const store = freshStore();
  t.after(() => store.close());

  const firstEvent = rawEvent("event_first", sha256("first event"));
  const secondEvent = rawEvent("event_second", sha256("second event"));
  store.events.append(firstEvent);
  store.events.append(secondEvent);
  store.actions.put(
    action("action_second", [secondEvent.id, "event_missing", firstEvent.id]),
  );
  store.actions.put(action("action_first", [firstEvent.id]));

  const claimId = "claim_auth_workflow";
  store.claims.put({
    id: claimId,
    kind: "workflow_pattern",
    text: "Validates auth changes with focused tests.",
    confidence: 0.9,
    evidenceEpisodes: ["episode_mesh"],
    createdTs: START_TS,
    updatedTs: END_TS,
  });
  store.graph.putNode({
    id: "node_auth_workflow",
    kind: "workflow_pattern",
    label: "Validates auth changes with focused tests.",
    confidence: 0.9,
    claimId,
    createdTs: START_TS,
    updatedTs: END_TS,
  });
  store.graph.putEdge({
    id: "edge_auth_workflow",
    from: "node_auth_workflow",
    to: "episode_mesh",
    kind: "observed_in_episode",
    createdTs: END_TS,
  });

  const source = episode({
    goal: "  Ship\n  auth flow for owner@example.com  ",
    actions: ["action_second", "action_missing", "action_first"],
    artifacts: [
      "./src/index.ts",
      "docs/Guide.md",
      "https://example.com/design",
      "custom+page://example.com/reference",
    ],
    uncertainty: ["Ask owner@example.com about sk-abcdefghijkl"],
  });
  const frame = episodeToWorkFrame(source, {
    person: "alice",
    device: "laptop",
    project: "git@github.com:Acme/Repo.git",
    store,
    status: "done",
    sessionKey: "session_123",
    ts: "2026-07-12T18:00:00.000Z",
  });

  assert.match(
    frame.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(frame.v, 0);
  assert.equal(frame.kind, "workframe");
  assert.equal(frame.person, "alice");
  assert.equal(frame.device, "laptop");
  assert.equal(frame.project, "acme/repo");
  assert.equal(frame.ts, "2026-07-12T18:00:00.000Z");
  assert.equal(frame.status, "done");
  assert.equal(frame.sessionKey, "session_123");
  assert.equal(frame.intent, "Ship auth flow for [redacted]");
  assert.deepEqual(frame.artifacts, [
    { repo: "acme/repo", path: "src/index.ts" },
    { repo: "acme/repo", path: "docs/Guide.md" },
  ]);
  assert.deepEqual(frame.uncertainty, [
    "Ask [redacted] about [redacted]",
  ]);
  assert.deepEqual(frame.claimsTouched, [claimId]);
  assert.deepEqual(
    frame.evidenceRefs,
    [firstEvent.hash, secondEvent.hash].sort(),
  );
});

test("episodeToWorkFrame never uses a prompt-derived goal as intent", () => {
  // A goal inferred from a typed prompt (fuser payload.goalSource "prompt") is
  // a prompt-body prefix — the privacy invariant forbids it mesh-bound.
  const promptDerived = episodeToWorkFrame(
    episode({
      goal: "confidential: acquire DataCo before Friday standup",
      summary: "In Codex: edited 2 file(s).",
      payload: { goalSource: "prompt" },
    }),
    { person: "bob", device: "desktop", project: "Praxis" },
  );
  assert.equal(promptDerived.intent, "In Codex: edited 2 file(s).");
  assert.ok(!promptDerived.intent.includes("DataCo"));

  // A commit-derived goal is shareable work description — still used.
  const commitDerived = episodeToWorkFrame(
    episode({
      goal: "fix auth token refresh",
      summary: "In Codex: committed.",
      payload: { goalSource: "commit" },
    }),
    { person: "bob", device: "desktop", project: "Praxis" },
  );
  assert.equal(commitDerived.intent, "fix auth token refresh");
});

test("episodeToWorkFrame relativizes absolute paths under repoRoot and drops the rest", () => {
  const frame = episodeToWorkFrame(
    episode({
      artifacts: [
        "/repo/src/auth.ts", // under repoRoot → relativized
        "/Users/someone/other-project/secret.ts", // machine-local → dropped
        "~/notes.md", // home-relative → dropped
        "./src/index.ts", // already repo-relative
      ],
    }),
    { person: "bob", device: "desktop", project: "Praxis", repoRoot: "/repo" },
  );
  assert.deepEqual(
    frame.artifacts.map((artifact) => artifact.path),
    ["src/auth.ts", "src/index.ts"],
    "absolute local paths must never cross the mesh boundary",
  );
});

test("episodeToWorkFrame falls back to summary and applies defaults", () => {
  const frame = episodeToWorkFrame(
    episode({
      id: "episode_summary",
      summary: "  summarize\n auth   changes  ",
    }),
    { person: "bob", device: "desktop", project: "Praxis" },
  );

  assert.equal(frame.intent, "summarize auth changes");
  assert.equal(frame.ts, END_TS);
  assert.equal(frame.status, "active");
  assert.deepEqual(frame.claimsTouched, []);
  assert.deepEqual(frame.evidenceRefs, []);
  assert.equal("sessionKey" in frame, false);
});
