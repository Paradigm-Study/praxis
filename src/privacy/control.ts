import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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

const PATH_PAYLOAD_KEY = /^(?:path|paths|file|files|filename|filenames|file[_-]?path|cwd|repo|repository|root|worktree|workspace(?:root)?|old[_-]?path|new[_-]?path|relative[_-]?path)$/i;
const ROOT_PAYLOAD_KEY = /^(?:cwd|repo|root|worktree|workspace(?:root)?)$/i;
const WINDOW_PATH_METADATA_KEY = /^(?:window|windows|window[_-]?title|window[_-]?titles|visible[_-]?windows|title|titles)$/i;
const URL_PAYLOAD_KEY = /^(?:url|urls|uri|uris|href)$/i;
const MAX_PATH_WALK_DEPTH = 12;
const MAX_PATH_CANDIDATES = 4_096;

function nestedPayloadStrings(
  value: unknown,
  keyPattern: RegExp,
): { values: string[]; complete: boolean } {
  const paths: string[] = [];
  const seen = new WeakMap<object, number>();
  let complete = true;

  const visit = (current: unknown, inPathField: boolean, depth: number): void => {
    if (paths.length >= MAX_PATH_CANDIDATES || depth > MAX_PATH_WALK_DEPTH) {
      complete = false;
      return;
    }
    if (typeof current === "string") {
      const path = current.trim();
      if (inPathField && path) paths.push(path);
      return;
    }
    if (typeof current !== "object" || current === null) return;
    // A shared object first reached through a non-path key still needs another
    // visit if it later appears under `files`/`path`. Track those contexts
    // independently while still terminating genuine cycles.
    const bit = inPathField ? 2 : 1;
    const seenContexts = seen.get(current) ?? 0;
    if ((seenContexts & bit) !== 0) return;
    seen.set(current, seenContexts | bit);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, inPathField, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      visit(child, inPathField || keyPattern.test(key), depth + 1);
    }
  };

  visit(value, false, 0);
  return { values: paths, complete };
}

function unquoteGitPath(path: string): string {
  const trimmed = path.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed;
  // Git uses C-style quoting. Decode the common escapes (and octal bytes) so
  // an excluded component cannot hide behind a quoted --stat/diff path.
  return trimmed.slice(1, -1)
    .replace(/\\([0-7]{1,3})/g, (_match, digits: string) =>
      String.fromCharCode(Number.parseInt(digits, 8)))
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function gitPath(path: string): string | undefined {
  let cleaned = unquoteGitPath(path).trim();
  if (!cleaned || cleaned === "/dev/null") return undefined;
  if (cleaned.startsWith("a/") || cleaned.startsWith("b/")) cleaned = cleaned.slice(2);
  return cleaned || undefined;
}

function localPathFromFileUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === "file:" ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

function gitHeaderTokens(value: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quoted = false;
  let escaped = false;
  for (const char of value.trim()) {
    if (escaped) {
      token += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      token += char;
      continue;
    }
    if (/\s/.test(char) && !quoted) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    token += char;
  }
  if (escaped) token += "\\";
  if (token) tokens.push(token);
  return tokens;
}

function expandStatPath(value: string): string[] {
  const path = value.trim();
  const braceRename = /^(.*)\{([^{}]*) => ([^{}]*)\}(.*)$/.exec(path);
  if (braceRename) {
    return [
      `${braceRename[1]}${braceRename[2]}${braceRename[4]}`,
      `${braceRename[1]}${braceRename[3]}${braceRename[4]}`,
    ];
  }
  const renameAt = path.indexOf(" => ");
  return renameAt < 0
    ? [path]
    : [path.slice(0, renameAt), path.slice(renameAt + 4)];
}

/** Extract path-bearing headers from both full patches and Git --stat blobs. */
function pathsFromGitDiff(value: string): string[] {
  const paths: string[] = [];
  const add = (candidate: string): void => {
    const path = gitPath(candidate);
    if (path) paths.push(path);
  };

  for (const line of value.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      for (const token of gitHeaderTokens(line.slice("diff --git ".length))) add(token);
      continue;
    }
    const patchPath = /^(?:---|\+\+\+)\s+(.+?)(?:\t.*)?$/.exec(line);
    if (patchPath?.[1]) {
      add(patchPath[1]);
      continue;
    }
    const movePath = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (movePath?.[1]) {
      add(movePath[1]);
      continue;
    }
    const binaryPaths = /^Binary files (.+) and (.+) differ$/.exec(line);
    if (binaryPaths?.[1] && binaryPaths[2]) {
      add(binaryPaths[1]);
      add(binaryPaths[2]);
      continue;
    }
    const statPath = /^\s*(.+?)\s+\|\s+(?:\d+(?:\s|$)|Bin(?:\s|$))/.exec(line);
    if (statPath?.[1]) {
      for (const candidate of expandStatPath(statPath[1])) add(candidate);
    }
  }
  return paths;
}

