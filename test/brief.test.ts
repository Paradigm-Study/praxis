import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { freshStore } from "./helpers.ts";
import { buildBrief } from "../src/studio/brief.ts";
import type { Episode, StoredDecision } from "../src/core/types.ts";
import type { Store } from "../src/storage/index.ts";

// ---------------------------------------------------------------------------
// buildBrief — the local half (episode goal, claims, open questions) comes
// from the store; the mesh half (teammates/lockedSpecs/recentDecisions) comes
// from the relay and MUST fail open to empty on any problem.
// ---------------------------------------------------------------------------

const MESH_ENV = ["PRAXIS_MESH_URL", "PRAXIS_MESH_TOKEN", "PRAXIS_PERSON"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of MESH_ENV) {
    savedEnv.set(k, process.env[k]);
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of MESH_ENV) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function episode(partial: Partial<Episode> & { id: string; startTs: string }): Episode {
  return {
    id: partial.id,
    type: "context_episode",
    startTs: partial.startTs,
    endTs: partial.endTs ?? partial.startTs,
    summary: partial.summary ?? "worked on something",
    goal: partial.goal,
    actions: partial.actions ?? [],
    artifacts: partial.artifacts ?? [],
    decisionPoints: partial.decisionPoints ?? [],
    rejectedPaths: partial.rejectedPaths ?? [],
    uncertainty: partial.uncertainty ?? [],
  };
}

function decision(partial: Partial<StoredDecision> & { id: string }): StoredDecision {
  return {
    id: partial.id,
    kind: partial.kind ?? "ask_expert",
    reason: partial.reason ?? "unsure",
    question: partial.question,
    evidence: partial.evidence ?? [],
    createdTs: partial.createdTs ?? "2026-06-09T10:00:00.000Z",
  };
}

describe("buildBrief — local half", () => {
  test("empty store, no mesh env → fully empty brief and no rejection", async () => {
    const brief = await buildBrief(freshStore());
    assert.equal(brief.episodeGoal, "");
    assert.deepEqual(brief.topClaims, []);
    assert.deepEqual(brief.openQuestions, []);
    assert.deepEqual(brief.teammates, []);
    assert.deepEqual(brief.lockedSpecs, []);
    assert.deepEqual(brief.recentDecisions, []);
  });

  test("episodeGoal is the LATEST episode's goal (falling back to summary)", async () => {
    const store = freshStore();
    store.episodes.put(
      episode({ id: "episode_old", startTs: "2026-06-09T08:00:00.000Z", goal: "old goal" }),
    );
    store.episodes.put(
      episode({
        id: "episode_new",
        startTs: "2026-06-09T09:00:00.000Z",
        summary: "refactoring the ingest pipeline",
      }),
    );
    const brief = await buildBrief(store);
    assert.equal(brief.episodeGoal, "refactoring the ingest pipeline");
  });

  test("openQuestions = undelivered ask_expert only (answered + other kinds excluded)", async () => {
    const store = freshStore();
    store.decisions.put(
      decision({ id: "decision_open", question: "Postgres or SQLite for the cache?" }),
    );
    store.decisions.put(
      decision({ id: "decision_answered", question: "Tabs or spaces?" }),
    );
    store.decisions.put(
      decision({ id: "decision_intervene", kind: "intervene", question: "Stop the deploy?" }),
    );
    store.decisions.put(decision({ id: "decision_noq", question: undefined }));
    store.corrections.put({
      id: "corr_1",
      targetKind: "decision",
      targetId: "decision_answered",
      verdict: "edited",
      correctedText: "spaces",
      createdTs: "2026-06-09T10:05:00.000Z",
    });

    const brief = await buildBrief(store);
    assert.deepEqual(
      brief.openQuestions.map((q) => q.questionId),
      ["decision_open"],
    );
    assert.equal(brief.openQuestions[0]!.question, "Postgres or SQLite for the cache?");
    assert.ok(brief.openQuestions[0]!.createdTs);
  });

  test("topClaims is always a bounded array (retrieveForTask contract)", async () => {
    const store = freshStore();
    store.claims.put({
      id: "claim_1",
      kind: "preference",
      text: "prefers vitest for the boardroom package",
      confidence: 0.9,
      evidenceEpisodes: [],
      createdTs: "2026-06-09T10:00:00.000Z",
      updatedTs: "2026-06-09T10:00:00.000Z",
    });
    const brief = await buildBrief(store, { cwd: "/Users/me/work/boardroom" });
    assert.ok(Array.isArray(brief.topClaims));
    assert.ok(brief.topClaims.length <= 5);
    // NOTE: retrieveForTask is a scaffold stub returning [] at build time, so
    // no content assertion here — only the shape/bound contract.
  });
});

