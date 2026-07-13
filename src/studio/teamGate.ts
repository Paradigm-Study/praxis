import { relative, sep } from "node:path";
import type { Store } from "../storage/index.ts";
import { canonicalizeLocalPath, pathIsInside } from "../mesh/localPath.ts";
import {
  resolveConsentedWorkspaceProject,
  safeMeshRelayBaseUrl,
  safeRepoRelativePath,
  safeMeshWireIdentity,
} from "../mesh/projectConsent.ts";
import { PrivacyControlStore } from "../privacy/control.ts";
import { EgressAuditor } from "../privacy/egress.ts";
import {
  boundedMeshJson,
  meshDisplayName,
  safeSharedText,
} from "./brief.ts";

export interface TeamGateConflict {
  person: string;
  kind: "active_edit" | "locked_spec";
  detail: string;
  ts: string;
}

export interface TeamGateResult {
  conflict: boolean;
  conflicts: TeamGateConflict[];
  /** Canonical repo-relative path checked at the relay. Never an absolute path. */
  path?: string;
}

export interface TeamGateOptions {
  cwd: string;
  path: string;
  fetchFn?: typeof fetch;
}

const EMPTY_GATE: TeamGateResult = { conflict: false, conflicts: [] };

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sanitizedConflicts(value: unknown): TeamGateConflict[] {
  const body = object(value);
  if (!Array.isArray(body?.conflicts)) return [];
  return body.conflicts.slice(0, 20).flatMap((item) => {
    const conflict = object(item);
    const principal = safeSharedText(conflict?.person, 120);
    const kind = conflict?.kind;
    const ts = safeSharedText(conflict?.ts, 64);
    if (!principal || (kind !== "active_edit" && kind !== "locked_spec") || !ts) return [];
    const displayName = meshDisplayName(principal);
    const detail = safeSharedText(conflict?.detail, 400)
      .split(principal).join(displayName)
      .replace(/member-[a-f0-9]{24}/g, "Team member");
    return detail ? [{ person: displayName, kind, detail, ts }] : [];
  });
}

/**
 * Local privacy proxy for pre-edit team collision checks. Absolute paths and
 * hosted credentials never leave this module together: consent resolves them
 * to one canonical project and repo-relative path before the relay request.
 */
export async function buildTeamGate(
  store: Store,
  opts: TeamGateOptions,
): Promise<TeamGateResult> {
  const cwd = canonicalizeLocalPath(opts.cwd);
  const target = canonicalizeLocalPath(opts.path);
  if (!cwd || !target) return EMPTY_GATE;

  const consents = PrivacyControlStore.forStore(store).read().meshProjectConsents;
  const consent = resolveConsentedWorkspaceProject(consents, cwd);
  const targetConsent = resolveConsentedWorkspaceProject(consents, target);
  if (
    !consent
    || !targetConsent
    || consent.workspaceRoot !== targetConsent.workspaceRoot
    || consent.project !== targetConsent.project
    || !pathIsInside(target, consent.workspaceRoot)
  ) return EMPTY_GATE;

  const repoPath = safeRepoRelativePath(relative(consent.workspaceRoot, target).split(sep).join("/"));
  if (!repoPath) return EMPTY_GATE;

  const rawUrl = process.env.PRAXIS_MESH_URL;
  const token = process.env.PRAXIS_MESH_TOKEN;
  const person = safeMeshWireIdentity(process.env.PRAXIS_PERSON);
  const teamId = process.env.PRAXIS_MESH_TEAM_ID;
  const deviceId = process.env.PRAXIS_MESH_DEVICE_ID;
  const safeTeamId = teamId === undefined ? undefined : safeMeshWireIdentity(teamId);
  const safeDeviceId = deviceId === undefined ? undefined : safeMeshWireIdentity(deviceId);
  if (
    !rawUrl || !token || !person
    || (teamId === undefined) !== (deviceId === undefined)
    || (teamId !== undefined && (!safeTeamId || !safeDeviceId))
  ) return { ...EMPTY_GATE, path: repoPath };
  const relayUrl = safeMeshRelayBaseUrl(rawUrl);
  if (!relayUrl) return { ...EMPTY_GATE, path: repoPath };

  const params = new URLSearchParams({ person, repo: consent.project, path: repoPath });
  const auditor = EgressAuditor.forStore(store);
  const bytes = Buffer.byteLength(params.toString());
  try {
    const response = await (opts.fetchFn ?? fetch)(`${relayUrl}/gate?${params}`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(safeTeamId && {
          "x-mesh-team-id": safeTeamId,
        }),
        ...(safeDeviceId && {
          "x-mesh-device-id": safeDeviceId,
        }),
      },
      signal: AbortSignal.timeout(2_000),
      redirect: "error",
    });
    if (!response.ok) {
      auditor.record({
        destination: relayUrl,
        purpose: "mesh_gate",
        categories: ["person", "project", "artifact_path"],
        bytes,
        outcome: "failed",
        status: response.status,
      });
      return { ...EMPTY_GATE, path: repoPath };
    }
    const value = await boundedMeshJson(response);
    const conflicts = sanitizedConflicts(value);
    auditor.record({
      destination: relayUrl,
      purpose: "mesh_gate",
      categories: ["person", "project", "artifact_path"],
      bytes,
      outcome: "succeeded",
      status: response.status,
    });
    return { conflict: conflicts.length > 0, conflicts, path: repoPath };
  } catch (error) {
    auditor.record({
      destination: relayUrl,
      purpose: "mesh_gate",
      categories: ["person", "project", "artifact_path"],
      bytes,
      outcome: "failed",
      error: String(error),
    });
    return { ...EMPTY_GATE, path: repoPath };
  }
}
