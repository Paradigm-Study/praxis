import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { makeIngest } from "../src/capture/ingest.ts";
import {
  resourceCaptureDecision,
  RuntimeStatusStore,
  startupInterpretationStatus,
} from "../src/capture/runtimeStatus.ts";
import { freshStore } from "./helpers.ts";
import { fullPipeline } from "./helpers.ts";
import type { Observer } from "../src/observer/observer.ts";
import { AgentLoop } from "../src/agent/loop.ts";
import { PrivacyControlStore } from "../src/privacy/control.ts";

test("configured remote interpretation starts without a false unavailable reason", () => {
  assert.deepEqual(startupInterpretationStatus({
    useModel: true,
    modelActive: true,
    cloudConsent: true,
    credentialPresent: true,
    model: "claude-test",
  }), {
    requested: "anthropic",
    active: "model",
    status: "configured",
    model: "claude-test",
  });
  assert.equal(startupInterpretationStatus({
    useModel: true,
    modelActive: false,
    cloudConsent: true,
    credentialPresent: false,
  }).reason, "credential-missing");
});

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

test("remote interpretation health records real success and runtime failure", async () => {
  const successful = await fullPipeline();
  PrivacyControlStore.forStore(successful.store).update({
    cloudObserverConsent: true,
    screenshotConsent: false,
  });
  const successRuntime = RuntimeStatusStore.forStore(successful.store);
  successRuntime.write({
    interpretation: {
      requested: "anthropic",
      active: "model",
      status: "ready",
      model: "remote-test",
    },
  });
  const remote: Observer = {
    model: "remote-test",
    remote: true,
    async observe(bundle, opts) {
      return {
        id: opts?.newId?.("obs") ?? "obs_remote",
        bundleId: bundle.id,
        episodeId: opts?.episodeId,
        acceptedOptions: [],
        rejectedOptions: [],
        uncertainty: [],
        evidence: bundle.actions.map((action) => action.id),
        model: "remote-test",
        createdTs: "2026-07-13T20:00:00.000Z",
      };
    },
  };
  await new AgentLoop(successful.store, {
    observer: remote,
    minEpisodeActions: 1,
    observeIntervalMs: 0,
    windowMs: 10 * 365 * 86_400_000,
  }).tick();
  assert.equal(successRuntime.read().interpretation?.lastSuccessAt, "2026-07-13T20:00:00.000Z");
  successful.store.close();

  const failed = await fullPipeline();
  PrivacyControlStore.forStore(failed.store).update({
    cloudObserverConsent: true,
    screenshotConsent: false,
  });
  const failureRuntime = RuntimeStatusStore.forStore(failed.store);
  failureRuntime.write({
    interpretation: {
      requested: "anthropic",
      active: "model",
      status: "ready",
      model: "remote-test",
    },
  });
  let attempts = 0;
  const failing: Observer = {
    model: "remote-test",
    remote: true,
    async observe(bundle, opts) {
      attempts += 1;
      if (attempts === 1) throw new Error("provider unavailable");
      return {
        id: opts?.newId?.("obs") ?? "obs_retry",
        bundleId: bundle.id,
        episodeId: opts?.episodeId,
        acceptedOptions: [],
        rejectedOptions: [],
        uncertainty: [],
        evidence: bundle.actions.map((action) => action.id),
        model: "remote-test",
        createdTs: "2026-07-13T20:01:00.000Z",
      };
    },
  };
  const retryingLoop = new AgentLoop(failed.store, {
    observer: failing,
    minEpisodeActions: 1,
    observeIntervalMs: 0,
    windowMs: 10 * 365 * 86_400_000,
  });
  await assert.rejects(
    retryingLoop.tick(),
    /provider unavailable/,
  );
  assert.deepEqual(
    {
      active: failureRuntime.read().interpretation?.active,
      status: failureRuntime.read().interpretation?.status,
      reason: failureRuntime.read().interpretation?.reason,
    },
    { active: "none", status: "failed", reason: "runtime-error" },
  );
  assert.match(failureRuntime.read().interpretation?.lastError ?? "", /provider unavailable/);
  assert.ok(await retryingLoop.tick(), "the unchanged episode retries after failure");
  assert.equal(attempts, 2);
  assert.equal(failureRuntime.read().interpretation?.status, "ready");
  failed.store.close();
});

test("attach repairs historical projections without waiting for a stream event", async () => {
  const store = freshStore();
  store.actions.put({
    id: "stale_action",
    type: "user_action",
    action: "opened_file",
    app: "Test",
    startTs: "2026-07-13T00:00:00.000Z",
    endTs: "2026-07-13T00:00:00.000Z",
    confidence: 0.4,
    evidence: ["missing_event"],
  });
  const loop = new AgentLoop(store, {
    debounceMs: 0,
    minEpisodeActions: 99,
    observeIntervalMs: 0,
  });
  const detach = loop.attach({ subscribe: () => () => undefined });
  try {
    for (let attempt = 0; attempt < 20 && store.actions.get("stale_action"); attempt += 1) {
      await delay(10);
    }
    assert.equal(store.actions.get("stale_action"), undefined);
  } finally {
    detach();
    store.close();
  }
});

