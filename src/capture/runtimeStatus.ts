import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "../storage/index.ts";

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
  lastError?: string;
  resources: RuntimeResourceState;
}

export function runtimePathForStore(store: Store): string | undefined {
  return store.paths.db === ":memory:" ? undefined : join(dirname(store.paths.db), "runtime.json");
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
    const next: CaptureRuntimeStatus = {
      ...this.read(),
      ...patch,
      version: 1,
      activeSources: [...(patch.activeSources ?? this.read().activeSources)],
      resources: patch.resources ?? this.read().resources,
      updatedAt: new Date().toISOString(),
    };
    if (next.lastError) next.lastError = next.lastError.slice(0, 500);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.path);
      try {
        chmodSync(dirname(this.path), 0o700);
        chmodSync(this.path, 0o600);
      } catch {
        // Best effort.
      }
    }
    this.#memory = next;
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
