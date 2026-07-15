import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MeshPublisher } from "../src/mesh/publisher.ts";
import { isMeshProjectConsented } from "../src/mesh/projectConsent.ts";
import type { SyncVerification } from "../src/mesh/types.ts";
import { PrivacyControlStore } from "../src/privacy/control.ts";
import { startStudio } from "../src/studio/server.ts";
import { freshStore } from "./helpers.ts";

const TOKEN = "v".repeat(64);

async function portOf(server: Server): Promise<number> {
  if (!server.address()) await new Promise((resolve) => server.once("listening", resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
}

test("POST /api/mesh/verify requires local auth and a currently saved project consent", async () => {
  const previousToken = process.env.PRAXIS_LOCAL_TOKEN;
  process.env.PRAXIS_LOCAL_TOKEN = TOKEN;
  const directory = mkdtempSync(join(tmpdir(), "praxis-mesh-verify-"));
  const store = freshStore();
  const requests: Array<{ body: SyncVerification; idempotencyKey: string | null }> = [];
  const publisher = new MeshPublisher({
    url: "https://relay.invalid",
    token: "relay-token",
    person: "member-alice",
    teamId: "team-praxis",
    device: "device-alice",
    store,
    fetchFn: (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        body: JSON.parse(String(init?.body)) as SyncVerification,
        idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
      });
      return new Response(JSON.stringify({ ok: true, seq: 23 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
    currentProjectConsent: (project) => isMeshProjectConsented(
      PrivacyControlStore.forStore(store).read().meshProjectConsents,
      project,
    ),
    configPath: join(directory, "missing-config.json"),
    spoolPath: join(directory, "spool.ndjson"),
  });
  const server = startStudio(store, 0, { meshPublisher: publisher });
  const port = await portOf(server);
  const base = `http://127.0.0.1:${port}`;
  const authorized = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
  const verification = { project: "acme/app", teamId: "team-praxis", deviceId: "device-alice" };

  try {
    assert.equal((await fetch(`${base}/api/mesh/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(verification),
    })).status, 401);

    const invalid = await fetch(`${base}/api/mesh/verify`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ ...verification, project: "/Users/alice/work/app" }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { ok: false, error: "project identity is invalid" });

    const missingScope = await fetch(`${base}/api/mesh/verify`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ project: "acme/app" }),
    });
    assert.equal(missingScope.status, 400);
    assert.deepEqual(await missingScope.json(), {
      ok: false,
      error: "team relay scope is required",
    });

    const beforeConsent = await fetch(`${base}/api/mesh/verify`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify(verification),
    });
    assert.equal(beforeConsent.status, 403);
    assert.deepEqual(await beforeConsent.json(), {
      ok: false,
      error: "project is not currently consented",
    });
    assert.equal(requests.length, 0);

    PrivacyControlStore.forStore(store).update({
      meshProjectConsents: [{
        workspaceRoot: "/Users/alice/work/app",
        project: "git@github.com:Acme/App.git",
      }],
    });
    const verified = await fetch(`${base}/api/mesh/verify`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ ...verification, project: "https://github.com/acme/app" }),
    });
    assert.equal(verified.status, 200);
    assert.deepEqual(await verified.json(), { ok: true, seq: 23 });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]!.body, {
      v: 0,
      kind: "sync_verification",
      person: "member-alice",
      device: "device-alice",
      ts: requests[0]!.body.ts,
    });
    assert.match(requests[0]!.idempotencyKey ?? "", /^praxis:sync:[a-f0-9]{64}$/);

    const staleScope = await fetch(`${base}/api/mesh/verify`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ ...verification, teamId: "team-other" }),
    });
    assert.equal(staleScope.status, 409);
    assert.deepEqual(await staleScope.json(), {
      ok: false,
      error: "team relay scope changed; restart required",
    });
    assert.equal(requests.length, 1, "scope mismatch is rejected before relay egress");

    PrivacyControlStore.forStore(store).update({ meshProjectConsents: [] });
    const revoked = await fetch(`${base}/api/mesh/verify`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify(verification),
    });
    assert.equal(revoked.status, 403);
    assert.equal(requests.length, 1, "revoked consent prevents another egress");
  } finally {
    await close(server);
    store.close();
    rmSync(directory, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env.PRAXIS_LOCAL_TOKEN;
    else process.env.PRAXIS_LOCAL_TOKEN = previousToken;
  }
});

test("POST /api/mesh/verify reports an unavailable relay without fabricating readiness", async () => {
  const previousToken = process.env.PRAXIS_LOCAL_TOKEN;
  process.env.PRAXIS_LOCAL_TOKEN = TOKEN;
  const store = freshStore();
  PrivacyControlStore.forStore(store).update({
    meshProjectConsents: [{ workspaceRoot: "/workspace/app", project: "acme/app" }],
  });
  const server = startStudio(store, 0, { meshPublisher: null });
  const port = await portOf(server);
  const base = `http://127.0.0.1:${port}`;

  try {
    const response = await fetch(`${base}/api/mesh/verify`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ project: "acme/app", teamId: "team-praxis", deviceId: "device-alice" }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "team relay is not configured",
    });
  } finally {
    await close(server);
    store.close();
    if (previousToken === undefined) delete process.env.PRAXIS_LOCAL_TOKEN;
    else process.env.PRAXIS_LOCAL_TOKEN = previousToken;
  }
});