describe("buildBrief — mesh half (relay, fail open)", () => {
  const RELAY_BRIEF = {
    teammates: [
      {
        person: "kim",
        intent: "migrating the relay to sqlite",
        artifacts: [{ repo: "https://github.com/a/b", path: "src/db.ts" }],
        ts: "2026-06-09T09:30:00.000Z",
      },
    ],
    lockedSpecs: [],
    recentDecisions: [],
  };

  test("no PRAXIS_MESH_* env → relay never contacted, empty mesh half", async () => {
    let called = 0;
    const fetchFn: typeof fetch = async () => {
      called++;
      return new Response(JSON.stringify(RELAY_BRIEF));
    };
    const brief = await buildBrief(freshStore(), { fetchFn });
    assert.equal(called, 0);
    assert.deepEqual(brief.teammates, []);
  });

  test("env set → GET /brief with person/project params and bearer token (cwd stays local)", async () => {
    process.env.PRAXIS_MESH_URL = "http://127.0.0.1:4600/"; // trailing slash on purpose
    process.env.PRAXIS_MESH_TOKEN = "tok-alex";
    process.env.PRAXIS_PERSON = "alex";

    let url = "";
    let auth = "";
    const fetchFn: typeof fetch = async (input, init) => {
      url = String(input);
      auth = String(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify(RELAY_BRIEF));
    };

    const brief = await buildBrief(freshStore(), { cwd: "/Users/me/work/demo", fetchFn });
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/brief");
    assert.equal(parsed.searchParams.get("person"), "alex");
    assert.equal(parsed.searchParams.get("project"), "demo");
    assert.equal(
      parsed.searchParams.get("cwd"),
      null,
      "the absolute cwd must never leave the machine (username/home-layout leak)",
    );
    assert.equal(auth, "Bearer tok-alex");
    assert.equal(brief.teammates.length, 1);
    assert.equal(brief.teammates[0]!.person, "kim");
  });

  test("relay down (fetch rejects) → empty mesh half, promise still resolves", async () => {
    process.env.PRAXIS_MESH_URL = "http://127.0.0.1:4600";
    process.env.PRAXIS_MESH_TOKEN = "tok";
    process.env.PRAXIS_PERSON = "alex";
    const fetchFn: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const brief = await buildBrief(freshStore(), { fetchFn });
    assert.deepEqual(brief.teammates, []);
    assert.deepEqual(brief.lockedSpecs, []);
    assert.deepEqual(brief.recentDecisions, []);
  });

  test("relay answers garbage / non-200 → empty mesh half", async () => {
    process.env.PRAXIS_MESH_URL = "http://127.0.0.1:4600";
    process.env.PRAXIS_MESH_TOKEN = "tok";
    process.env.PRAXIS_PERSON = "alex";

    const garbage = await buildBrief(freshStore(), {
      fetchFn: async () => new Response("not json at all"),
    });
    assert.deepEqual(garbage.teammates, []);

    const denied = await buildBrief(freshStore(), {
      fetchFn: async () => new Response("{}", { status: 401 }),
    });
    assert.deepEqual(denied.teammates, []);
  });
});

// ---------------------------------------------------------------------------
// hooks/praxis-brief.sh — exercised as a real process, mirroring boardroom's
// tests/sessionStartHook.test.ts. Contract: JSON in on stdin; on a reachable
// studio with a contentful brief, a SessionStart additionalContext envelope
// out; on ANY failure or an empty brief, NO output and exit 0.
// ---------------------------------------------------------------------------

const HOOK = fileURLToPath(new URL("../hooks/praxis-brief.sh", import.meta.url));
const HOOK_INPUT = JSON.stringify({ session_id: "demo-123", cwd: "/Users/me/work/demo" });

function runHook(studioUrl: string): Promise<{ stdout: string; status: number | null; ms: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn("bash", [HOOK], {
      env: { ...process.env, PRAXIS_STUDIO_URL: studioUrl },
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ stdout, status: code, ms: Date.now() - start }));
    child.stdin.end(HOOK_INPUT);
  });
}

/** Serve GET /api/brief with a fixed body; records request URLs. */
function startStubStudio(body: unknown): Promise<{ server: Server; url: string; urls: string[] }> {
  const urls: string[] = [];
  const server = createServer((req, res) => {
    urls.push(req.url ?? "");
    if (req.method === "GET" && req.url?.startsWith("/api/brief")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, urls });
    });
  });
}

async function closedPort(): Promise<number> {
  // Bind then close, so the port is real but guaranteed refused.
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe("hooks/praxis-brief.sh", () => {
  test("studio down → exit 0 and NO output (fail open, session unchanged)", async () => {
    const port = await closedPort();
    const { stdout, status, ms } = await runHook(`http://127.0.0.1:${port}`);
    assert.equal(status, 0);
    assert.equal(stdout, "");
    assert.ok(ms < 4000, `hook took ${ms}ms — must not stack retries`);
  });

  test("contentful brief → SessionStart envelope with the praxis brief digest", async () => {
    const { server, url, urls } = await startStubStudio({
      episodeGoal: "refactoring the ingest pipeline",
      topClaims: [{ id: "claim_1", text: "prefers vitest in boardroom" }],
      openQuestions: [{ questionId: "decision_1", question: "Postgres or SQLite?" }],
      teammates: [],
      lockedSpecs: [],
      recentDecisions: [],
    });
    try {
      const { stdout, status } = await runHook(url);
      assert.equal(status, 0);
      const out = JSON.parse(stdout) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
      const ctx = out.hookSpecificOutput.additionalContext;
      assert.match(ctx, /## Your praxis brief/);
      assert.match(ctx, /Current focus: refactoring the ingest pipeline/);
      assert.match(ctx, /- prefers vitest in boardroom/);
      assert.match(ctx, /- Postgres or SQLite\?/);
      // The hook forwards the session's cwd to /api/brief.
      assert.equal(urls.length, 1);
      assert.match(urls[0]!, /\/api\/brief\?cwd=%2FUsers%2Fme%2Fwork%2Fdemo/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("empty brief → exit 0 and NO output (nothing worth injecting)", async () => {
    const { server, url } = await startStubStudio({
      episodeGoal: "",
      topClaims: [],
      openQuestions: [],
      teammates: [],
      lockedSpecs: [],
      recentDecisions: [],
    });
    try {
      const { stdout, status } = await runHook(url);
      assert.equal(status, 0);
      assert.equal(stdout, "");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("non-JSON studio answer → exit 0 and NO output", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not a brief</html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const { stdout, status } = await runHook(`http://127.0.0.1:${port}`);
      assert.equal(status, 0);
      assert.equal(stdout, "");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
