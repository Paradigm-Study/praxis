import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ClipboardSource } from "../src/capture/sources/clipboard.ts";
import type { RawEventInput } from "../src/capture/source.ts";
import type { RawEvent } from "../src/core/types.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), "condition became true before timeout");
}

test("clipboard startup and privacy gaps establish silent baselines", async () => {
  let value = "copied before Praxis started";
  let allowed = true;
  let reads = 0;
  const events: RawEventInput[] = [];
  const source = new ClipboardSource({
    intervalMs: 5,
    frontApp: () => ({ app: allowed ? "Editor" : "Vault", window: "Document" }),
    canAcquire: () => allowed,
    readClipboard: async () => {
      reads += 1;
      return value;
    },
  });
  source.start((event) => {
    events.push(event);
    return event as unknown as RawEvent;
  });
  try {
    await waitFor(() => reads >= 1);
    assert.equal(events.length, 0, "pre-existing clipboard content is not a copy action");

    value = "new allowed copy";
    await waitFor(() => events.length === 1);
    assert.equal(events[0]?.payload?.text, value);

    allowed = false;
    value = "copied while private";
    const readsBeforePrivacy = reads;
    await delay(25);
    assert.equal(reads, readsBeforePrivacy, "denied polls do not execute pbpaste");

    allowed = true;
    await waitFor(() => reads > readsBeforePrivacy);
    await delay(15);
    assert.equal(events.length, 1, "private clipboard content is consumed only as a baseline");

    value = "copy after privacy ended";
    await waitFor(() => events.length === 2);
    assert.equal(events[1]?.payload?.text, value);
  } finally {
    source.stop();
  }
});

test("clipboard serializes slow reads and ignores a completion after stop", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const firstRead = new Promise<void>((resolve) => { entered = resolve; });
  let reads = 0;
  const events: RawEventInput[] = [];
  const source = new ClipboardSource({
    intervalMs: 1,
    readClipboard: async () => {
      reads += 1;
      if (reads === 1) {
        entered();
        await gate;
      }
      return "late value";
    },
  });
  source.start((event) => {
    events.push(event);
    return event as unknown as RawEvent;
  });
  await firstRead;
  await delay(20);
  assert.equal(reads, 1, "poll intervals cannot overlap one slow clipboard read");
  source.stop();
  release();
  await delay(20);
  assert.deepEqual(events, []);
});
