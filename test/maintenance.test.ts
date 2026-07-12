import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { makeIngest } from "../src/capture/ingest.ts";
import { runMaintenance, storageUsage } from "../src/storage/maintenance.ts";
import { freshStore } from "./helpers.ts";

test("maintenance expires media sooner, preserves shared blobs, then collects the orphan", () => {
  const store = freshStore();
  const ingest = makeIngest(store);
  const oldMedia = ingest.ingest({
    ts: "2026-06-01T00:00:00.000Z",
    source: "screen_video",
    app: "Editor",
    window: "work",
    type: "frame",
    blobs: [{ kind: "image", data: "shared-image" }],
  });
  const retained = ingest.ingest({
    ts: "2026-07-10T00:00:00.000Z",
    source: "synthetic",
    app: "Editor",
    window: "work",
    type: "reference",
    blobRefs: [oldMedia.blobRefs[0]!],
  });
  const path = store.blobs.record(oldMedia.blobRefs[0]!)!.path;
  const policy = {
    version: 1 as const,
    rawDays: 30,
    mediaDays: 7,
    derivedDays: 90,
    maxBytes: Number.MAX_SAFE_INTEGER,
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const first = runMaintenance(store, policy, Date.parse("2026-07-12T00:00:00.000Z"));
  assert.equal(first.eventsDeleted, 1);
  assert.equal(first.blobsDeleted, 0);
  assert.ok(store.events.get(retained.id));
  assert.equal(existsSync(path), true);

  store.db.prepare("DELETE FROM raw_events WHERE id = ?").run(retained.id);
  const second = runMaintenance(store, policy, Date.parse("2026-07-12T00:00:00.000Z"));
  assert.equal(second.blobsDeleted, 1);
  assert.equal(existsSync(path), false);
  store.close();
});

test("storage usage accounts for persisted blob bytes", () => {
  const store = freshStore();
  makeIngest(store).ingest({
    source: "synthetic",
    app: "Test",
    window: "test",
    type: "blob",
    blobs: [{ kind: "text", data: "x".repeat(1024) }],
  });
  const usage = storageUsage(store);
  assert.ok(usage.blobBytes >= 1024);
  assert.equal(usage.blobs, 1);
  store.close();
});
