import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { EventSource } from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import type {
  CaptureSourceStatusChannel,
  CaptureSourceStatusState,
} from "./source.ts";

export type CaptureRuntimeState = "unknown" | "starting" | "running" | "stopping" | "stopped" | "failed";

export interface RuntimeResourceState {
  powerSource: "ac" | "battery";
  suspended: boolean;
  batteryAware: boolean;
  updatedAt: string;
}

export function defaultRuntimeResources(): RuntimeResourceState {
  return {
    powerSource: "ac",
    suspended: false,
    batteryAware: true,
    updatedAt: new Date().toISOString(),
  };
}

export interface CaptureRuntimeStatus {
  version: 1;
  state: CaptureRuntimeState;
  pid?: number;
  activeSources: string[];
  updatedAt: string;
  lastEventAt?: string;
  /** Most recent event observed in this process, split by evidence channel. */
  sourceLastEventAt?: Partial<Record<EventSource, string>>;
  /** Most recent evidence split by user-visible producer channel. */
  channelLastEventAt?: Partial<Record<CaptureSourceStatusChannel, string>>;
  /** Control-plane readiness reported by capture producers, not evidence. */
  sourceReadiness?: Partial<Record<CaptureSourceStatusChannel, {
    status: CaptureSourceStatusState;
    reason?: string;
    updatedAt: string;
  }>>;
  lastError?: string;
  resources: RuntimeResourceState;
  interpretation?: InterpretationRuntimeStatus;
}

export interface InterpretationRuntimeStatus {
  requested: "none" | "mock" | "anthropic";
  active: "none" | "offline" | "model";
  status: "disabled" | "configured" | "ready" | "fallback" | "failed";
  model?: string;
  reason?: "credential-missing" | "cloud-consent-disabled" | "model-unavailable" | "runtime-error";
  lastSuccessAt?: string;
  lastError?: string;
}

export function startupInterpretationStatus(input: {
  useModel: boolean;
  modelActive: boolean;
  cloudConsent: boolean;
  credentialPresent: boolean;
  model?: string;
}): InterpretationRuntimeStatus {
  if (!input.useModel) {
    return {
      requested: "mock",
      active: "offline",
      status: "ready",
      ...(input.model ? { model: input.model } : {}),
    };
  }
  if (input.modelActive) {
    return {
      requested: "anthropic",
      active: "model",
      status: "configured",
      ...(input.model ? { model: input.model } : {}),
    };
  }
  return {
    requested: "anthropic",
    active: "offline",
    status: "fallback",
    ...(input.model ? { model: input.model } : {}),
    reason: !input.cloudConsent
      ? "cloud-consent-disabled"
      : !input.credentialPresent
        ? "credential-missing"
        : "model-unavailable",
  };
}

export function runtimePathForStore(store: Store): string | undefined {
  return store.paths.db === ":memory:" ? undefined : join(dirname(store.paths.db), "runtime.json");
}

interface RuntimeLockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

const RUNTIME_LOCK_RETRY_MS = 10;
const RUNTIME_LOCK_TIMEOUT_MS = 5_000;
const RUNTIME_LOCK_OWNER_GRACE_MS = 1_000;
const RUNTIME_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/**
 * Serialize the runtime status read/merge/rename sequence across processes.
 *
 * An atomic rename protects readers from partial JSON, but it does not protect
 * two writers that both read the same old snapshot. Capture and Studio are
 * separate processes, so the lock must live next to runtime.json rather than
 * in a module-level mutex.
 */
