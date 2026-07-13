import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type { ActionEvent } from "../core/types.ts";
import { toMs } from "../core/time.ts";

const AGENT_EDIT_RULE = "agent.agentEditedFile";
const FILESYSTEM_EDIT_RULE = "editedFile";

/**
 * The filesystem watcher debounces for 120 ms and agent transcript records
 * carry their original timestamps. Two seconds is enough scheduling slack to
 * correlate those channels without turning a later edit into corroboration for
 * an earlier one.
 */
export const EDIT_COALESCE_WINDOW_MS = 2_000;

interface EditIdentity {
  absolutePath?: string;
  relativePath?: string;
  workspace?: string;
}

interface MatchCandidate {
  agentIndex: number;
  filesystemIndex: number;
  distanceMs: number;
  agentId: string;
  filesystemId: string;
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

function normalizedPath(value: string): string {
  return normalize(value.trim());
}

function containedRelativePath(
  workspace: string,
  absolutePath: string,
): string | undefined {
  const candidate = relative(workspace, absolutePath);
  if (
    candidate === "" ||
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  ) {
    return candidate === "" ? "." : undefined;
  }
  return normalizedPath(candidate);
}

function identityFor(
  action: ActionEvent,
  channel: "agent" | "filesystem",
): EditIdentity | undefined {
  const payload = action.payload;
  const rawPath = channel === "agent"
    ? stringField(payload, "filePath") ?? stringField(payload, "path") ?? action.text
    : stringField(payload, "path") ?? stringField(payload, "filePath") ?? action.text;
  if (!rawPath?.trim()) return undefined;

  const rawWorkspace = channel === "agent"
    ? stringField(payload, "cwd") ?? stringField(payload, "workspaceRoot")
    : stringField(payload, "workspaceRoot") ?? stringField(payload, "cwd");
  const workspace = rawWorkspace ? normalizedPath(rawWorkspace) : undefined;
  const path = normalizedPath(rawPath);
  const absolutePath = isAbsolute(path)
    ? path
    : workspace && isAbsolute(workspace)
      ? resolve(workspace, path)
      : undefined;
  const relativePath = isAbsolute(path)
    ? workspace && isAbsolute(workspace)
      ? containedRelativePath(workspace, path)
      : undefined
    : path;

  return { absolutePath, relativePath, workspace };
}

function samePhysicalPath(agent: EditIdentity, filesystem: EditIdentity): boolean {
  if (
    agent.absolutePath !== undefined &&
    filesystem.absolutePath !== undefined &&
    agent.absolutePath === filesystem.absolutePath
  ) {
    return true;
  }
  if (
    agent.relativePath === undefined ||
    filesystem.relativePath === undefined ||
    agent.relativePath !== filesystem.relativePath
  ) {
    return false;
  }

  // New filesystem events identify their watched workspace. When both sides
  // have a workspace, a same-named file in another repository is distinct.
  // The one-sided fallback supports older ledger events that predate that
  // metadata, but still requires an exact relative path and tight timestamp.
  return agent.workspace === undefined ||
    filesystem.workspace === undefined ||
    agent.workspace === filesystem.workspace;
}

function endpointDistanceMs(agent: ActionEvent, filesystem: ActionEvent): number {
  const agentStart = toMs(agent.startTs);
  const agentEnd = toMs(agent.endTs);
  const filesystemStart = toMs(filesystem.startTs);
  const filesystemEnd = toMs(filesystem.endTs);
  return Math.min(
    Math.abs(filesystemStart - agentStart),
    Math.abs(filesystemStart - agentEnd),
    Math.abs(filesystemEnd - agentStart),
    Math.abs(filesystemEnd - agentEnd),
  );
}

function unique(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])];
}

function mergedEdit(agent: ActionEvent, filesystem: ActionEvent): ActionEvent {
  const uncertainty = unique([
    ...(agent.uncertainty ?? []),
    ...(filesystem.uncertainty ?? []),
  ]);
  return {
    ...agent,
    // The successful structured tool action is the canonical fact and keeps
    // its content-addressed id. The interval expands only to cover the paired
    // corroboration, so rolling reconstruction cannot churn action identity.
    startTs: toMs(agent.startTs) <= toMs(filesystem.startTs)
      ? agent.startTs
      : filesystem.startTs,
    endTs: toMs(agent.endTs) >= toMs(filesystem.endTs)
      ? agent.endTs
      : filesystem.endTs,
    confidence: Math.max(agent.confidence, filesystem.confidence),
    evidence: unique([...agent.evidence, ...filesystem.evidence]),
    ...(uncertainty.length > 0 ? { uncertainty } : { uncertainty: undefined }),
    payload: { ...(filesystem.payload ?? {}), ...(agent.payload ?? {}) },
    reconstructedBy: unique([
      ...(agent.reconstructedBy ?? []),
      ...(filesystem.reconstructedBy ?? []),
    ]),
  };
}

/**
 * Collapse duplicate cross-channel representations of the same physical edit.
 *
 * Pairing is deliberately one-to-one. Agent edits never merge with other
 * agent edits, filesystem changes never merge with each other, and a single
 * observation cannot bridge multiple rapid writes into one action.
 */
export function coalesceEditActions(actions: ActionEvent[]): ActionEvent[] {
  const agentIndexes: number[] = [];
  const filesystemIndexes: number[] = [];
  actions.forEach((action, index) => {
    if (action.action !== "edited_file") return;
    if (action.reconstructedBy?.includes(AGENT_EDIT_RULE)) {
      agentIndexes.push(index);
    }
    if (action.reconstructedBy?.includes(FILESYSTEM_EDIT_RULE)) {
      filesystemIndexes.push(index);
    }
  });
  if (agentIndexes.length === 0 || filesystemIndexes.length === 0) return actions;

  const candidates: MatchCandidate[] = [];
  for (const agentIndex of agentIndexes) {
    const agent = actions[agentIndex]!;
    const agentIdentity = identityFor(agent, "agent");
    if (!agentIdentity) continue;
    for (const filesystemIndex of filesystemIndexes) {
      const filesystem = actions[filesystemIndex]!;
      const filesystemIdentity = identityFor(filesystem, "filesystem");
      if (
        !filesystemIdentity ||
        !samePhysicalPath(agentIdentity, filesystemIdentity)
      ) {
        continue;
      }
      const distanceMs = endpointDistanceMs(agent, filesystem);
      if (!Number.isFinite(distanceMs) || distanceMs > EDIT_COALESCE_WINDOW_MS) continue;
      candidates.push({
        agentIndex,
        filesystemIndex,
        distanceMs,
        agentId: agent.id,
        filesystemId: filesystem.id,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      left.distanceMs - right.distanceMs ||
      left.agentId.localeCompare(right.agentId) ||
      left.filesystemId.localeCompare(right.filesystemId),
  );

  const matchedAgents = new Set<number>();
  const matchedFilesystems = new Set<number>();
  const replacements = new Map<number, ActionEvent>();
  for (const candidate of candidates) {
    if (
      matchedAgents.has(candidate.agentIndex) ||
      matchedFilesystems.has(candidate.filesystemIndex)
    ) {
      continue;
    }
    matchedAgents.add(candidate.agentIndex);
    matchedFilesystems.add(candidate.filesystemIndex);
    replacements.set(
      candidate.agentIndex,
      mergedEdit(
        actions[candidate.agentIndex]!,
        actions[candidate.filesystemIndex]!,
      ),
    );
  }

  if (matchedFilesystems.size === 0) return actions;
  return actions.flatMap((action, index) => {
    if (matchedFilesystems.has(index)) return [];
    return [replacements.get(index) ?? action];
  });
}
