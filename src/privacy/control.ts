import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EventSource } from "../core/types.ts";
import { EVENT_SOURCES } from "../core/types.ts";
import type { RawEventInput } from "../capture/source.ts";
import type { Store } from "../storage/index.ts";
import { canonicalizeLocalPath } from "../mesh/localPath.ts";
import { normalizeMeshProjectIdentity } from "../mesh/projectConsent.ts";

export const PRIVACY_CONTROL_VERSION = 2 as const;
export type PrivacyMode = "normal" | "paused" | "private";

export interface MeshProjectConsent {
  /** Absolute local workspace root used only on-device for episode matching. */
  workspaceRoot: string;
  /** Stable team-visible project identity, preferably the canonical git remote. */
  project: string;
}

export interface PrivacyControl {
  version: typeof PRIVACY_CONTROL_VERSION;
  mode: PrivacyMode;
  pausedUntil?: string;
  sources: Record<EventSource, boolean>;
  excludedApps: string[];
  excludedWindows: string[];
  excludedPaths: string[];
  cloudObserverConsent: boolean;
  screenshotConsent: boolean;
  meshProjects: string[];
  meshProjectConsents: MeshProjectConsent[];
  updatedAt: string;
}

export const DEFAULT_EXCLUDED_APPS = [
  "1password",
  "bitwarden",
  "keychain access",
  "passwords",
  "authy",
];
export const DEFAULT_EXCLUDED_WINDOWS = [
  "private browsing",
  "incognito",
  "recovery code",
  "one-time password",
  "api key",
];
export const DEFAULT_EXCLUDED_PATHS = [
  ".env",
  ".ssh",
  "credentials",
  ".pem",
  ".key",
];

function defaultSources(): Record<EventSource, boolean> {
  return Object.fromEntries(EVENT_SOURCES.map((source) => [source, true])) as Record<
    EventSource,
    boolean
  >;
}

export function defaultPrivacyControl(now = new Date().toISOString()): PrivacyControl {
  return {
    version: PRIVACY_CONTROL_VERSION,
    mode: "normal",
    sources: defaultSources(),
    excludedApps: [...DEFAULT_EXCLUDED_APPS],
    excludedWindows: [...DEFAULT_EXCLUDED_WINDOWS],
    excludedPaths: [...DEFAULT_EXCLUDED_PATHS],
    cloudObserverConsent: false,
    screenshotConsent: false,
    meshProjects: [],
    meshProjectConsents: [],
    updatedAt: now,
  };
}

