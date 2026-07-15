import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptureManager } from "../src/capture/manager.ts";
import type {
  CaptureSource,
  CaptureSourceStatusSink,
  EventSink,
} from "../src/capture/source.ts";
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

class ReadinessSource implements CaptureSource {
  readonly source = "accessibility" as const;
  readonly name = "native-stdin";
  start(_sink: EventSink, statusSink?: CaptureSourceStatusSink): void {
    statusSink?.({
      channel: "accessibility",
      status: "blocked",
      reason: "permission-not-granted",
    });
  }
  stop(): void {}
}

class NativeChannelSource implements CaptureSource {
  readonly source = "screen_video" as const;
  readonly name = "native-stdin";
  start(sink: EventSink, statusSink?: CaptureSourceStatusSink): void {
    statusSink?.({ channel: "screen_recording", status: "ready" });
    statusSink?.({ channel: "audio_system", status: "ready" });
    statusSink?.({ channel: "audio_mic", status: "disabled", reason: "not-requested" });
    sink({
      ts: "2026-07-13T21:00:00.000Z",
      source: "screen_video",
      app: "Preview",
      window: "Reference.pdf",
      type: "frame",
    });
    sink({
      ts: "2026-07-13T21:00:01.000Z",
      source: "audio",
      app: "Zoom",
      window: "system",
      type: "playback_state",
      payload: { channel: "system", playing: true },
    });
  }
  stop(): void {}
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

test("CaptureManager persists metadata-only producer readiness", async () => {
  const store = freshStore();
  const runtime = new RuntimeStatusStore();
  const manager = new CaptureManager(store, [new ReadinessSource()], { runtime });
  await manager.start();
  assert.deepEqual(runtime.read().sourceReadiness?.accessibility, {
    status: "blocked",
    reason: "permission-not-granted",
    updatedAt: runtime.read().sourceReadiness?.accessibility?.updatedAt,
  });
  await manager.stop();
  store.close();
});

test("CaptureManager tracks screen and audio evidence freshness by native channel", async () => {
  const store = freshStore();
  const runtime = new RuntimeStatusStore();
  const manager = new CaptureManager(store, [new NativeChannelSource()], { runtime });
  await manager.start();
  assert.deepEqual(runtime.read().channelLastEventAt, {
    screen_recording: "2026-07-13T21:00:00.000Z",
    audio_system: "2026-07-13T21:00:01.000Z",
  });
  assert.equal(runtime.read().sourceReadiness?.audio_mic?.status, "disabled");
  await manager.stop();
  store.close();
});
