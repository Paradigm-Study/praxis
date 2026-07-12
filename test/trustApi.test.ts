import assert from "node:assert/strict";
import { test } from "node:test";
import type { Server } from "node:http";
import { startStudio } from "../src/studio/server.ts";
import { EgressAuditor } from "../src/privacy/egress.ts";
import { RuntimeStatusStore } from "../src/capture/runtimeStatus.ts";
import { freshStore } from "./helpers.ts";

async function portOf(server: Server): Promise<number> {
  if (!server.address()) await new Promise((resolve) => server.once("listening", resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("trust APIs round-trip privacy, pause/runtime, egress, and retention", async () => {
  const store = freshStore();
  RuntimeStatusStore.forStore(store).write({ state: "running", activeSources: ["synthetic"], pid: 42 });
  EgressAuditor.forStore(store).record({
    destination: "https://api.example.test/v1",
    purpose: "test",
    categories: ["metadata"],
    bytes: 12,
    outcome: "succeeded",
  });
  const server = startStudio(store, 0);
  const port = await portOf(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const privacy = await fetch(`${base}/api/privacy`).then((r) => r.json()) as { mode: string };
    assert.equal(privacy.mode, "normal");

    const updated = await fetch(`${base}/api/privacy`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ ...privacy, cloudObserverConsent: true, screenshotConsent: false }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json() as { cloudObserverConsent: boolean }).cloudObserverConsent, true);

    const pause = await fetch(`${base}/api/capture/pause`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ minutes: 5 }),
    });
    assert.equal((await pause.json() as { mode: string }).mode, "paused");
    const resume = await fetch(`${base}/api/capture/resume`, {
      method: "POST",
      headers: { origin: base },
    });
    assert.equal((await resume.json() as { mode: string }).mode, "normal");

    const runtime = await fetch(`${base}/api/capture/status`).then((r) => r.json()) as { state: string };
    assert.equal(runtime.state, "running");
    const resources = await fetch(`${base}/api/runtime/resources`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ powerSource: "battery", suspended: true, batteryAware: true }),
    });
    const resourceStatus = await resources.json() as {
      effectiveState: string;
      resources: { powerSource: string; suspended: boolean; batteryAware: boolean; updatedAt: string };
    };
    assert.equal(resourceStatus.effectiveState, "suspended");
    assert.deepEqual(resourceStatus.resources, {
      powerSource: "battery",
      suspended: true,
      batteryAware: true,
      updatedAt: resourceStatus.resources.updatedAt,
    });
    const egress = await fetch(`${base}/api/egress`).then((r) => r.json()) as Array<{ purpose: string }>;
    assert.equal(egress[0]?.purpose, "test");

    const retention = await fetch(`${base}/api/storage/retention`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ rawDays: 20, mediaDays: 3, derivedDays: 60, maxBytes: 123456 }),
    });
    assert.equal((await retention.json() as { rawDays: number }).rawDays, 20);
    const status = await fetch(`${base}/api/storage/status`).then((r) => r.json()) as {
      usage: { totalBytes: number };
      retention: { mediaDays: number };
    };
    assert.equal(status.retention.mediaDays, 3);
    assert.equal(typeof status.usage.totalBytes, "number");
  } finally {
    await close(server);
    store.close();
  }
});

test("Studio mutations reject bodies larger than 64 KiB", async () => {
  const store = freshStore();
  const server = startStudio(store, 0);
  const port = await portOf(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/correction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetKind: "claim", targetId: "c", verdict: "edited", note: "x".repeat(70_000) }),
    });
    assert.equal(response.status, 413);
  } finally {
    await close(server);
    store.close();
  }
});
