import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureSource } from "../src/capture/source.ts";
import { CaptureManager } from "../src/capture/manager.ts";
import { ClipboardSource } from "../src/capture/sources/clipboard.ts";
import { FilesystemSource } from "../src/capture/sources/filesystem.ts";
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

test("filesystem policy denial occurs before file body acquisition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-filesystem-preflight-"));
  let preflights = 0;
  let reads = 0;
  let emits = 0;
  let notify: ((filename: string | Buffer | null) => void) | undefined;
  const source = new FilesystemSource({
    root: dir,
    canAcquire: () => { preflights++; return false; },
    readText: () => { reads++; return "must never be read"; },
    watchTree: (_root, callback) => {
      notify = callback;
      return { close() {} };
    },
  });
  try {
    source.start(() => { emits++; throw new Error("denied file content must not emit"); });
    notify!("secret.txt");
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.ok(preflights > 0);
    assert.equal(reads, 0);
    assert.equal(emits, 0);
  } finally {
    source.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filesystem capture rejects final and parent symlinks outside the selected workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-filesystem-symlink-"));
  const root = join(dir, "selected");
  const outside = join(dir, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "must never be acquired");
  symlinkSync(join(outside, "secret.txt"), join(root, "final-link.txt"));
  symlinkSync(outside, join(root, "parent-link"), "dir");
  let notify: ((filename: string | Buffer | null) => void) | undefined;
  let reads = 0;
  let emits = 0;
  const source = new FilesystemSource({
    root,
    readText: () => { reads += 1; return "must never run"; },
    watchTree: (_root, callback) => {
      notify = callback;
      return { close() {} };
    },
  });
  try {
    source.start(() => { emits += 1; throw new Error("escaped symlink must not emit"); });
    notify!("final-link.txt");
    notify!("parent-link/secret.txt");
    notify!("../outside/secret.txt");
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(reads, 0);
    assert.equal(emits, 0);
  } finally {
    source.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filesystem capture detects a parent-directory retarget before open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-filesystem-retarget-parent-"));
  const root = join(dir, "selected");
  const nested = join(root, "nested");
  const moved = join(root, "moved");
  const outside = join(dir, "outside");
  mkdirSync(nested, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(nested, "target.txt"), "selected bytes");
  writeFileSync(join(outside, "target.txt"), "outside bytes");
  let notify: ((filename: string | Buffer | null) => void) | undefined;
  let reads = 0;
  let emits = 0;
  let retargeted = false;
  const source = new FilesystemSource({
    root,
    beforeOpen: () => {
      if (retargeted) return;
      retargeted = true;
      renameSync(nested, moved);
      symlinkSync(outside, nested, "dir");
    },
    readText: () => { reads += 1; return "must never run"; },
    watchTree: (_root, callback) => {
      notify = callback;
      return { close() {} };
    },
  });
  try {
    source.start(() => { emits += 1; throw new Error("retargeted parent must not emit"); });
    notify!("nested/target.txt");
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(retargeted, true);
    assert.equal(reads, 0);
    assert.equal(emits, 0);
  } finally {
    source.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filesystem capture detects a final-component retarget after open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-filesystem-retarget-final-"));
  const root = join(dir, "selected");
  const outside = join(dir, "outside.txt");
  const target = join(root, "target.txt");
  mkdirSync(root);
  writeFileSync(target, "selected bytes");
  writeFileSync(outside, "outside bytes");
  let notify: ((filename: string | Buffer | null) => void) | undefined;
  let reads = 0;
  let emits = 0;
  let retargeted = false;
  const source = new FilesystemSource({
    root,
    afterOpen: () => {
      if (retargeted) return;
      retargeted = true;
      unlinkSync(target);
      symlinkSync(outside, target);
    },
    readText: () => { reads += 1; return "must never run"; },
    watchTree: (_root, callback) => {
      notify = callback;
      return { close() {} };
    },
  });
  try {
    source.start(() => { emits += 1; throw new Error("retargeted file must not emit"); });
    notify!("target.txt");
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(retargeted, true);
    assert.equal(reads, 0);
    assert.equal(emits, 0);
  } finally {
    source.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
