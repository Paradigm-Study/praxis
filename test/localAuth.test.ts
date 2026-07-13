import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { makeIngest } from "../src/capture/ingest.ts";
import { AiProxySource } from "../src/capture/sources/aiProxy.ts";
import { startAiProxy } from "../src/capture/sources/aiProxyServer.ts";
import { constantTimeTokenEqual } from "../src/security/localAuth.ts";
import { startStudio } from "../src/studio/server.ts";
import { freshStore } from "./helpers.ts";

const TOKEN = "a".repeat(64);

async function portOf(server: Server): Promise<number> {
  if (!server.address()) await new Promise((resolve) => server.once("listening", resolve));
  return (server.address() as { port: number }).port;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as { port: number }).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("token comparison accepts only the exact high-entropy secret", () => {
  assert.equal(constantTimeTokenEqual(TOKEN, TOKEN), true);
  assert.equal(constantTimeTokenEqual(TOKEN, "a".repeat(63)), false);
  assert.equal(constantTimeTokenEqual(TOKEN, undefined), false);
});

test("Studio health is minimal while reads and mutations require bearer auth", async () => {
  const previous = process.env.PRAXIS_LOCAL_TOKEN;
  process.env.PRAXIS_LOCAL_TOKEN = TOKEN;
  const store = freshStore();
  const server = startStudio(store, 0);
  const port = await portOf(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/privacy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "private" }),
    })).status, 401);

    const authorized = { authorization: `Bearer ${TOKEN}` };
    assert.equal((await fetch(`${base}/api/status`, { headers: authorized })).status, 200);
    const mutation = await fetch(`${base}/api/privacy`, {
      method: "PUT",
      headers: { ...authorized, "content-type": "application/json", origin: base },
      body: JSON.stringify({ mode: "private" }),
    });
    assert.equal(mutation.status, 200);
    assert.equal((await mutation.json() as { mode: string }).mode, "private");

    const projectMutation = await fetch(`${base}/api/mesh/projects`, {
      method: "PUT",
      headers: { ...authorized, "content-type": "application/json", origin: base },
      body: JSON.stringify({
        projects: [{ workspaceRoot: "/Users/alice/work/app/", project: "https://github.com/acme/app" }],
      }),
    });
    assert.equal(projectMutation.status, 200);
    assert.deepEqual(await projectMutation.json(), {
      projects: [{ workspaceRoot: "/Users/alice/work/app", project: "https://github.com/acme/app" }],
    });
    assert.deepEqual(await (await fetch(`${base}/api/mesh/projects`, { headers: authorized })).json(), {
      projects: [{ workspaceRoot: "/Users/alice/work/app", project: "https://github.com/acme/app" }],
    });
  } finally {
    await close(server);
    store.close();
    if (previous === undefined) delete process.env.PRAXIS_LOCAL_TOKEN;
    else process.env.PRAXIS_LOCAL_TOKEN = previous;
  }
});

test("AI proxy requires Proxy-Authorization and never forwards the local token", async () => {
  let upstreamRequests = 0;
  let upstreamProviderAuth: string | undefined;
  let upstreamProxyAuth: string | undefined;
  const upstream = createServer((req, res) => {
    upstreamRequests += 1;
    upstreamProviderAuth = req.headers.authorization;
    upstreamProxyAuth = req.headers["proxy-authorization"] as string | undefined;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [] }));
    });
  });
  const upstreamPort = await listen(upstream);
  const store = freshStore();
  const source = new AiProxySource();
  source.start(makeIngest(store).ingest);
  const proxy = startAiProxy({
    source,
    store,
    port: 0,
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    authToken: TOKEN,
  });
  const port = await portOf(proxy);
  try {
    const body = JSON.stringify({ model: "test", messages: [] });
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST", body,
    })).status, 401);
    assert.equal(upstreamRequests, 0);

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer provider-secret",
        "proxy-authorization": `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamRequests, 1);
    assert.equal(upstreamProviderAuth, "Bearer provider-secret");
    assert.equal(upstreamProxyAuth, undefined);
  } finally {
    await close(proxy);
    await close(upstream);
    store.close();
  }
});
