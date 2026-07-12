import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "../storage/index.ts";
import { PrivacyControlStore, type PrivacyControl, type PrivacyMode } from "./control.ts";
import {
  RuntimeStatusStore,
  type RuntimeResourceState,
} from "../capture/runtimeStatus.ts";

/**
 * Wire contract consumed by PraxisCaptureKit. Keep additions backward
 * compatible and bump this version for any semantic or required-field change.
 */
export const NATIVE_ACQUISITION_POLICY_VERSION = 1 as const;
export const NATIVE_ACQUISITION_POLICY_TTL_MS = 30_000;

export interface NativeAcquisitionPolicy {
  version: typeof NATIVE_ACQUISITION_POLICY_VERSION;
  publishedAt: string;
  expiresAt: string;
  privacyRevision: string;
  resourceRevision: string;
  mode: PrivacyMode;
  pausedUntil?: string;
  sources: PrivacyControl["sources"];
  /** Egress-only consent. Local pixels are controlled by sources.screen_video. */
  cloudScreenshotEgressConsent: boolean;
  excludedApps: string[];
  excludedWindows: string[];
  resources: Pick<RuntimeResourceState, "powerSource" | "suspended" | "batteryAware">;
}

export function nativePolicyPathForStore(store: Store): string | undefined {
  return store.paths.db === ":memory:"
    ? undefined
    : join(dirname(store.paths.db), "native-acquisition-policy.json");
}

/** Build the exact cross-language projection without leaking unrelated consent/settings. */
export function projectNativeAcquisitionPolicy(
  privacy: PrivacyControl,
  resources: RuntimeResourceState,
  nowMs = Date.now(),
): NativeAcquisitionPolicy {
  return {
    version: NATIVE_ACQUISITION_POLICY_VERSION,
    publishedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + NATIVE_ACQUISITION_POLICY_TTL_MS).toISOString(),
    privacyRevision: privacy.updatedAt,
    resourceRevision: resources.updatedAt,
    mode: privacy.mode,
    ...(privacy.mode === "paused" && privacy.pausedUntil
      ? { pausedUntil: privacy.pausedUntil }
      : {}),
    sources: { ...privacy.sources },
    cloudScreenshotEgressConsent: privacy.screenshotConsent === true,
    excludedApps: [...privacy.excludedApps],
    excludedWindows: [...privacy.excludedWindows],
    resources: {
      powerSource: resources.powerSource,
      suspended: resources.suspended,
      batteryAware: resources.batteryAware,
    },
  };
}

/**
 * Atomically and durably publish one combined privacy/resource snapshot.
 * Native readers therefore observe either the complete previous generation or
 * the complete next generation, never a privacy/runtime half-state.
 */
export function publishNativeAcquisitionPolicy(
  store: Store,
  opts: {
    privacy?: PrivacyControlStore;
    runtime?: RuntimeStatusStore;
    nowMs?: number;
  } = {},
): NativeAcquisitionPolicy | undefined {
  const path = nativePolicyPathForStore(store);
  if (!path) return undefined;
  const privacy = (opts.privacy ?? PrivacyControlStore.forStore(store)).read();
  const resources = (opts.runtime ?? RuntimeStatusStore.forStore(store)).read().resources;
  const projection = projectNativeAcquisitionPolicy(privacy, resources, opts.nowMs);
  atomicDurableWrite(path, `${JSON.stringify(projection, null, 2)}\n`);
  return projection;
}

function atomicDurableWrite(path: string, data: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Directory fsync/modes are not available on every supported filesystem.
    }
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
