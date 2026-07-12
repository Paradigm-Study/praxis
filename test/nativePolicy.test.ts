import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureSource } from "../src/capture/source.ts";
import { CaptureManager } from "../src/capture/manager.ts";
import { ClipboardSource } from "../src/capture/sources/clipboard.ts";
import { RuntimeStatusStore } from "../src/capture/runtimeStatus.ts";
import { PrivacyControlStore } from "../src/privacy/control.ts";
import {
  NATIVE_ACQUISITION_POLICY_VERSION,
  nativePolicyPathForStore,
  projectNativeAcquisitionPolicy,
  publishNativeAcquisitionPolicy,
  type NativeAcquisitionPolicy,
} from "../src/privacy/nativePolicy.ts";
import { openStore } from "../src/storage/index.ts";

const NATIVE_SOURCE_KEYS = [
  "screen_video",
  "accessibility",
  "focus_timeline",
  "input_events",
  "clipboard",
  "audio",
] as const;

test("native projection keeps local screenshot acquisition separate from cloud image egress", () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-native-policy-default-"));
  const store = openStore({ dir });
  try {
    const projected = publishNativeAcquisitionPolicy(store)!;
    assert.equal(projected.version, NATIVE_ACQUISITION_POLICY_VERSION);
    assert.equal(projected.sources.screen_video, true, "local screen capture follows its source toggle");
    assert.equal(
      projected.cloudScreenshotEgressConsent,
      false,
      "default policy still forbids sending screenshots to cloud observers",
    );
    for (const source of NATIVE_SOURCE_KEYS) {
      assert.equal(typeof projected.sources[source], "boolean", `${source} is projected explicitly`);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native projection is owner-only, atomic, leased, and reflects every native control", () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-native-policy-"));
  const store = openStore({ dir });
  try {
    const privacy = PrivacyControlStore.forStore(store);
    const runtime = RuntimeStatusStore.forStore(store);
    const sources = { ...privacy.read().sources };
    sources.accessibility = false;
    sources.input_events = false;
    privacy.update({
      mode: "paused",
      pausedUntil: "2026-07-12T12:05:00.000Z",
      sources,
      excludedApps: ["Vault"],
      excludedWindows: ["Secret"],
    });
    runtime.updateResources({ powerSource: "battery", suspended: true, batteryAware: true });
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    const projected = publishNativeAcquisitionPolicy(store, { privacy, runtime, nowMs: now })!;
    const path = nativePolicyPathForStore(store)!;
    const disk = JSON.parse(readFileSync(path, "utf8")) as NativeAcquisitionPolicy;
    assert.deepEqual(disk, projected);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(projected.expiresAt, "2026-07-12T12:00:30.000Z");
    assert.equal(projected.sources.accessibility, false);
    assert.equal(projected.sources.input_events, false);
    assert.deepEqual(projected.resources, {
      powerSource: "battery",
      suspended: true,
      batteryAware: true,
    });
    assert.equal(readdirSync(dir).some((name) => name.includes("native-acquisition-policy.json.tmp-")), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CaptureManager publishes the native policy before starting its first source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-native-policy-order-"));
  const store = openStore({ dir });
  let observed: NativeAcquisitionPolicy | undefined;
  const source: CaptureSource = {
    name: "ordering-probe",
    source: "synthetic",
    start() {
      observed = JSON.parse(readFileSync(nativePolicyPathForStore(store)!, "utf8")) as NativeAcquisitionPolicy;
    },
    stop() {},
  };
  const manager = new CaptureManager(store, [source]);
  try {
    await manager.start();
    assert.equal(observed?.version, 1);
    assert.ok(Date.parse(observed!.expiresAt) > Date.now());
  } finally {
    await manager.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pure projection preserves an independently disabled native source", () => {
  const store = openStore({ memory: true });
  try {
    const privacy = PrivacyControlStore.forStore(store).read();
    privacy.sources.focus_timeline = false;
    const resources = RuntimeStatusStore.forStore(store).read().resources;
    const projected = projectNativeAcquisitionPolicy(privacy, resources, 0);
    assert.equal(projected.sources.focus_timeline, false);
    assert.equal(projected.sources.accessibility, true);
  } finally {
    store.close();
  }
});

test("clipboard policy denial occurs before the clipboard body acquisition function", async () => {
  let reads = 0;
  let emits = 0;
  const source = new ClipboardSource({
    intervalMs: 5,
    frontApp: () => ({ app: "Vault", window: "Secrets" }),
    canAcquire: () => false,
    readClipboard: async () => {
      reads++;
      return "must never be read";
    },
  });
  source.start(() => {
    emits++;
    throw new Error("denied clipboard content must not emit");
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  source.stop();
  assert.equal(reads, 0);
  assert.equal(emits, 0);
});