test("a graph projection failure leaves the same episode immediately retryable", async () => {
  const { store } = await fullPipeline();
  const originalPutNode = store.graph.putNode;
  let observerCalls = 0;
  const observer = {
    model: "retry-projection-observer",
    async observe(bundle: { id: string }, opts?: { episodeId?: string; newId?: (prefix: string) => string }) {
      observerCalls += 1;
      if (observerCalls === 1) {
        store.graph.putNode = () => {
          throw new Error("injected projection failure");
        };
      }
      return {
        id: opts?.newId?.("obs") ?? `obs_projection_${observerCalls}`,
        bundleId: bundle.id,
        episodeId: opts?.episodeId,
        decisionPoint: "Require verified evidence before rollout",
        acceptedOptions: [],
        rejectedOptions: [],
        uncertainty: [],
        evidence: [],
        model: "retry-projection-observer",
        createdTs: `2026-07-13T20:00:0${observerCalls}.000Z`,
      };
    },
  };
  const loop = new AgentLoop(store, {
    observer,
    minEpisodeActions: 1,
    observeIntervalMs: 0,
    windowMs: 10 * 365 * 86_400_000,
  });
  try {
    await assert.rejects(loop.tick(), /injected projection failure/);
    assert.equal(store.observations.all().some((item) => item.model === observer.model), false);
    store.graph.putNode = originalPutNode;
    assert.ok(await loop.tick(), "the unchanged episode retries after projection failure");
    assert.equal(observerCalls, 2);
    assert.equal(store.observations.all().filter((item) => item.model === observer.model).length, 1);
  } finally {
    store.graph.putNode = originalPutNode;
    store.close();
  }
});

test("concurrent ticks share one observer run and coalesce one cheap trailing pass", async () => {
  const { store } = await fullPipeline();
  let observerCalls = 0;
  let decisions = 0;
  let releaseObserver!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const gate = new Promise<void>((resolve) => { releaseObserver = resolve; });
  const observer: Observer = {
    model: "single-flight-observer",
    async observe(bundle, opts) {
      observerCalls += 1;
      markEntered();
      await gate;
      return {
        id: opts?.newId?.("obs") ?? "obs_single_flight",
        bundleId: bundle.id,
        episodeId: opts?.episodeId,
        acceptedOptions: [],
        rejectedOptions: [],
        uncertainty: [],
        evidence: bundle.actions.map((item) => item.id),
        model: "single-flight-observer",
        createdTs: "2026-07-13T20:02:00.000Z",
      };
    },
  };
  const loop = new AgentLoop(store, {
    observer,
    minEpisodeActions: 1,
    observeIntervalMs: 0,
    growthThreshold: 1,
    windowMs: 10 * 365 * 86_400_000,
    onDecision: () => { decisions += 1; },
  });
  try {
    const first = loop.tick();
    await entered;
    const concurrent = loop.tick();
    assert.equal(concurrent, first, "all callers await the same in-flight drain");
    releaseObserver();
    await Promise.all([first, concurrent]);
    assert.equal(observerCalls, 1, "the coalesced pass does not duplicate paid interpretation");
    assert.equal(decisions, 1, "side effects run exactly once for one observation");
  } finally {
    store.close();
  }
});

test("activity inside the observer throttle receives a final trailing observation", async () => {
  const { store } = await fullPipeline();
  const ingest = makeIngest(store);
  let observerCalls = 0;
  const observer: Observer = {
    model: "trailing-observer",
    async observe(bundle, opts) {
      observerCalls += 1;
      return {
        id: opts?.newId?.("obs") ?? `obs_trailing_${observerCalls}`,
        bundleId: bundle.id,
        episodeId: opts?.episodeId,
        acceptedOptions: [],
        rejectedOptions: [],
        uncertainty: [],
        evidence: bundle.actions.map((item) => item.id),
        model: "trailing-observer",
        createdTs: new Date().toISOString(),
      };
    },
  };
  const loop = new AgentLoop(store, {
    observer,
    debounceMs: 1,
    minEpisodeActions: 1,
    observeIntervalMs: 80,
    growthThreshold: 1,
    windowMs: 10 * 365 * 86_400_000,
  });
  const detach = loop.attach(ingest);
  try {
    const firstDeadline = Date.now() + 2_000;
    while (observerCalls < 1 && Date.now() < firstDeadline) await delay(10);
    assert.equal(observerCalls, 1, "attach performs the initial observation");

    ingest.ingest({
      source: "ai_proxy",
      app: "Claude Code",
      window: "praxis",
      type: "ai_request",
      payload: {
        role: "user",
        sessionKey: "trailing-session",
        preview: "Verify the final activity burst.",
        textHash: "trailing-hash",
      },
    });

    const trailingDeadline = Date.now() + 2_000;
    while (observerCalls < 2 && Date.now() < trailingDeadline) await delay(10);
    assert.equal(
      observerCalls,
      2,
      "the throttled event is observed later without requiring another event",
    );
    await delay(120);
    assert.equal(observerCalls, 2, "the trailing schedule settles after observing the growth");
  } finally {
    detach();
    store.close();
  }
});

