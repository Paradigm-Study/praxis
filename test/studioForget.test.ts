import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { makeIngest } from "../src/capture/ingest.ts";
import { forgetRecent } from "../src/studio/server.ts";
import { action, freshStore } from "./helpers.ts";

test("forgetRecent removes the bounded window, orphaned blobs, and recent derived actions", () => {
  const store = freshStore();
  const ingest = makeIngest(store);
  const now = Date.parse("2026-07-12T22:00:00.000Z");
  const old = ingest.ingest({
    ts: "2026-07-12T20:00:00.000Z",
    source: "synthetic",
    app: "Test",
    window: "old",
    type: "old",
    blobs: [{ kind: "text", data: "keep me" }],
  });
  const recent = ingest.ingest({
    ts: "2026-07-12T21:50:00.000Z",
    source: "synthetic",
    app: "Test",
    window: "recent",
    type: "recent",
    blobs: [{ kind: "text", data: "forget me" }],
  });
  store.actions.put(action({
    id: "old-action",
    action: "edited_file",
    startTs: old.ts,
    endTs: old.ts,
  }));
  store.actions.put(action({
    id: "recent-action",
    action: "edited_file",
    startTs: recent.ts,
    endTs: recent.ts,
  }));
  const recentBlob = store.blobs.record(recent.blobRefs[0]!)!;
  assert.equal(existsSync(recentBlob.path), true);

  const result = forgetRecent(store, 20, now);

  assert.equal(result.events, 1);
  assert.equal(result.actions, 1);
  assert.equal(result.blobs, 1);
  assert.equal(store.events.get(old.id)?.id, old.id);
  assert.equal(store.events.get(recent.id), undefined);
  assert.equal(store.actions.byIds(["old-action"]).length, 1);
  assert.equal(store.actions.byIds(["recent-action"]).length, 0);
  assert.equal(store.blobs.has(old.blobRefs[0]!), true);
  assert.equal(store.blobs.has(recent.blobRefs[0]!), false);
  assert.equal(existsSync(recentBlob.path), false);
  store.close();
});

test("forgetRecent validates its destructive window", () => {
  const store = freshStore();
  assert.throws(() => forgetRecent(store, 0), /minutes/);
  assert.throws(() => forgetRecent(store, 1.5), /minutes/);
  assert.throws(() => forgetRecent(store, 1441), /minutes/);
  store.close();
});