function pathsFrom(input: RawEventInput): { values: string[]; complete: boolean } {
  const payload = input.payload ?? {};
  const payloadPaths = nestedPayloadStrings(payload, PATH_PAYLOAD_KEY);
  const payloadRoots = nestedPayloadStrings(payload, ROOT_PAYLOAD_KEY);
  const rawPaths = payloadPaths.values;
  const roots = payloadRoots.values;
  let complete = payloadPaths.complete && payloadRoots.complete;

  if (
    input.source === "screen_video"
    || input.source === "accessibility"
    || input.source === "focus_timeline"
  ) {
    // Window titles are acquisition metadata, not OCR/conversation content.
    // Screen attribution includes every geometry-visible window so a private
    // file on a secondary display cannot bypass the final persistence fence.
    if (input.window.trim()) rawPaths.push(input.window);
    const windowPaths = nestedPayloadStrings(payload, WINDOW_PATH_METADATA_KEY);
    rawPaths.push(...windowPaths.values);
    complete &&= windowPaths.complete;
  }

  if (input.source === "browser_dom") {
    const fileWindow = localPathFromFileUrl(input.window);
    if (fileWindow) rawPaths.push(fileWindow);
    const urls = nestedPayloadStrings(payload, URL_PAYLOAD_KEY);
    for (const value of urls.values) {
      const path = localPathFromFileUrl(value);
      if (path) rawPaths.push(path);
    }
    complete &&= urls.complete;
  }

  if ((input.source === "filesystem" || input.source === "git") && input.window.trim()) {
    rawPaths.push(input.window);
    roots.push(input.window);
  }
  if (input.source === "git") {
    for (const blob of input.blobs ?? []) {
      if (blob.kind !== "diff") continue;
      const value = typeof blob.data === "string"
        ? blob.data
        : Buffer.from(blob.data).toString("utf8");
      rawPaths.push(...pathsFromGitDiff(value));
    }
  }

  const absoluteRoots = roots
    .map((root) => unquoteGitPath(root))
    .filter((root) => isAbsolute(root))
    .map((root) => resolve(root));
  const paths = new Set<string>();
  for (const rawPath of rawPaths) {
    const path = unquoteGitPath(rawPath);
    if (!path) continue;
    paths.add(path);
    if (isAbsolute(path)) {
      paths.add(normalize(path));
      continue;
    }
    for (const root of absoluteRoots) paths.add(resolve(root, path));
  }
  return {
    values: [...paths],
    complete,
  };
}

function includesExcludedPath(paths: string[], excludedPaths: string[]): boolean {
  return excludedPaths.some((excluded) => {
    const pattern = excluded.trim();
    if (!pattern) return false;
    if (!isAbsolute(pattern)) return paths.some((path) => containsAny(path, [pattern]));
    const normalizedPattern = normalize(pattern).toLowerCase();
    const boundary = normalizedPattern.endsWith(sep)
      ? normalizedPattern
      : `${normalizedPattern}${sep}`;
    return paths.some((path) => {
      if (!isAbsolute(path)) return false;
      const normalizedPath = normalize(path).toLowerCase();
      return normalizedPath === normalizedPattern || normalizedPath.startsWith(boundary);
    });
  });
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
  const pathScan = pathsFrom(input);
  if (!pathScan.complete || includesExcludedPath(pathScan.values, control.excludedPaths)) {
    return { allowed: false, reason: "excluded_path" };
  }
  return { allowed: true };
}