test("attached observer failures use bounded exponential backoff", async () => {
  const { store } = await fullPipeline();
  PrivacyControlStore.forStore(store).update({
    cloudObserverConsent: true,
    screenshotConsent: false,
  });
  const attemptsAt: number[] = [];
  const observer: Observer = {
    model: "backoff-observer",
    remote: true,
    async observe() {
      attemptsAt.push(Date.now());
      throw new Error("provider remains unavailable");
    },
  };
  const loop = new AgentLoop(store, {
    observer,
    debounceMs: 1,
    failureRetryBaseMs: 60,
    failureRetryMaxMs: 100,
    minEpisodeActions: 1,
    observeIntervalMs: 0,
    windowMs: 10 * 365 * 86_400_000,
  });
  const detach = loop.attach({ subscribe: () => () => undefined });
  try {
    const deadline = Date.now() + 2_000;
    while (attemptsAt.length < 3 && Date.now() < deadline) await delay(5);
    assert.equal(attemptsAt.length, 3, "the failed observer remains retryable");
    assert.ok(
      attemptsAt[1]! - attemptsAt[0]! >= 50,
      "the first retry does not fall back to the much shorter debounce interval",
    );
    assert.ok(
      attemptsAt[2]! - attemptsAt[1]! >= 90,
      "the second retry doubles and is bounded by the configured maximum",
    );
    await delay(50);
    assert.equal(attemptsAt.length, 3, "the capped retry still cannot hammer the provider");
  } finally {
    detach();
    store.close();
  }
});

test("revoking cloud consent after loop construction blocks the next remote call", async () => {
  const { store } = await fullPipeline();
  const privacy = PrivacyControlStore.forStore(store);
  privacy.update({ cloudObserverConsent: true, screenshotConsent: true });
  let calls = 0;
  let receivedImages: number | undefined;
  const remote: Observer = {
    model: "consent-guard-observer",
    remote: true,
    wantsImages: true,
    async observe(bundle, opts) {
      calls += 1;
      receivedImages = bundle.frameImages?.length;
      return {
        id: opts?.newId?.("obs") ?? "obs_consent_guard",
        bundleId: bundle.id,
        episodeId: opts?.episodeId,
        acceptedOptions: [],
        rejectedOptions: [],
        uncertainty: [],
        evidence: bundle.actions.map((item) => item.id),
        model: "consent-guard-observer",
        createdTs: "2026-07-13T20:05:00.000Z",
      };
    },
  };
  const loop = new AgentLoop(store, {
    observer: remote,
    minEpisodeActions: 1,
    observeIntervalMs: 0,
    windowMs: 10 * 365 * 86_400_000,
  });
  try {
    // The observer already exists, but the cross-process privacy file is the
    // authority at call time.
    privacy.update({ cloudObserverConsent: false, screenshotConsent: false });
    assert.equal(await loop.tick(), undefined);
    assert.equal(calls, 0);
    assert.deepEqual(
      {
        active: RuntimeStatusStore.forStore(store).read().interpretation?.active,
        status: RuntimeStatusStore.forStore(store).read().interpretation?.status,
        reason: RuntimeStatusStore.forStore(store).read().interpretation?.reason,
      },
      {
        active: "none",
        status: "fallback",
        reason: "cloud-consent-disabled",
      },
    );

    privacy.update({ cloudObserverConsent: true, screenshotConsent: false });
    assert.ok(await loop.tick(), "re-enabling text consent makes the same episode retryable");
    assert.equal(calls, 1);
    assert.equal(receivedImages, undefined, "text-only consent strips frame bytes");
  } finally {
    store.close();
  }
});

test("cheap ticks still retract deterministic graph nodes", async () => {
  const { store, graph } = await fullPipeline();
  const target = graph.claims[0];
  assert.ok(target, "fixture must produce a graph claim");
  assert.ok(
    store.graph.nodes().some((node) => node.claimId === target.id),
    "the target starts projected",
  );
  store.corrections.put({
    id: "corr_cheap_projection",
    targetKind: "claim",
    targetId: target.id,
    verdict: "rejected",
    origin: "human",
    createdTs: "2026-07-13T20:03:00.000Z",
  });
  const loop = new AgentLoop(store, {
    minEpisodeActions: Number.MAX_SAFE_INTEGER,
    windowMs: 10 * 365 * 86_400_000,
  });
  try {
    assert.equal(await loop.tick(), undefined, "the tick takes the observer-free path");
    assert.equal(
      store.graph.nodes().some((node) => node.claimId === target.id),
      false,
      "the deterministic projection still reflects the correction",
    );
  } finally {
    store.close();
  }
});
