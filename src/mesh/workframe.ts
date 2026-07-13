import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Episode } from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import { redactText, redactWorkFrame } from "./redact.ts";
import type { WorkFrame, WorkFrameStatus } from "./types.ts";
import { canonicalizeLocalPath, pathIsInside } from "./localPath.ts";

/**
 * Episode → WorkFrame projection (contract v0).
 *
 * This is deliberately a lossy privacy boundary: it projects an episode into
 * repo-local metadata and one-way evidence hashes, never raw ledger ids or
 * content. The completed frame passes through the mesh redactor as a second
 * fence before it can leave the machine.
 */

export interface WorkFrameContext {
  person: string;
  device: string;
  /** Git remote url or directory name. */
  project: string;
  /** For claim/evidence lookups while building the frame. */
  store?: Store;
  status?: WorkFrameStatus;
  /** Agent session id, when the episode came from an agent transcript. */
  sessionKey?: string;
  /** Injectable clock for tests. Defaults to the episode's endTs. */
  ts?: string;
  /**
   * Local repo root used to relativize absolute artifact paths. Defaults to
   * process.cwd(). Absolute paths that do not live under this root are DROPPED
   * (a machine-local path leaks the username/home layout and can never match
   * anyone else's repo-relative gate query).
   */
  repoRoot?: string;
}

/**
 * Normalize a git remote into the stable repo identity used on the mesh.
 * Plain directory names are already useful local identities, so they remain
 * untouched; URL-like remotes lose transport-specific ssh syntax instead.
 */
export function normalizeRepoUrl(raw: string): string {
  const value = raw.trim();
  const scp = value.match(/^(?:[^@/\s]+)@([^:/\s]+):(.+)$/);
  if (scp) {
    return toHttpsRepo(scp[1]!, scp[2]!);
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const path = normalizeRepoPath(value);
    return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(path)
      ? path.toLowerCase()
      : value;
  }

  try {
    const url = new URL(value);
    const path = normalizeRepoPath(url.pathname);
    if (url.protocol === "ssh:") {
      return toHttpsRepo(url.host, path);
    }

    if (url.hostname.toLowerCase() === "github.com" && /^[^/]+\/[^/]+$/.test(path)) {
      return path.toLowerCase();
    }

    const origin = `${url.protocol}//${url.host.toLowerCase()}`;
    return path ? `${origin}/${path.toLowerCase()}` : origin;
  } catch {
    return value;
  }
}

function normalizeRepoPath(raw: string): string {
  return raw.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
}

function toHttpsRepo(host: string, rawPath: string): string {
  const path = normalizeRepoPath(rawPath).toLowerCase();
  if (host.toLowerCase() === "github.com" && /^[^/]+\/[^/]+$/.test(path)) {
    return path;
  }
  const origin = `https://${host.toLowerCase()}`;
  return path ? `${origin}/${path}` : origin;
}

function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function claimsTouched(episode: Episode, store?: Store): string[] {
  if (!store) return [];

  const claimIds = new Set<string>();
  for (const edge of store.graph.edges()) {
    if (edge.kind !== "observed_in_episode" || edge.to !== episode.id) continue;
    const claimId = store.graph.getNode(edge.from)?.claimId;
    if (claimId) claimIds.add(claimId);
  }
  return [...claimIds].sort();
}

function evidenceRefs(episode: Episode, store?: Store): string[] {
  if (!store) return [];

  const hashes = new Set<string>();
  for (const action of store.actions.byIds(episode.actions)) {
    for (const eventId of action.evidence) {
      const hash = store.events.get(eventId)?.hash;
      if (hash) hashes.add(hash);
    }
  }
  return [...hashes].sort();
}

/**
 * Repo-relative form of an artifact path, or undefined when it cannot be made
 * repo-relative. "./" prefixes are stripped; absolute paths are relativized
 * against `repoRoot` when they live under it and DROPPED otherwise — an
 * absolute local path must never cross the mesh boundary (username/home-layout
 * leak, and it can never match a teammate's repo-relative gate query).
 */
export function toRepoRelativePath(
  artifact: string,
  repoRoot: string,
): string | undefined {
  const value = artifact.trim();
  if (value === "" || value.startsWith("~") || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }

  // Treat backslashes as separators for traversal detection even on POSIX.
  // A captured Windows absolute path cannot be related to a local POSIX
  // consent root and therefore fails closed.
  const portable = value.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(portable) || portable.startsWith("//")) return undefined;
  if (portable.split("/").includes("..")) return undefined;

  const root = canonicalizeLocalPath(repoRoot);
  if (!root) return undefined;
  const candidate = canonicalizeLocalPath(
    isAbsolute(portable) ? portable : resolve(root, portable),
  );
  if (!candidate || !pathIsInside(candidate, root)) return undefined;

  const repoRelative = relative(root, candidate);
  if (repoRelative === "" || repoRelative === ".") return undefined;
  return repoRelative.split(sep).join("/");
}

export function episodeToWorkFrame(
  episode: Episode,
  ctx: WorkFrameContext,
): WorkFrame {
  const repo = normalizeRepoUrl(ctx.project);
  const repoRoot = ctx.repoRoot ?? process.cwd();
  const artifacts = episode.artifacts
    .filter((artifact) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(artifact))
    .map((artifact) => toRepoRelativePath(artifact, repoRoot))
    .filter((path): path is string => path !== undefined)
    .map((path) => ({ repo, path }));

  // Privacy: a goal inferred from a typed prompt (payload.goalSource ===
  // "prompt", see fuser.ts inferGoal) is a prompt-body prefix and must never
  // serialize mesh-bound; fall back to the factual, ledger-derived summary.
  const goalIsPromptDerived = episode.payload?.goalSource === "prompt";
  const intentSource = goalIsPromptDerived
    ? episode.summary
    : episode.goal ?? episode.summary;

  const frame: WorkFrame = {
    v: 0,
    id: randomUUID(),
    kind: "workframe",
    person: ctx.person,
    device: ctx.device,
    project: repo,
    ts: ctx.ts ?? episode.endTs,
    intent: redactText(oneLine(intentSource ?? "")),
    status: ctx.status ?? "active",
    artifacts,
    uncertainty: episode.uncertainty.map((item) => redactText(item)),
    claimsTouched: claimsTouched(episode, ctx.store),
    evidenceRefs: evidenceRefs(episode, ctx.store),
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
  };

  return redactWorkFrame(frame);
}