function strings(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return [...fallback];
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function meshProjectConsents(value: unknown): MeshProjectConsent[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: MeshProjectConsent[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.workspaceRoot !== "string" || typeof raw.project !== "string") continue;
    const workspaceRoot = raw.workspaceRoot.trim().replace(/\/+$/, "") || "/";
    const project = normalizeMeshProjectIdentity(raw.project);
    if (
      !isAbsolute(workspaceRoot)
      || workspaceRoot === "/"
      || resolve(workspaceRoot) !== workspaceRoot
      || /[\u0000-\u001f\u007f]/.test(workspaceRoot)
      || !project
    ) continue;
    const key = `${workspaceRoot}\0${project}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ workspaceRoot, project });
  }
  return out;
}

function grantedMeshProjectConsents(value: unknown): MeshProjectConsent[] {
  if (!Array.isArray(value)) return [];
  return meshProjectConsents(value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    if (typeof raw.workspaceRoot !== "string" || typeof raw.project !== "string") return [];
    const workspaceRoot = canonicalizeLocalPath(raw.workspaceRoot);
    const project = normalizeMeshProjectIdentity(raw.project);
    return workspaceRoot && workspaceRoot !== "/" && project ? [{ workspaceRoot, project }] : [];
  }));
}

/** Parse a persisted/user-supplied control without letting missing fields weaken defaults. */
export function normalizePrivacyControl(
  value: unknown,
  now = new Date().toISOString(),
): PrivacyControl {
  const fallback = defaultPrivacyControl(now);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const input = value as Record<string, unknown>;
  const mode: PrivacyMode =
    input.mode === "paused" || input.mode === "private" ? input.mode : "normal";
  const inputSources =
    typeof input.sources === "object" && input.sources !== null && !Array.isArray(input.sources)
      ? (input.sources as Record<string, unknown>)
      : {};
  const sources = defaultSources();
  for (const source of EVENT_SOURCES) {
    if (typeof inputSources[source] === "boolean") sources[source] = inputSources[source];
  }
  const pausedUntil =
    typeof input.pausedUntil === "string" && Number.isFinite(Date.parse(input.pausedUntil))
      ? input.pausedUntil
      : undefined;
  return {
    version: PRIVACY_CONTROL_VERSION,
    mode,
    ...(mode === "paused" && pausedUntil ? { pausedUntil } : {}),
    sources,
    excludedApps: strings(input.excludedApps, fallback.excludedApps),
    excludedWindows: strings(input.excludedWindows, fallback.excludedWindows),
    excludedPaths: strings(input.excludedPaths, fallback.excludedPaths),
    cloudObserverConsent: input.cloudObserverConsent === true,
    screenshotConsent: input.cloudObserverConsent === true && input.screenshotConsent === true,
    meshProjects: strings(input.meshProjects, fallback.meshProjects),
    // V1 stored lexical aliases. Re-realpathing one after a symlink retarget
    // could silently move consent to a different tree, so legacy Team grants
    // are deliberately dropped and must be confirmed once under V2.
    meshProjectConsents: input.version === PRIVACY_CONTROL_VERSION
      ? meshProjectConsents(input.meshProjectConsents)
      : [],
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now,
  };
}

export function privacyPathForStore(store: Store): string | undefined {
  return store.paths.db === ":memory:" ? undefined : join(dirname(store.paths.db), "privacy.json");
}

function secureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

function atomicWrite(path: string, value: unknown): void {
  secureDirectory(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best effort.
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort.
  }
}

function fileSignature(path: string): string {
  const stats = statSync(path);
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
}

/** Cross-process, versioned privacy control with mtime-based read caching. */
export class PrivacyControlStore {
  readonly path: string | undefined;
  #memory: PrivacyControl;
  #cachedSignature: string | undefined;

  constructor(path?: string, initial?: PrivacyControl) {
    this.path = path;
    this.#memory = initial ?? defaultPrivacyControl();
  }

  static forStore(store: Store): PrivacyControlStore {
    const existing = CONTROL_STORES.get(store);
    if (existing) return existing;
    const created = new PrivacyControlStore(privacyPathForStore(store));
    CONTROL_STORES.set(store, created);
    return created;
  }

  read(): PrivacyControl {
    if (!this.path) return this.#memory;
    try {
      const signature = fileSignature(this.path);
      if (signature === this.#cachedSignature) return this.#memory;
      this.#memory = normalizePrivacyControl(JSON.parse(readFileSync(this.path, "utf8")));
      this.#cachedSignature = signature;
    } catch {
      // Missing/malformed control fails closed, even if an older cached value
      // had enabled cloud or a sensitive source.
      this.#memory = defaultPrivacyControl();
      try {
        this.#cachedSignature = existsSync(this.path) ? fileSignature(this.path) : undefined;
      } catch {
        this.#cachedSignature = undefined;
      }
    }
    return this.#memory;
  }

  write(value: unknown): PrivacyControl {
    const next = normalizePrivacyControl({
      ...(typeof value === "object" && value !== null ? value : {}),
      updatedAt: new Date().toISOString(),
    });
    if (this.path) {
      atomicWrite(this.path, next);
      this.#cachedSignature = fileSignature(this.path);
    }
    this.#memory = next;
    return next;
  }

  update(patch: Partial<PrivacyControl>): PrivacyControl {
    const current = this.read();
    return this.write({
      ...current,
      ...patch,
      version: PRIVACY_CONTROL_VERSION,
      sources: { ...current.sources, ...(patch.sources ?? {}) },
      meshProjectConsents: patch.meshProjectConsents === undefined
        ? current.meshProjectConsents
        : grantedMeshProjectConsents(patch.meshProjectConsents),
    });
  }
}

const CONTROL_STORES = new WeakMap<Store, PrivacyControlStore>();

function containsAny(value: string, patterns: string[]): boolean {
  const normalized = value.toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

function pathFrom(input: RawEventInput): string {
  const payload = input.payload ?? {};
  for (const key of ["path", "cwd", "filePath", "repo", "root"]) {
    if (typeof payload[key] === "string") return payload[key];
  }
  return input.source === "filesystem" || input.source === "git" ? input.window : "";
}

export interface CapturePolicyDecision {
  allowed: boolean;
  reason?: "private" | "paused" | "source_disabled" | "excluded_app" | "excluded_window" | "excluded_path";
}

/** Final ingest fence. Native/source-level filters should additionally avoid reading sensitive bytes. */
export function capturePolicyDecision(
  control: PrivacyControl,
  input: RawEventInput,
  nowMs = Date.now(),
): CapturePolicyDecision {
  if (control.mode === "private") return { allowed: false, reason: "private" };
  if (
    control.mode === "paused" &&
    (!control.pausedUntil || Date.parse(control.pausedUntil) > nowMs)
  ) {
    return { allowed: false, reason: "paused" };
  }
  if (!control.sources[input.source]) return { allowed: false, reason: "source_disabled" };
  if (containsAny(input.app, control.excludedApps)) return { allowed: false, reason: "excluded_app" };
  if (containsAny(input.window, control.excludedWindows)) {
    return { allowed: false, reason: "excluded_window" };
  }
  const path = pathFrom(input);
  if (path && containsAny(path, control.excludedPaths)) {
    return { allowed: false, reason: "excluded_path" };
  }
  return { allowed: true };
}
