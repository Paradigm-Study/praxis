import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/storage/index.ts";
import { newId } from "../src/core/ids.ts";
import { hashEventContent } from "../src/core/hash.ts";
import type { RawEvent } from "../src/core/types.ts";

function ev(over: Partial<RawEvent> = {}): RawEvent {
  const base = {
    ts: over.ts ?? "2026-06-08T12:00:00.000Z",
    source: over.source ?? ("terminal" as const),
    app: over.app ?? "iTerm2",
    window: over.window ?? "zsh",
    type: over.type ?? "command_run",
    payload: over.payload ?? { cmd: "ls" },
    blobRefs: over.blobRefs ?? [],
  };
  return { id: over.id ?? newId("event"), ...base, hash: hashEventContent(base) };
}

test("events: append, dedupe by id, getByHash", () => {
  const s = openStore({ memory: true });
  const e = ev();
  s.events.append(e);
  s.events.append(e); // INSERT OR IGNORE
  assert.equal(s.events.count(), 1);
  assert.equal(s.events.getByHash(e.hash)?.id, e.id);
  assert.deepEqual(s.events.get(e.id)?.payload, { cmd: "ls" });
  s.close();
});

test("events: range filters by source and time", () => {
  const s = openStore({ memory: true });
  s.events.append(ev({ ts: "2026-06-08T12:00:00.000Z", source: "terminal" }));
  s.events.append(ev({ ts: "2026-06-08T12:00:05.000Z", source: "git", type: "commit" }));
  assert.equal(s.events.range({ sources: ["git"] }).length, 1);
  assert.equal(s.events.range({ startTs: "2026-06-08T12:00:03.000Z" }).length, 1);
  s.close();
});

test("blobs: content-addressed, idempotent, roundtrip", () => {
  const s = openStore({ memory: true });
  const a = s.blobs.put("text", "hello world");
  const b = s.blobs.put("text", "hello world");
  assert.equal(a.hash, b.hash); // same content → same hash
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number }).n, 1);
  assert.equal(s.blobs.getText(a.hash), "hello world");
  assert.ok(s.blobs.has(a.hash));
  s.close();
});

test("actions: byIds preserves request order", () => {
  const s = openStore({ memory: true });
  const mk = (id: string, ts: string) => ({
    id, type: "user_action" as const, action: "ran_command", app: "iTerm2",
    startTs: ts, endTs: ts, confidence: 0.9, evidence: ["e"],
  });
  s.actions.put(mk("a2", "2026-06-08T12:00:02.000Z"));
  s.actions.put(mk("a1", "2026-06-08T12:00:01.000Z"));
  assert.deepEqual(s.actions.byIds(["a1", "a2"]).map((a) => a.id), ["a1", "a2"]);
  s.close();
});

test("graph: edge dedup via hasEdge", () => {
  const s = openStore({ memory: true });
  const n = { id: "n1", kind: "know_how", label: "x", confidence: 0.8, createdTs: "t", updatedTs: "t" };
  s.graph.putNode(n);
  s.graph.putEdge({ id: "e1", from: "n1", to: "ep1", kind: "observed_in_episode", createdTs: "t" });
  assert.ok(s.graph.hasEdge("n1", "ep1", "observed_in_episode"));
  assert.equal(s.graph.findNode("know_how", "x")?.id, "n1");
  s.close();
});
