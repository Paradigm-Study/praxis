import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GitSource } from "../src/capture/sources/git.ts";
import type { RawEventInput } from "../src/capture/source.ts";
import type { RawEvent } from "../src/core/types.ts";

test("GitSource serializes slow polls and suppresses completions after stop", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const firstCall = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const events: RawEventInput[] = [];
  const source = new GitSource({
    repo: "/unused",
    intervalMs: 1,
    async runGit() {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) {
        entered();
        await gate;
      }
      active -= 1;
      return calls % 3 === 1 ? "main" : calls % 3 === 2 ? "abc123" : "";
    },
  });

  source.start((event) => {
    events.push(event);
    return event as unknown as RawEvent;
  });
  await firstCall;
  await delay(20);
  assert.equal(calls, 1, "interval callbacks do not overlap the blocked poll");
  assert.equal(maxActive, 1);
  source.stop();
  release();
  await delay(20);
  assert.deepEqual(events, [], "a stopped generation cannot emit its late snapshot");
});

test("GitSource restart establishes a fresh baseline", async () => {
  let head = "first";
  let calls = 0;
  const events: RawEventInput[] = [];
  const source = new GitSource({
    repo: "/unused",
    intervalMs: 5,
    async runGit(args) {
      calls += 1;
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
      if (args[0] === "rev-parse") return head;
      return "";
    },
  });

  source.start((event) => {
    events.push(event);
    return event as unknown as RawEvent;
  });
  const firstDeadline = Date.now() + 1_000;
  while (calls < 3 && Date.now() < firstDeadline) await delay(5);
  source.stop();
  assert.ok(calls >= 3, "first capture run established a baseline");

  const beforeRestart = calls;
  head = "second";
  source.start((event) => {
    events.push(event);
    return event as unknown as RawEvent;
  });
  const secondDeadline = Date.now() + 1_000;
  while (calls < beforeRestart + 3 && Date.now() < secondDeadline) await delay(5);
  source.stop();

  assert.ok(calls >= beforeRestart + 3, "restarted capture established another baseline");
  assert.deepEqual(events, [], "work completed while capture was stopped is not a live commit event");
});

test("GitSource performs no reads while blocked and never replays blocked changes", async () => {
  let allowed = true;
  let revision = "normal-1";
  let branch = "main";
  let head = "1111111";
  let staged = "";
  let calls = 0;
  const events: RawEventInput[] = [];
  const source = new GitSource({
    repo: "/unused",
    intervalMs: 10,
    canAcquire: () => allowed,
    acquisitionRevision: () => revision,
    async runGit(args) {
      calls += 1;
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return branch;
      if (args[0] === "rev-parse") return head;
      if (args[0] === "diff") return staged;
      if (args[0] === "log") return `subject-${head}`;
      if (args[0] === "show") return "src/visible.ts";
      return "";
    },
  });

  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (!condition() && Date.now() < deadline) await delay(5);
    assert.equal(condition(), true, "timed out waiting for GitSource state");
  };

  try {
    source.start((event) => {
      events.push(event);
      return event as unknown as RawEvent;
    });
    await waitFor(() => calls >= 3);
    await delay(5);

    allowed = false;
    revision = "private";
    head = "2222222";
    staged = " private/blocked.ts | 1 +";
    await delay(30);
    const blockedCalls = calls;
    await delay(40);
    assert.equal(calls, blockedCalls, "blocked polls never invoke Git");
    assert.equal(events.length, 0);

    allowed = true;
    revision = "normal-2";
    await waitFor(() => calls >= blockedCalls + 3);
    await delay(5);
    assert.equal(events.length, 0, "the first allowed poll only baselines blocked work");

    head = "3333333";
    staged = " src/visible.ts | 1 +";
    await waitFor(() => events.length >= 2);
    assert.deepEqual(events.map((event) => event.type), ["commit", "staged_changed"]);
    assert.equal(events[0]?.payload?.sha, "3333333");
    assert.doesNotMatch(JSON.stringify(events), /2222222|blocked\.ts/);

    // A revision transition catches a private/resume cycle even when both
    // toggles happened between Git poll callbacks.
    revision = "normal-3";
    head = "4444444";
    staged = " src/missed-private.ts | 1 +";
    const beforeRevisionBaseline = events.length;
    await delay(30);
    assert.equal(events.length, beforeRevisionBaseline);
    head = "5555555";
    staged = " src/after-revision.ts | 1 +";
    await waitFor(() => events.length >= beforeRevisionBaseline + 2);
    assert.doesNotMatch(JSON.stringify(events), /4444444|missed-private\.ts/);
  } finally {
    source.stop();
  }
});
