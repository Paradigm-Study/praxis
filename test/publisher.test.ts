import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Episode } from "../src/core/types.ts";
import { MeshPublisher, resolveEpisodeProject } from "../src/mesh/publisher.ts";
import type { BoardroomLifecycle, SyncVerification, WorkFrame } from "../src/mesh/types.ts";
import { PrivacyControlStore } from "../src/privacy/control.ts";
import { EgressAuditor } from "../src/privacy/egress.ts";
import { action, freshStore } from "./helpers.ts";

interface RequestRecord {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
  teamId: string | undefined;
  deviceId: string | undefined;
  idempotencyKey: string | undefined;
  body: string;
}

interface RelayListener {
  url: string;
  fetchFn: typeof fetch;
  bound: boolean;
}

interface StoredSpoolRecord {
  spoolVersion: 1;
  scope: { teamId: string | null; person: string; device: string };
  frame: WorkFrame;
}

function readSpool(path: string): StoredSpoolRecord[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredSpoolRecord);
}

function tempPaths(): { dir: string; configPath: string; spoolPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "praxis-publisher-"));
  return {
    dir,
    configPath: join(dir, "missing-mesh-config.json"),
    spoolPath: join(dir, "mesh-spool.ndjson"),
  };
}

function listen(server: Server, fallbackFetch: typeof fetch): Promise<RelayListener> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === "EPERM") {
        // Some hermetic test runners deny loopback listeners. Keep exercising
        // the exact transport assertions through the publisher's injected
        // fetch seam there; ordinary environments still use node:http below.
        resolve({
          url: "https://publisher-test.invalid",
          fetchFn: fallbackFetch,
          bound: false,
        });
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected an IPv4 listener"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        fetchFn: globalThis.fetch,
        bound: true,
      });
    });
  });
}

