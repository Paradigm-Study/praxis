import assert from "node:assert/strict";
import { test } from "node:test";
import { makeIngest } from "../src/capture/ingest.ts";
import {
  resourceCaptureDecision,
  RuntimeStatusStore,
} from "../src/capture/runtimeStatus.ts";
import { freshStore } from "./helpers.ts";
import { fullPipeline } from "./helpers.ts";
import type { Observer } from "../src/observer/observer.ts";
import { AgentLoop } from "../src/agent/loop.ts";

test("resource transitions suspend all capture and battery-aware mode suppresses screens only", () => {
  const store = freshStore();
  const runtime = new RuntimeStatusStore();
  const ingest = makeIngest(store, { runtime });
  const event = (source: "screen_video" | "terminal", type: string) =>
    ingest.ingest({ source, app: "Test", window: "test", type });

  runtime.updateResources({ powerSource: "ac", suspended: false, batteryAware: true });
  event("screen_video", "ac-screen");
  assert.equal(store.events.count(), 1);

  runtime.updateResources({ powerSource: "battery", suspended: false, batteryAware: true });
  assert.equal(resourceCaptureDecision(runtime.read().resources, "screen_video").reason, "battery_screenshot");
  event("screen_video", "battery-screen");
  event("terminal", "battery-terminal");
  assert.equal(store.events.count(), 2, "screen suppressed, cheap terminal context retained");

  runtime.updateResources({ powerSource: "battery", suspended: true, batteryAware: true });
  assert.equal(resourceCaptureDecision(runtime.read().resources, "terminal").reason, "suspended");
  event("terminal", "suspended-terminal");
  assert.equal(store.events.count(), 2);

  runtime.updateResources({ powerSource: "ac", suspended: false, batteryAware: true });
  event("screen_video", "resumed-screen");
  assert.equal(store.events.count(), 3, "resume restores capture without changing privacy consent");
  store.close();
});

test("batteryAware false preserves full capture on battery", () => {
  const resources = {
    powerSource: "battery" as const,
    suspended: false,
    batteryAware: false,
    updatedAt: new Date().toISOString(),
  };
  assert.equal(resourceCaptureDecision(resources, "screen_video").allowed, true);
});

test("battery-aware and suspended states skip remote observer calls", async () => {
  const { store } = await fullPipeline();
  let calls = 0;
  const remote: Observer = {
    model: "remote-test",
    remote: true,
    async observe() {
      calls += 1;
      throw new Error("remote observer must not run under resource constraint");
    },
  };
  RuntimeStatusStore.forStore(store).updateResources({
    powerSource: "battery",
    suspended: false,
    batteryAware: true,
  });
  const loop = new AgentLoop(store, {
    observer: remote,
    minEpisodeActions: 1,
    observeIntervalMs: 0,
    windowMs: 10 * 365 * 86_400_000,
  });
  assert.equal(await loop.tick(), undefined);
  assert.equal(calls, 0);
  store.close();
});
