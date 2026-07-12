import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptureManager } from "../src/capture/manager.ts";
import type { CaptureSource, EventSink } from "../src/capture/source.ts";
import { RuntimeStatusStore } from "../src/capture/runtimeStatus.ts";
import { freshStore } from "./helpers.ts";

class FakeSource implements CaptureSource {
  readonly source = "synthetic" as const;
  readonly name: string;
  private readonly log: string[];
  private readonly fail: boolean;
  constructor(
    name: string,
    log: string[],
    fail = false,
  ) {
    this.name = name;
    this.log = log;
    this.fail = fail;
  }
  start(_sink: EventSink): void {
    this.log.push(`start:${this.name}`);
    if (this.fail) throw new Error(`failed:${this.name}`);
  }
  stop(): void {
    this.log.push(`stop:${this.name}`);
  }
}

test("CaptureManager rolls back partial starts in reverse order and reports failure", async () => {
  const store = freshStore();
  const log: string[] = [];
  const runtime = new RuntimeStatusStore();
  const manager = new CaptureManager(store, [
    new FakeSource("one", log),
    new FakeSource("two", log),
    new FakeSource("boom", log, true),
  ], { runtime });
  await assert.rejects(manager.start(), /failed:boom/);
  assert.deepEqual(log, ["start:one", "start:two", "start:boom", "stop:boom", "stop:two", "stop:one"]);
  assert.equal(runtime.read().state, "failed");
  assert.deepEqual(runtime.read().activeSources, []);
  store.close();
});

test("CaptureManager start/stop are idempotent and stop sources in reverse order", async () => {
  const store = freshStore();
  const log: string[] = [];
  const runtime = new RuntimeStatusStore();
  const manager = new CaptureManager(store, [new FakeSource("one", log), new FakeSource("two", log)], { runtime });
  await manager.start();
  await manager.start();
  await manager.stop();
  await manager.stop();
  assert.deepEqual(log, ["start:one", "start:two", "stop:two", "stop:one"]);
  assert.equal(runtime.read().state, "stopped");
  store.close();
});
