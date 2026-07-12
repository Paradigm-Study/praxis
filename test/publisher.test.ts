import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Episode } from "../src/core/types.ts";
import { MeshPublisher } from "../src/mesh/publisher.ts";
import type { WorkFrame } from "../src/mesh/types.ts";

interface RequestRecord {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
  body: string;
}

interface RelayListener {
  url: string;
  fetchFn: typeof fetch;
  bound: boolean;
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
          url: "http://publisher-test.invalid",
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
    assert.deepEqual(JSON.parse(requests[0]!.body), sent);
  } finally {
    await close(server, relay.bound);
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
    assert.deepEqual(JSON.parse(lines[0]!), spooled);

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
    const spooled = JSON.parse(readFileSync(paths.spoolPath, "utf8").trim()) as WorkFrame;
    assert.equal(spooled.id, published.id);
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
      url: "http://relay.invalid",
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
      url: "http://relay.invalid",
      token: "token",
      person: "alice",
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
      url: "http://relay.invalid",
      token: "token",
      person: "alice",
      fetchFn,
      configPath: paths.configPath,
      spoolPath: paths.spoolPath,
    });
    const smuggled = {
      ...frame("frame_smuggle"),
      intent: "work with sk-abcdefghijklmnop in it",
      promptBody: "RAW PROMPT BODY",
    } as WorkFrame;
    await publisher.publish(smuggled);
    assert.equal(bodies.length, 1);
    assert.ok(!("promptBody" in bodies[0]!), "unknown fields must not reach the wire");
    assert.equal(bodies[0]!.intent, "work with [redacted] in it");
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