function acquireRuntimeLock(path: string): () => void {
  const lockPath = `${path}.lock`;
  const owner: RuntimeLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const deadline = Date.now() + RUNTIME_LOCK_TIMEOUT_MS;

  for (;;) {
    let acquired = false;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }

    if (acquired) {
      try {
        writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return () => releaseRuntimeLock(lockPath, owner.token);
    }

    if (reclaimAbandonedRuntimeLock(lockPath)) continue;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for runtime status lock: ${lockPath}`);
    }
    Atomics.wait(RUNTIME_LOCK_WAIT, 0, 0, RUNTIME_LOCK_RETRY_MS);
  }
}

function releaseRuntimeLock(lockPath: string, token: string): void {
  try {
    const owner = readRuntimeLockOwner(lockPath);
    if (owner?.token !== token) return;
    const releasedPath = `${lockPath}.released-${process.pid}-${randomUUID()}`;
    renameSync(lockPath, releasedPath);
    rmSync(releasedPath, { recursive: true, force: true });
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function reclaimAbandonedRuntimeLock(lockPath: string): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  }

  const owner = readRuntimeLockOwner(lockPath);
  // mkdir() and owner.json are two filesystem operations. Give a winning
  // writer time to publish its identity before treating an empty lock as an
  // interrupted acquisition.
  if (!owner && ageMs <= RUNTIME_LOCK_OWNER_GRACE_MS) return false;
  if (owner && processIsAlive(owner.pid)) return false;

  const abandonedPath = `${lockPath}.abandoned-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, abandonedPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    return false;
  }
  rmSync(abandonedPath, { recursive: true, force: true });
  return true;
}

function readRuntimeLockOwner(lockPath: string): RuntimeLockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as Partial<RuntimeLockOwner>;
    return Number.isInteger(value.pid) &&
      Number(value.pid) > 0 &&
      typeof value.token === "string" &&
      typeof value.createdAt === "string"
      ? value as RuntimeLockOwner
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export class RuntimeStatusStore {
  readonly path: string | undefined;
  #memory: CaptureRuntimeStatus = {
    version: 1,
    state: "unknown",
    activeSources: [],
    updatedAt: new Date(0).toISOString(),
    resources: defaultRuntimeResources(),
  };

  constructor(path?: string) {
    this.path = path;
  }

  static forStore(store: Store): RuntimeStatusStore {
    const existing = RUNTIME_STORES.get(store);
    if (existing) return existing;
    const created = new RuntimeStatusStore(runtimePathForStore(store));
    RUNTIME_STORES.set(store, created);
    return created;
  }

  read(): CaptureRuntimeStatus {
    if (!this.path || !existsSync(this.path)) return this.#memory;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as CaptureRuntimeStatus;
      return parsed?.version === 1
        ? { ...parsed, resources: parsed.resources ?? defaultRuntimeResources() }
        : this.#memory;
    } catch {
      return this.#memory;
    }
  }

  write(patch: Partial<CaptureRuntimeStatus>): CaptureRuntimeStatus {
    if (!this.path) {
      const next = this.#merge(this.#memory, patch);
      this.#memory = next;
      return next;
    }

    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = acquireRuntimeLock(this.path);
    try {
      const next = this.#merge(this.read(), patch);
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.path);
      try {
        chmodSync(dirname(this.path), 0o700);
        chmodSync(this.path, 0o600);
      } catch {
        // Best effort.
      }
      this.#memory = next;
      return next;
    } finally {
      release();
    }
  }

  #merge(
    current: CaptureRuntimeStatus,
    patch: Partial<CaptureRuntimeStatus>,
  ): CaptureRuntimeStatus {
    const next: CaptureRuntimeStatus = {
      ...current,
      ...patch,
      version: 1,
      activeSources: [...(patch.activeSources ?? current.activeSources)],
      resources: patch.resources ?? current.resources,
      updatedAt: new Date().toISOString(),
    };
    if (next.lastError) next.lastError = next.lastError.slice(0, 500);
    return next;
  }

  updateResources(value: Omit<RuntimeResourceState, "updatedAt">): CaptureRuntimeStatus {
    return this.write({ resources: { ...value, updatedAt: new Date().toISOString() } });
  }
}

const RUNTIME_STORES = new WeakMap<Store, RuntimeStatusStore>();

export function resourceCaptureDecision(
  resources: RuntimeResourceState,
  source: string,
): { allowed: boolean; reason?: "suspended" | "battery_screenshot" } {
  if (resources.suspended) return { allowed: false, reason: "suspended" };
  if (resources.batteryAware && resources.powerSource === "battery" && source === "screen_video") {
    return { allowed: false, reason: "battery_screenshot" };
  }
  return { allowed: true };
}
