import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { CaptureManager } from "../src/capture/manager.ts";
import {
  type CaptureRuntimeStatus,
  RuntimeStatusStore,
} from "../src/capture/runtimeStatus.ts";
import type { CaptureSource, EventSink } from "../src/capture/source.ts";
import { NativeCaptureSource } from "../src/capture/sources/nativeBridge.ts";
import { freshStore } from "./helpers.ts";

const NATIVE_CHANNELS = [
  "accessibility",
  "screen_recording",
  "audio_system",
  "audio_mic",
] as const;

class RecordingRuntimeStatusStore extends RuntimeStatusStore {
  readonly snapshots: CaptureRuntimeStatus[] = [];

  override write(patch: Partial<CaptureRuntimeStatus>): CaptureRuntimeStatus {
    const next = super.write(patch);
    this.snapshots.push(next);
    return next;
  }
}

class SteadySource implements CaptureSource {
  readonly name = "steady";
  readonly source = "synthetic" as const;
  start(_sink: EventSink): void {}
  stop(): void {}
}

function exitingNative(exitCode: number, delayMs = 100): NativeCaptureSource {
  const ready = JSON.stringify({
    source: "capture_control",
    type: "source_status",
    payload: { channel: "accessibility", status: "ready" },
  });
  return new NativeCaptureSource({
    command: process.execPath,
    args: [
      "-e",
      `process.stdout.write(${JSON.stringify(`${ready}\n`)});` +
        `setTimeout(() => process.exit(${exitCode}), ${delayMs});`,
    ],
  });
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${description}`);
}

function assertNativeUnavailable(
  runtime: CaptureRuntimeStatus,
  reason: "start-failed" | "process-exited",
): void {
  for (const channel of NATIVE_CHANNELS) {
    assert.equal(runtime.sourceReadiness?.[channel]?.status, "unavailable", channel);
    assert.equal(runtime.sourceReadiness?.[channel]?.reason, reason, channel);
  }
}

test("native spawn failure rejects manager start and clears stale readiness", async () => {
  const store = freshStore();
  const runtime = new RuntimeStatusStore();
  const missing = new NativeCaptureSource({
    command: `/definitely/missing/praxis-capture-${process.pid}`,
  });
  const manager = new CaptureManager(store, [missing], { runtime });
  try {
    await assert.rejects(manager.start(), /failed to start|ENOENT/i);
    const status = runtime.read();
    assert.equal(status.state, "failed");
    assert.deepEqual(status.activeSources, []);
    assert.match(status.lastError ?? "", /failed to start|ENOENT/i);
    assertNativeUnavailable(status, "start-failed");
  } finally {
    await manager.stop();
    store.close();
  }
});

test("a native child that reports ready then exits becomes limited, not healthy", async () => {
  const store = freshStore();
  const runtime = new RecordingRuntimeStatusStore();
  const manager = new CaptureManager(
    store,
    [exitingNative(7, 120), new SteadySource()],
    { runtime },
  );
  try {
    await manager.start();
    await waitFor(
      () => runtime.read().lastError?.includes("process-exited") === true,
      "native process exit propagation",
    );

    assert.ok(
      runtime.snapshots.some(
        (snapshot) => snapshot.sourceReadiness?.accessibility?.status === "ready",
      ),
      "the child readiness report reached runtime before it exited",
    );
    const status = runtime.read();
    assert.equal(status.state, "running", "the independent steady source remains live");
    assert.deepEqual(status.activeSources, ["steady"]);
    assert.match(status.lastError ?? "", /native process-exited.*code 7/i);
    assertNativeUnavailable(status, "process-exited");
  } finally {
    await manager.stop();
    store.close();
  }
});

test("an immediate native exit cannot leave a buffered ready status behind", async () => {
  const store = freshStore();
  const runtime = new RuntimeStatusStore();
  const manager = new CaptureManager(store, [exitingNative(9, 0)], { runtime });
  try {
    await manager.start().catch((error: unknown) => {
      assert.match(String(error), /process-exited|exited unexpectedly/i);
    });
    await waitFor(() => runtime.read().state === "failed", "failed capture state");
    const status = runtime.read();
    assert.deepEqual(status.activeSources, []);
    assert.match(status.lastError ?? "", /native process-exited.*code 9/i);
    assertNativeUnavailable(status, "process-exited");
  } finally {
    await manager.stop();
    store.close();
  }
});