function close(server: Server, bound: boolean): Promise<void> {
  if (!bound) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function fetchRequestRecord(
  input: string | URL | Request,
  init?: RequestInit,
): RequestRecord {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(init?.headers);
  return {
    method: init?.method,
    path: url.pathname,
    authorization: headers.get("authorization") ?? undefined,
    teamId: headers.get("x-mesh-team-id") ?? undefined,
    deviceId: headers.get("x-mesh-device-id") ?? undefined,
    idempotencyKey: headers.get("idempotency-key") ?? undefined,
    body: typeof init?.body === "string" ? init.body : "",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readRequest(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function frame(id: string): WorkFrame {
  return {
    v: 0,
    id,
    kind: "workframe",
    person: "alice",
    device: "laptop",
    project: "praxis",
    ts: "2026-07-12T12:00:00.000Z",
    intent: `work item ${id}`,
    status: "active",
    artifacts: [{ repo: "praxis", path: "src/index.ts" }],
    uncertainty: [],
    claimsTouched: [],
    evidenceRefs: [],
  };
}

function card(cardId: string, verdict: string): BoardroomLifecycle {
  return {
    v: 0,
    kind: "card_event",
    person: "alice",
    device: "laptop",
    project: "praxis",
    ts: "2026-07-12T12:00:00.000Z",
    cardId,
    stage: "results",
    event: "decided",
    verdict,
    artifacts: [{ repo: "praxis", path: "src/index.ts" }],
    specCriteria: [],
  };
}

function episode(id = "episode_1"): Episode {
  return {
    id,
    type: "context_episode",
    startTs: "2026-07-12T12:00:00.000Z",
    endTs: "2026-07-12T12:01:00.000Z",
    summary: "implement the publisher",
    goal: "publish a mesh workframe",
    actions: [],
    artifacts: ["src/mesh/publisher.ts"],
    decisionPoints: [],
    rejectedPaths: [],
    uncertainty: [],
  };
}

test("publish posts a frame with the relay path and bearer token", async () => {
  const paths = tempPaths();
  const requests: RequestRecord[] = [];
  const fallbackFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(fetchRequestRecord(input, init));
    return jsonResponse({ ok: true, seq: 1 });
  }) as typeof fetch;
  const server = createServer(async (req, res) => {
    const body = await readRequest(req);
    requests.push({
      method: req.method,
      path: req.url,
      authorization: typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : undefined,
      teamId: typeof req.headers["x-mesh-team-id"] === "string"
        ? req.headers["x-mesh-team-id"]
        : undefined,
      deviceId: typeof req.headers["x-mesh-device-id"] === "string"
        ? req.headers["x-mesh-device-id"]
        : undefined,
      idempotencyKey: typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"]
        : undefined,
      body,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, seq: 1 }));
  });
  const relay = await listen(server, fallbackFetch);

  try {
    const publisher = new MeshPublisher({
      url: `${relay.url}/`,
      token: "secret-token",
      person: "alice",
      teamId: "team-praxis",
      device: "device-praxis",
      fetchFn: relay.fetchFn,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    const sent = frame("frame_happy");
    assert.deepEqual(await publisher.publish(sent), { ok: true, seq: 1 });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, "POST");
    assert.equal(requests[0]!.path, "/outbox/alice");
    assert.equal(requests[0]!.authorization, "Bearer secret-token");
    assert.equal(requests[0]!.teamId, "team-praxis");
    assert.equal(requests[0]!.deviceId, "device-praxis");
    assert.equal(requests[0]!.idempotencyKey, "praxis:frame_happy");
    assert.deepEqual(JSON.parse(requests[0]!.body), {
      ...sent,
      device: "device-praxis",
    });
  } finally {
    await close(server, relay.bound);
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("verification publishes the exact consent-gated content-free wire record", async () => {
  const paths = tempPaths();
  const store = freshStore();
  const requests: RequestRecord[] = [];
  let consented = false;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(fetchRequestRecord(input, init));
    return jsonResponse({ ok: true, seq: 17 });
  }) as typeof fetch;

  try {
    const publisher = new MeshPublisher({
      url: "https://relay.invalid",
      token: "secret-token",
      person: "alice",
      teamId: "team-praxis",
      device: "device-praxis",
      store,
      fetchFn,
      currentProjectConsent: (project) => consented && project === "acme/app",
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });

    const scope = { teamId: "team-praxis", deviceId: "device-praxis" };
    assert.deepEqual(await publisher.publishVerification("/Users/alice/private", scope), {
      ok: false,
      error: "project identity is invalid",
    });
    assert.deepEqual(await publisher.publishVerification("acme/app", scope), {
      ok: false,
      error: "project is not currently consented",
    });
    assert.equal(requests.length, 0, "no relay request is attempted before current consent");

    consented = true;
    assert.deepEqual(
      await publisher.publishVerification("git@github.com:Acme/App.git", scope),
      { ok: true, seq: 17 },
    );
    assert.equal(requests.length, 1);

    assert.deepEqual(
      await publisher.publishVerification("acme/app", { ...scope, teamId: "team-other" }),
      { ok: false, error: "team relay scope changed; restart required" },
    );
    assert.equal(requests.length, 1, "a stale process scope cannot egress another team's project");
    const request = requests[0]!;
    const body = JSON.parse(request.body) as SyncVerification;
    assert.match(request.idempotencyKey ?? "", /^praxis:sync:[a-f0-9]{64}$/);
    assert.deepEqual(body, {
      v: 0,
      kind: "sync_verification",
      person: "alice",
      device: "device-praxis",
      ts: body.ts,
    });
    assert.deepEqual(Object.keys(body).sort(), ["device", "kind", "person", "ts", "v"]);
    assert.equal(request.body.includes("acme/app"), false, "the local consent selector never reaches the wire");
    assert.equal(request.body.includes("secret-token"), false);
    assert.ok(Number.isFinite(Date.parse(body.ts)));
    assert.equal(request.teamId, "team-praxis");
    assert.equal(request.deviceId, "device-praxis");
    assert.equal(
      EgressAuditor.forStore(store).recent(10).some((entry) =>
        entry.purpose === "mesh_publish"
        && entry.outcome === "succeeded"
        && entry.redaction === "mesh-sync-v0"
        && entry.categories.length === 1
        && entry.categories[0] === "sync_metadata"
      ),
      true,
    );
    assert.equal(JSON.stringify(EgressAuditor.forStore(store).recent(10)).includes("secret-token"), false);
  } finally {
    store.close();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("verification retry keys survive restart and separate credential rotations without persisting tokens", async () => {
  for (const rotateCredential of [false, true]) {
    const paths = tempPaths();
    const firstToken = "first-credential-secret";
    const retryToken = rotateCredential ? "rotated-credential-secret" : firstToken;
    const attempts: Array<{
      body: SyncVerification;
      key: string | null;
      authorization: string | null;
    }> = [];
    const recordAttempt = (init?: RequestInit): void => {
      attempts.push({
        body: JSON.parse(String(init?.body)) as SyncVerification,
        key: new Headers(init?.headers).get("idempotency-key"),
        authorization: new Headers(init?.headers).get("authorization"),
      });
    };
    const consent = (project: string): boolean => project === "acme/app" || project === "praxis";

    try {
      const offline = new MeshPublisher({
        url: "https://relay.invalid",
        token: firstToken,
        person: "alice",
        teamId: "team-praxis",
        device: "device-praxis",
        currentProjectConsent: consent,
        fetchFn: (async (_input, init) => {
          recordAttempt(init);
          throw new Error("offline");
        }) as typeof fetch,
        configPath: paths.configPath,
        spoolPath: paths.spoolPath,
      });
      const scope = { teamId: "team-praxis", deviceId: "device-praxis" };
      assert.equal((await offline.publishVerification("acme/app", scope)).ok, false);
      assert.equal((await offline.publishVerification("acme/app", scope)).ok, false);

      const spoolText = readFileSync(paths.spoolPath, "utf8");
      assert.equal(
        spoolText.split(/\r?\n/).filter(Boolean).length,
        1,
        "repeated transient failures retain one verification receipt",
      );
      assert.equal(spoolText.includes(firstToken), false, "raw relay credential never reaches retry disk");
      const queued = JSON.parse(spoolText.trim()) as {
        consentProject: string;
        frame: SyncVerification & Record<string, unknown>;
      };
      assert.equal(queued.consentProject, "acme/app", "local selector is retained for retry consent");
      assert.deepEqual(queued.frame, attempts[0]!.body, "the exact redacted wire body is retained");
      assert.equal("project" in queued.frame, false, "project never enters the wire frame");

      const restarted = new MeshPublisher({
        url: "https://relay.invalid",
        token: retryToken,
        person: "alice",
        teamId: "team-praxis",
        device: "device-praxis",
        currentProjectConsent: consent,
        fetchFn: (async (_input, init) => {
          recordAttempt(init);
          return jsonResponse({ ok: true, seq: attempts.length });
        }) as typeof fetch,
        configPath: paths.configPath,
        spoolPath: paths.spoolPath,
      });
      assert.equal((await restarted.publishVerification("acme/app", scope)).ok, true);

      assert.equal(attempts.length, 5);
      assert.equal(
        attempts.every((attempt) => JSON.stringify(attempt.body) === JSON.stringify(attempts[0]!.body)),
        true,
        "repeat and restart retries reuse the identical content-free body",
      );
      assert.match(attempts[0]!.key ?? "", /^praxis:sync:[a-f0-9]{64}$/);
      assert.equal(new Set(attempts.slice(0, 3).map((attempt) => attempt.key)).size, 1);
      assert.equal(new Set(attempts.slice(3).map((attempt) => attempt.key)).size, 1);
      assert.equal(
        attempts[3]!.key === attempts[0]!.key,
        !rotateCredential,
        "only credential rotation changes the verification retry namespace",
      );
      assert.equal(attempts[0]!.authorization, `Bearer ${firstToken}`);
      assert.equal(attempts[3]!.authorization, `Bearer ${retryToken}`);
      assert.equal((attempts[0]!.key ?? "").includes(firstToken), false);
      assert.equal((attempts[3]!.key ?? "").includes(retryToken), false);
      assert.equal(existsSync(paths.spoolPath), false);
    } finally {
      rmSync(paths.dir, { recursive: true, force: true });
    }
  }
});

test("verification spool retry re-checks its local project consent", async () => {
  const paths = tempPaths();
  let consented = true;
  const delivered: Array<WorkFrame | SyncVerification> = [];
  const currentConsent = (project: string): boolean =>
    project === "other" || (consented && project === "acme/app");

  try {
    const offline = new MeshPublisher({
      url: "https://relay.invalid",
      token: "credential",
      person: "alice",
      teamId: "team-praxis",
      device: "device-praxis",
      currentProjectConsent: currentConsent,
      fetchFn: (async () => { throw new Error("offline"); }) as typeof fetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    assert.equal((await offline.publishVerification("acme/app", {
      teamId: "team-praxis",
      deviceId: "device-praxis",
    })).ok, false);
    assert.equal(existsSync(paths.spoolPath), true);

    consented = false;
    const restarted = new MeshPublisher({
      url: "https://relay.invalid",
      token: "credential",
      person: "alice",
      teamId: "team-praxis",
      device: "device-praxis",
      currentProjectConsent: currentConsent,
      fetchFn: (async (_input, init) => {
        delivered.push(JSON.parse(String(init?.body)) as WorkFrame | SyncVerification);
        return jsonResponse({ ok: true, seq: delivered.length });
      }) as typeof fetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    assert.equal((await restarted.publish({ ...frame("allowed-trigger"), project: "other" })).ok, true);
    assert.deepEqual(delivered.map((item) => item.kind), ["workframe"]);
    assert.equal(existsSync(paths.spoolPath), false, "revoked verification receipt is dropped");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("a committed response loss retries the same frame idempotently after restart", async () => {
  const paths = tempPaths();
  const attempts: Array<{ id: string; key: string | null }> = [];
  try {
    const responseLost = new MeshPublisher({
      url: "https://relay.invalid",
      token: "token",
      person: "alice",
      device: "laptop",
      fetchFn: (async (_input, init) => {
        attempts.push({
          id: (JSON.parse(String(init?.body)) as WorkFrame).id,
          key: new Headers(init?.headers).get("idempotency-key"),
        });
        return {
          ok: true,
          status: 201,
          text: async () => { throw new Error("connection closed after commit"); },
        } as unknown as Response;
      }) as typeof fetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    const lost = await responseLost.publish(frame("frame_committed"));
    assert.equal(lost.ok, false);
    assert.equal(existsSync(paths.spoolPath), true);

    const restarted = new MeshPublisher({
      url: "https://relay.invalid",
      token: "token-rotated",
      person: "alice",
      device: "laptop",
      fetchFn: (async (_input, init) => {
        attempts.push({
          id: (JSON.parse(String(init?.body)) as WorkFrame).id,
          key: new Headers(init?.headers).get("idempotency-key"),
        });
        return jsonResponse({ ok: true, seq: attempts.length });
      }) as typeof fetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    assert.equal((await restarted.publish(frame("frame_current"))).ok, true);
    assert.deepEqual(attempts.map((attempt) => attempt.id), [
      "frame_committed",
      "frame_committed",
      "frame_current",
    ]);
    assert.equal(attempts[0]!.key, "praxis:frame_committed");
    assert.equal(attempts[1]!.key, attempts[0]!.key);
    assert.equal(existsSync(paths.spoolPath), false);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("publisher rejects unsafe boundaries before fetch and requests never follow redirects", async () => {
  const paths = tempPaths();
  let calls = 0;
  let redirect: RequestInit["redirect"];
  try {
    assert.throws(() => new MeshPublisher({
      url: "http://localhost:4600",
      token: "token",
      person: "alice",
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    }), /credential-free HTTPS|loopback/);
    const priorProxyMode = process.env.NODE_USE_ENV_PROXY;
    const priorProxy = process.env.HTTP_PROXY;
    try {
      process.env.NODE_USE_ENV_PROXY = "1";
      process.env.HTTP_PROXY = "http://127.0.0.1:9999";
      assert.throws(() => new MeshPublisher({
        url: "http://127.0.0.1:4600",
        token: "token",
        person: "alice",
        configPath: paths.configPath,
        spoolPath: paths.spoolPath,
      }), /credential-free HTTPS|loopback/);
    } finally {
      if (priorProxyMode === undefined) delete process.env.NODE_USE_ENV_PROXY;
      else process.env.NODE_USE_ENV_PROXY = priorProxyMode;
      if (priorProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = priorProxy;
    }
    assert.throws(() => new MeshPublisher({
      url: "https://token@relay.example.test",
      token: "token",
      person: "alice",
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    }), /credential-free HTTPS|loopback/);

    const publisher = new MeshPublisher({
      url: "https://relay.example.test",
      token: "token",
      person: "alice",
      device: "laptop",
      fetchFn: (async (_input, init) => {
        calls += 1;
        redirect = init?.redirect;
        return jsonResponse({ ok: true, seq: calls });
      }) as typeof fetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    assert.equal((await publisher.publish({ ...frame("unsafe-project"), project: "/Users/alice/private" })).ok, false);
    assert.equal((await publisher.publish({
      ...frame("unsafe-artifact"),
      artifacts: [{ repo: "praxis", path: "../private.txt" }],
    })).ok, false);
    assert.equal((await publisher.publish({
      ...frame("encoded-traversal"),
      artifacts: [{ repo: "praxis", path: "src/%2e%2e/private.txt" }],
    })).ok, false);
    assert.equal(calls, 0);
    assert.equal((await publisher.publish(frame("safe-frame"))).ok, true);
    assert.equal(calls, 1);
    assert.equal(redirect, "error");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("ambiguous acknowledgements, timeouts, and transient errors remain retryable", async () => {
  for (const scenario of ["invalid-ack", "oversized-ack", "timeout", "503"] as const) {
    const paths = tempPaths();
    const attempts: Array<{ id: string; key: string | null }> = [];
    try {
      const failing = new MeshPublisher({
        url: "https://relay.example.test",
        token: "token",
        person: "alice",
        device: "laptop",
        requestTimeoutMs: 250,
        fetchFn: (async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as WorkFrame;
          attempts.push({ id: body.id, key: new Headers(init?.headers).get("idempotency-key") });
          if (scenario === "invalid-ack") return jsonResponse({ ok: true, seq: -1 });
          if (scenario === "oversized-ack") {
            return new Response("x".repeat(70 * 1024), {
              headers: { "content-length": String(70 * 1024) },
            });
          }
          if (scenario === "503") return new Response("busy", { status: 503 });
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
        }) as typeof fetch,
        configPath: paths.configPath,
        spoolPath: paths.spoolPath,
      });
      const first = await failing.publish(frame(`frame-${scenario}`));
      assert.equal(first.ok, false, scenario);
      assert.equal(existsSync(paths.spoolPath), true, `${scenario} must persist the ambiguous frame`);

      const recovered = new MeshPublisher({
        url: "https://relay.example.test",
        token: "rotated-token",
        person: "alice",
        device: "laptop",
        fetchFn: (async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as WorkFrame;
          attempts.push({ id: body.id, key: new Headers(init?.headers).get("idempotency-key") });
          return jsonResponse({ ok: true, seq: attempts.length });
        }) as typeof fetch,
        configPath: paths.configPath,
        spoolPath: paths.spoolPath,
      });
      assert.equal((await recovered.publish(frame(`current-${scenario}`))).ok, true);
      assert.equal(attempts[0]!.key, attempts[1]!.key, `${scenario} retry key must be stable`);
      assert.equal(existsSync(paths.spoolPath), false);
    } finally {
      rmSync(paths.dir, { recursive: true, force: true });
    }
  }
});

test("card event idempotency keys distinguish different immutable bodies", async () => {
  const paths = tempPaths();
  const keys: string[] = [];
  try {
    const publisher = new MeshPublisher({
      url: "https://relay.example.test",
      token: "token",
      person: "alice",
      device: "laptop",
      fetchFn: (async (_input, init) => {
        keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return jsonResponse({ ok: true, seq: keys.length });
      }) as typeof fetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    await publisher.publish(card("release", "ship"));
    await publisher.publish(card("release", "hold"));
    assert.match(keys[0]!, /^praxis:card:[a-f0-9]{64}$/);
    assert.match(keys[1]!, /^praxis:card:[a-f0-9]{64}$/);
    assert.notEqual(keys[0], keys[1]);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("mesh text redaction removes all local path forms and secret identifiers", async () => {
  const paths = tempPaths();
  let sent = "";
  try {
    const publisher = new MeshPublisher({
      url: "https://relay.example.test",
      token: "token",
      person: "alice",
      device: "laptop",
      fetchFn: (async (_input, init) => {
        sent = String(init?.body);
        return jsonResponse({ ok: true, seq: 1 });
      }) as typeof fetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    const privateFrame = {
      ...frame("private-paths"),
      intent: "edit /opt/client-secret and D:\\work\\private but keep https://github.com/acme/app",
      uncertainty: ["also file:///Users/alice/private and \\\\server\\share\\secret"],
      artifacts: [{ repo: "praxis", path: "src/index.ts", branch: "sk-abcdefghijklmnop" }],
      sessionKey: "/Users/alice/private/session",
    } as WorkFrame;
    assert.equal((await publisher.publish(privateFrame)).ok, true);
    assert.equal(sent.includes("/opt/client-secret"), false);
    assert.equal(sent.includes("D:\\work"), false);
    assert.equal(sent.includes("file:///"), false);
    assert.equal(sent.includes("server\\share"), false);
    assert.equal(sent.includes("sk-abcdefghijklmnop"), false);
    assert.equal(sent.includes("/Users/alice"), false);
    assert.equal(sent.includes("https://github.com/acme/app"), true, "public URLs remain intact");
    const parsed = JSON.parse(sent) as WorkFrame;
    assert.equal(parsed.artifacts[0]!.branch, undefined);
    assert.equal(parsed.sessionKey, undefined);

    const huge = { ...frame("bounded-text"), intent: "x".repeat(2_000_000) };
    assert.equal((await publisher.publish(huge)).ok, true);
    assert.ok((JSON.parse(sent) as WorkFrame).intent.length <= 500);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("project allowlist blocks mismatches and accepts normalized repo URLs", async () => {
  const paths = tempPaths();
  let requests = 0;
  const fallbackFetch = (async () => {
    requests += 1;
    return jsonResponse({ ok: true, seq: requests });
  }) as typeof fetch;
  const server = createServer(async (req, res) => {
    await readRequest(req);
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, seq: requests }));
  });
  const relay = await listen(server, fallbackFetch);

  try {
    const blocked = new MeshPublisher({
      url: relay.url,
      token: "token",
      person: "alice",
      project: "git@github.com:acme/mine.git",
      projects: ["https://github.com/acme/other"],
      fetchFn: relay.fetchFn,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    assert.equal(await blocked.onEpisodeClosed(episode("episode_blocked")), undefined);
    assert.equal(requests, 0);

    const allowed = new MeshPublisher({
      url: relay.url,
      token: "token",
      person: "alice",
      project: "git@github.com:acme/mine.git",
      projects: ["https://github.com/acme/mine/"],
      fetchFn: relay.fetchFn,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    const published = await allowed.onEpisodeClosed(episode("episode_allowed"));
    assert.ok(published);
    assert.equal(requests, 1);
  } finally {
    await close(server, relay.bound);
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("an explicitly enabled publisher works when no allowlist exists", async () => {
  const paths = tempPaths();
  let requests = 0;
  const fallbackFetch = (async () => {
    requests += 1;
    return jsonResponse({ ok: true, seq: 1 });
  }) as typeof fetch;
  const server = createServer(async (req, res) => {
    await readRequest(req);
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, seq: 1 }));
  });
  const relay = await listen(server, fallbackFetch);

  try {
    const publisher = new MeshPublisher({
      url: relay.url,
      token: "token",
      person: "alice",
      project: "praxis",
      fetchFn: relay.fetchFn,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    assert.ok(await publisher.onEpisodeClosed(episode()));
    assert.equal(requests, 1);
  } finally {
    await close(server, relay.bound);
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("network failures spool frames and a later publish flushes them first", async () => {
  const paths = tempPaths();
  const rejectingFetch = (async () => {
    throw new Error("relay unavailable");
  }) as typeof fetch;

  try {
    const offline = new MeshPublisher({
      url: "http://127.0.0.1:1",
      token: "token",
      person: "alice",
      device: "laptop",
      fetchFn: rejectingFetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    const spooled = frame("frame_spooled");
    const failed = await offline.publish(spooled);
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? "", /relay unavailable/);
    const lines = readFileSync(paths.spoolPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]!), {
      spoolVersion: 1,
      scope: { teamId: null, person: "alice", device: "laptop" },
      frame: spooled,
    });

    const delivered: WorkFrame[] = [];
    const fallbackFetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      delivered.push(JSON.parse(String(init?.body)) as WorkFrame);
      return jsonResponse({ ok: true, seq: delivered.length });
    }) as typeof fetch;
    const server = createServer(async (req, res) => {
      delivered.push(JSON.parse(await readRequest(req)) as WorkFrame);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, seq: delivered.length }));
    });
    const relay = await listen(server, fallbackFetch);
    try {
      const online = new MeshPublisher({
        url: relay.url,
        token: "token",
        person: "alice",
        device: "laptop",
        fetchFn: relay.fetchFn,
        configPath: paths.configPath,
        spoolPath: paths.spoolPath,
      });
      const current = frame("frame_current");
      assert.deepEqual(await online.publish(current), { ok: true, seq: 2 });
      assert.deepEqual(delivered, [spooled, current]);
      assert.equal(existsSync(paths.spoolPath), false);
    } finally {
      await close(server, relay.bound);
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("durable spool records never cross hosted team credential scopes", async () => {
  const paths = tempPaths();
  const offline = new MeshPublisher({
    url: "https://relay.invalid",
    token: "team-a-token",
    person: "alice",
    teamId: "team-a",
    device: "device-1",
    fetchFn: (async () => { throw new Error("offline"); }) as typeof fetch,
    configPath: paths.configPath,
    spoolPath: paths.spoolPath,
  });
  const fromTeamA = frame("frame_team_a");

  try {
    assert.equal((await offline.publish(fromTeamA)).ok, false);
    assert.equal(readSpool(paths.spoolPath)[0]!.scope.teamId, "team-a");

    const delivered: Array<{ teamId: string | null; id: string }> = [];
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      delivered.push({
        teamId: headers.get("x-mesh-team-id"),
        id: (JSON.parse(String(init?.body)) as WorkFrame).id,
      });
      return jsonResponse({ ok: true, seq: delivered.length });
    }) as typeof fetch;

    const teamB = new MeshPublisher({
      url: "https://relay.invalid",
      token: "team-b-token",
      person: "alice",
      teamId: "team-b",
      device: "device-1",
      fetchFn,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    assert.deepEqual(await teamB.publish(frame("frame_team_b")), { ok: true, seq: 1 });
    assert.deepEqual(delivered, [{ teamId: "team-b", id: "frame_team_b" }]);
    assert.equal(readSpool(paths.spoolPath)[0]!.frame.id, "frame_team_a");

    const teamA = new MeshPublisher({
      url: "https://relay.invalid",
      token: "team-a-token-rotated",
      person: "alice",
      teamId: "team-a",
      device: "device-1",
      fetchFn,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    assert.deepEqual(await teamA.publish(frame("frame_team_a_current")), { ok: true, seq: 3 });
    assert.deepEqual(delivered, [
      { teamId: "team-b", id: "frame_team_b" },
      { teamId: "team-a", id: "frame_team_a" },
      { teamId: "team-a", id: "frame_team_a_current" },
    ]);
    assert.equal(existsSync(paths.spoolPath), false);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("durable spool retains only a bounded newest queue and quarantines oversized legacy data", async () => {
  const paths = tempPaths();
  try {
    const records = Array.from({ length: 300 }, (_, index) => ({
      spoolVersion: 1,
      scope: { teamId: null, person: "alice", device: "laptop" },
      frame: frame(`queued-${index}`),
    }));
    writeFileSync(paths.spoolPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
      mode: 0o600,
    });
    const offline = new MeshPublisher({
      url: "https://relay.example.test",
      token: "token",
      person: "alice",
      device: "laptop",
      fetchFn: (async () => { throw new Error("offline"); }) as typeof fetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    await offline.publish(frame("current-bounded"));
    const retained = readSpool(paths.spoolPath);
    assert.equal(retained.length, 256);
    assert.equal(retained[0]!.frame.id, "queued-45");
    assert.equal(retained.at(-1)!.frame.id, "current-bounded");

    writeFileSync(paths.spoolPath, Buffer.alloc(8 * 1024 * 1024 + 1, 120), { mode: 0o600 });
    const restarted = new MeshPublisher({
      url: "https://relay.example.test",
      token: "token",
      person: "alice",
      device: "laptop",
      fetchFn: (async () => { throw new Error("offline"); }) as typeof fetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    await restarted.publish(frame("after-quarantine"));
    assert.equal(readSpool(paths.spoolPath).length, 1);
    assert.equal(readSpool(paths.spoolPath)[0]!.frame.id, "after-quarantine");
    assert.ok(readdirSync(paths.dir).some((name) => name.startsWith("mesh-spool.ndjson.quarantine-")));
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("spool retries revalidate current project consent and drop revoked frames", async () => {
  const paths = tempPaths();
  let allowed = new Set(["praxis"]);
  const consent = (project: string) => allowed.has(project);
  try {
    const offline = new MeshPublisher({
      url: "https://relay.invalid",
      token: "token",
      person: "alice",
      device: "laptop",
      currentProjectConsent: consent,
      fetchFn: (async () => { throw new Error("offline"); }) as typeof fetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    assert.equal((await offline.publish(frame("frame_revoked"))).ok, false);

    allowed = new Set(["other"]);
    const delivered: WorkFrame[] = [];
    const online = new MeshPublisher({
      url: "https://relay.invalid",
      token: "token",
      person: "alice",
      device: "laptop",
      currentProjectConsent: consent,
      fetchFn: (async (_input, init) => {
        delivered.push(JSON.parse(String(init?.body)) as WorkFrame);
        return jsonResponse({ ok: true, seq: delivered.length });
      }) as typeof fetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    const current = { ...frame("frame_allowed"), project: "other" };
    assert.deepEqual(await online.publish(current), { ok: true, seq: 1 });
    assert.deepEqual(delivered.map((item) => item.id), ["frame_allowed"]);
    assert.equal(existsSync(paths.spoolPath), false);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("HTTP failures are returned but are not spooled", async () => {
  const paths = tempPaths();
  const fallbackFetch = (async () => new Response("unauthorized", {
    status: 401,
    headers: { "content-type": "text/plain" },
  })) as typeof fetch;
  const server = createServer(async (req, res) => {
    await readRequest(req);
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthorized");
  });
  const relay = await listen(server, fallbackFetch);

  try {
    const publisher = new MeshPublisher({
      url: relay.url,
      token: "wrong-token",
      person: "alice",
      fetchFn: relay.fetchFn,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    const result = await publisher.publish(frame("frame_rejected"));
    assert.equal(result.ok, false);
    assert.equal(result.error, "http 401: unauthorized");
    assert.equal(existsSync(paths.spoolPath), false);
  } finally {
    await close(server, relay.bound);
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("onEpisodeClosed resolves with its frame when the relay is down", async () => {
  const paths = tempPaths();
  const rejectingFetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;

  try {
    const publisher = new MeshPublisher({
      url: "http://127.0.0.1:1",
      token: "token",
      person: "alice",
      project: "praxis",
      fetchFn: rejectingFetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    const published = await publisher.onEpisodeClosed(episode("episode_offline"));
    assert.ok(published);
    assert.equal(published.kind, "workframe");
    assert.equal(published.person, "alice");
    const spooled = readSpool(paths.spoolPath)[0]!;
    assert.equal(spooled.frame.id, published.id);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("closed episodes publish as done; open episodes announce as active", async () => {
  const paths = tempPaths();
  const bodies: WorkFrame[] = [];
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as WorkFrame);
    return jsonResponse({ ok: true, seq: bodies.length });
  }) as typeof fetch;

  try {
    const publisher = new MeshPublisher({
      url: "https://relay.invalid",
      token: "token",
      person: "alice",
      project: "praxis",
      fetchFn,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    const closed = await publisher.onEpisodeClosed(episode("episode_done"));
    const active = await publisher.onEpisodeActive(episode("episode_active"));
    assert.equal(closed?.status, "done", "finished work must not read as an active edit");
    assert.equal(active?.status, "active");
    assert.deepEqual(bodies.map((b) => b.status), ["done", "active"]);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("concurrent publishes with a pending spool never double-deliver", async () => {
  const paths = tempPaths();
  // Seed the spool as if the relay had been down for two earlier frames.
  writeFileSync(
    paths.spoolPath,
    `${JSON.stringify(frame("frame_s1"))}\n${JSON.stringify(frame("frame_s2"))}\n`,
  );
  const delivered: string[] = [];
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    // Yield so unserialized flushes would interleave (double-read the spool).
    await new Promise((resolve) => setTimeout(resolve, 5));
    delivered.push((JSON.parse(String(init?.body)) as WorkFrame).id);
    return jsonResponse({ ok: true, seq: delivered.length });
  }) as typeof fetch;

  try {
    const publisher = new MeshPublisher({
      url: "https://relay.invalid",
      token: "token",
      person: "alice",
      device: "laptop",
      fetchFn,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    // The agent loop fire-and-forgets several publishes in one tick.
    await Promise.all([
      publisher.publish(frame("frame_c1")),
      publisher.publish(frame("frame_c2")),
    ]);
    assert.deepEqual(
      delivered,
      ["frame_s1", "frame_s2", "frame_c1", "frame_c2"],
      "each frame must deliver exactly once, in order",
    );
    assert.equal(existsSync(paths.spoolPath), false, "spool fully drained");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("publish is a redaction boundary: extra fields and secrets never serialize", async () => {
  const paths = tempPaths();
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return jsonResponse({ ok: true, seq: 1 });
  }) as typeof fetch;

  try {
    const publisher = new MeshPublisher({
      url: "https://relay.invalid",
      token: "token",
      person: "alice",
      fetchFn,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    const smuggled = {
      ...frame("frame_smuggle"),
      person: "mallory",
      intent: "work with sk-abcdefghijklmnop in it",
      promptBody: "RAW PROMPT BODY",
    } as WorkFrame;
    await publisher.publish(smuggled);
    assert.equal(bodies.length, 1);
    assert.ok(!("promptBody" in bodies[0]!), "unknown fields must not reach the wire");
    assert.equal(bodies[0]!.person, "alice");
    assert.equal(bodies[0]!.intent, "work with [redacted] in it");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("network retry spool stores the redacted wire frame, not the caller object", async () => {
  const paths = tempPaths();
  const rejectingFetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  try {
    const publisher = new MeshPublisher({
      url: "http://127.0.0.1:1",
      token: "token",
      person: "alice",
      fetchFn: rejectingFetch,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    const unsafe = {
      ...frame("frame_spool_redaction"),
      intent: "use sk-abcdefghijklmnop",
      promptBody: "must never be spooled",
    } as WorkFrame;
    await publisher.publish(unsafe);
    const spooled = readSpool(paths.spoolPath)[0]!;
    assert.equal(spooled.frame.intent, "use [redacted]");
    assert.ok(!("promptBody" in spooled.frame));
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("consent config supplies device and allowlist while explicit options win", async () => {
  const paths = tempPaths();
  const configPath = join(paths.dir, "mesh.json");
  writeFileSync(configPath, JSON.stringify({
    person: "config-person",
    device: "config-device",
    relayUrl: "https://config.invalid",
    token: "config-token",
    projects: ["https://github.com/acme/mine"],
  }));
  let requests = 0;
  const fallbackFetch = (async () => {
    requests += 1;
    return jsonResponse({ ok: true, seq: requests });
  }) as typeof fetch;
  const server = createServer(async (req, res) => {
    await readRequest(req);
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, seq: requests }));
  });
  const relay = await listen(server, fallbackFetch);

  try {
    const configured = new MeshPublisher({
      url: relay.url,
      token: "explicit-token",
      person: "explicit-person",
      project: "git@github.com:acme/mine.git",
      fetchFn: relay.fetchFn,
      configPath,
      spoolPath: paths.spoolPath,
    });
    const published = await configured.onEpisodeClosed(episode("episode_config"));
    assert.ok(published);
    assert.equal(published.device, "config-device");
    assert.equal(published.person, "explicit-person");

    const overridden = new MeshPublisher({
      url: relay.url,
      token: "explicit-token",
      person: "explicit-person",
      device: "explicit-device",
      project: "git@github.com:acme/mine.git",
      projects: ["https://github.com/acme/other"],
      fetchFn: relay.fetchFn,
      configPath,
      spoolPath: paths.spoolPath,
    });
    assert.equal(overridden.device, "explicit-device");
    assert.equal(await overridden.onEpisodeClosed(episode("episode_override")), undefined);
    assert.equal(requests, 1);
  } finally {
    await close(server, relay.bound);
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("fromEnv binds hosted team and device identity", () => {
  const keys = [
    "PRAXIS_MESH_URL",
    "PRAXIS_MESH_TOKEN",
    "PRAXIS_PERSON",
    "PRAXIS_MESH_TEAM_ID",
    "PRAXIS_MESH_DEVICE_ID",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.PRAXIS_MESH_URL = "https://mesh.example.test";
    process.env.PRAXIS_MESH_TOKEN = "hosted-token";
    process.env.PRAXIS_PERSON = "alice";
    process.env.PRAXIS_MESH_TEAM_ID = "team-praxis";
    process.env.PRAXIS_MESH_DEVICE_ID = "device-praxis";

    const publisher = MeshPublisher.fromEnv();
    assert.ok(publisher);
    assert.equal(publisher.teamId, "team-praxis");
    assert.equal(publisher.device, "device-praxis");
    delete process.env.PRAXIS_MESH_DEVICE_ID;
    assert.equal(MeshPublisher.fromEnv(), undefined);
    assert.throws(() => new MeshPublisher({
      url: "https://mesh.example.test",
      token: "hosted-token",
      person: "alice",
      teamId: "team-praxis",
    }), /provisioned device id/);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("episode project identity comes only from an explicit workspace consent", () => {
  const store = freshStore();
  try {
    const edit = action({
      id: "workspace-edit",
      action: "edited_file",
      startTs: "2026-07-12T12:00:00.000Z",
      payload: {
        cwd: "/Users/alice/work/app/packages/api",
        sessionKey: "session-123",
        filePath: "src/api.ts",
      },
    });
    store.actions.put(edit);
    const scoped = { ...episode("workspace-episode"), actions: [edit.id] };
    assert.equal(resolveEpisodeProject(store, scoped), undefined);

    PrivacyControlStore.forStore(store).update({
      meshProjectConsents: [{
        workspaceRoot: "/Users/alice/work/app",
        project: "git@github.com:acme/app.git",
      }],
    });
    assert.deepEqual(resolveEpisodeProject(store, scoped), {
      project: "acme/app",
      repoRoot: "/Users/alice/work/app",
      sessionKey: "session-123",
    });

    const second = action({
      id: "other-workspace-edit",
      action: "edited_file",
      startTs: "2026-07-12T12:00:01.000Z",
      payload: { cwd: "/Users/alice/work/other", sessionKey: "session-123" },
    });
    store.actions.put(second);
    assert.equal(
      resolveEpisodeProject(store, { ...scoped, actions: [edit.id, second.id] }),
      undefined,
      "an episode spanning an unconsented workspace fails closed",
    );
  } finally {
    store.close();
  }
});

test("episode project resolution canonicalizes symlinks and rejects ambiguous roots", () => {
  const paths = tempPaths();
  const store = freshStore();
  try {
    const realRoot = join(paths.dir, "real-workspace");
    const aliasRoot = join(paths.dir, "workspace-alias");
    mkdirSync(join(realRoot, "packages", "api"), { recursive: true });
    symlinkSync(realRoot, aliasRoot, "dir");
    const edit = action({
      id: "symlink-workspace-edit",
      action: "edited_file",
      startTs: "2026-07-12T12:00:00.000Z",
      payload: { cwd: join(realRoot, "packages", "api") },
    });
    store.actions.put(edit);
    const scoped = { ...episode("symlink-workspace-episode"), actions: [edit.id] };

    PrivacyControlStore.forStore(store).update({
      meshProjectConsents: [{
        workspaceRoot: aliasRoot,
        project: "git@github.com:Acme/App.git",
      }],
    });
    assert.deepEqual(resolveEpisodeProject(store, scoped), {
      project: "acme/app",
      repoRoot: realpathSync.native(realRoot),
    });

    PrivacyControlStore.forStore(store).update({
      meshProjectConsents: [
        { workspaceRoot: aliasRoot, project: "acme/app" },
        { workspaceRoot: realRoot, project: "acme/other" },
      ],
    });
    assert.equal(
      resolveEpisodeProject(store, scoped),
      undefined,
      "two projects at the same canonical root must fail closed",
    );
  } finally {
    store.close();
    rmSync(paths.dir, { recursive: true, force: true });
  }
});
