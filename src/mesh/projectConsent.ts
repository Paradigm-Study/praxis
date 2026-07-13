import type { MeshProjectConsent } from "../privacy/control.ts";
import { canonicalizeLocalPath, pathIsInside } from "./localPath.ts";
import { normalizeRepoUrl } from "./workframe.ts";

const SAFE_PROJECT_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Opaque person/team/device identity safe for headers, URLs, disk, and wire. */
export function safeMeshWireIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(normalized)
    ? normalized
    : undefined;
}

/** Canonicalize a team-visible identity while rejecting local/path-shaped data. */
export function normalizeMeshProjectIdentity(value: string): string | undefined {
  const raw = value.trim();
  if (
    raw === ""
    || Buffer.byteLength(raw) > 500
    || /[\u0000-\u001f\u007f\\]/.test(raw)
    || raw.startsWith("/")
    || raw.startsWith("~")
    || /^file:/i.test(raw)
    || /^[A-Za-z]:\//.test(raw)
  ) return undefined;

  const canonical = normalizeRepoUrl(raw);
  if (SAFE_PROJECT_PART.test(canonical)) return canonical;
  const pair = canonical.split("/");
  if (pair.length === 2 && pair.every((part) => SAFE_PROJECT_PART.test(part))) return canonical;
  try {
    const url = new URL(canonical);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
    ) return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length >= 2 && parts.every((part) => SAFE_PROJECT_PART.test(part))
      ? `${url.origin}/${parts.join("/")}`
      : undefined;
  } catch {
    return undefined;
  }
}

/** Only HTTPS or an exact loopback HTTP origin may receive Mesh credentials. */
export function safeMeshRelayBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    const proxyMode = process.execArgv.includes("--use-env-proxy")
      || process.env.NODE_USE_ENV_PROXY === "1"
      || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS ?? "");
    const proxyConfigured = [
      process.env.HTTP_PROXY,
      process.env.http_proxy,
      process.env.ALL_PROXY,
      process.env.all_proxy,
    ].some(Boolean);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || (url.protocol === "http:" && loopback && proxyMode && proxyConfigured)
      || url.username !== ""
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
      || (url.pathname !== "" && url.pathname !== "/")
    ) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function safeRepoRelativePath(value: string): string | undefined {
  const trimmed = value.trim().replace(/^\.\//, "");
  const parts = trimmed.split("/");
  if (
    trimmed === ""
    || Buffer.byteLength(trimmed) > 1_024
    || trimmed.startsWith("/")
    || trimmed.startsWith("~")
    || /[\u0000-\u001f\u007f\\]/.test(trimmed)
    || /^[A-Za-z]:\//.test(trimmed)
    || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    || parts.some((part) => part === "" || part === "." || part === "..")
  ) return undefined;
  for (const part of parts) {
    let decoded = part;
    try {
      for (let depth = 0; depth < 3; depth += 1) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
    } catch {
      return undefined;
    }
    if (decoded === "." || decoded === ".." || /[\/\\\u0000-\u001f\u007f]/.test(decoded)) {
      return undefined;
    }
  }
  return trimmed;
}

export interface ResolvedMeshProject {
  /** Absolute local-only root. This value must never cross the mesh boundary. */
  workspaceRoot: string;
  /** Canonical team-visible project identity. */
  project: string;
}

/**
 * Resolve one cwd through the active privacy mapping. The most-specific root
 * wins, but two different projects at that root are ambiguous and fail closed.
 */
export function resolveConsentedWorkspaceProject(
  consents: MeshProjectConsent[],
  cwd: string,
): ResolvedMeshProject | undefined {
  const canonicalCwd = canonicalizeLocalPath(cwd);
  if (!canonicalCwd) return undefined;

  const matches = consents.flatMap((candidate) => {
    const workspaceRoot = candidate.workspaceRoot;
    const project = normalizeMeshProjectIdentity(candidate.project);
    return workspaceRoot.startsWith("/") && project && pathIsInside(canonicalCwd, workspaceRoot)
      ? [{ workspaceRoot, project }]
      : [];
  });
  if (matches.length === 0) return undefined;

  const longestRoot = Math.max(...matches.map((candidate) => candidate.workspaceRoot.length));
  const mostSpecific = matches.filter((candidate) => candidate.workspaceRoot.length === longestRoot);
  const projects = new Set(mostSpecific.map((candidate) => candidate.project));
  if (projects.size !== 1) return undefined;

  return {
    workspaceRoot: mostSpecific[0]!.workspaceRoot,
    project: [...projects][0]!,
  };
}

/** A frame may leave the device only while its canonical project is consented. */
export function isMeshProjectConsented(
  consents: MeshProjectConsent[],
  project: string,
): boolean {
  const canonical = normalizeRepoUrl(project);
  const safe = normalizeMeshProjectIdentity(canonical);
  return safe !== undefined
    && consents.some((consent) => normalizeMeshProjectIdentity(consent.project) === safe);
}
