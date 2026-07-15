import { isAbsolute, resolve, sep } from "node:path";
import type { ActionEvent, Episode, Observation } from "../core/types.ts";
import { sha256 } from "../core/hash.ts";
import type { Store } from "../storage/index.ts";
import type {
  MeshContextSourceConsent,
  MeshContextSourceKind,
  PrivacyControl,
} from "../privacy/control.ts";
import { redactContextFrame, redactText } from "./redact.ts";
import type {
  ContextFrame,
  ContextFrameStatus,
  ContextSignalKind,
} from "./types.ts";
import { toRepoRelativePath } from "./workframe.ts";
import { isMeshProjectConsented } from "./projectConsent.ts";

export interface ContextFrameContext {
  person: string;
  device: string;
  store: Store;
  control: PrivacyControl;
  status: ContextFrameStatus;
  project?: { project: string; repoRoot: string; sessionKey?: string };
}

const DOCUMENT_ACTIONS = new Set(["opened_file", "edited_file", "saved_file"]);
const MEETING_ACTIONS = new Set(["attended_meeting", "spoke_aloud", "listened_audio"]);
const SAFE_OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

/**
 * Bind retry consent to the complete selector grant without exposing its
 * local selector. Reusing a Desktop grant id for a different local source (or
 * changing what that source may disclose) cannot release prior records.
 */
export function contextSourceWireId(consent: MeshContextSourceConsent): string {
  return `source:${sha256(JSON.stringify([
    consent.id,
    consent.kind,
    consent.localSelector,
    consent.sharedLabel ?? "",
    [...consent.initiativeIds].sort(),
  ])).slice(0, 24)}`;
}

/** Live send/retry fence for a fully projected frame. */
export function isContextFrameCurrentlyConsented(
  control: PrivacyControl,
  frame: ContextFrame,
): boolean {
  const sourceGranted = control.meshContextSourceConsents.some((consent) =>
    consent.enabled
    && consent.kind === frame.source.kind
    && contextSourceWireId(consent) === frame.source.id
  );
  if (!sourceGranted) return false;
  if (frame.source.kind !== "agent_session") return true;
  return frame.artifacts.length > 0
    && frame.artifacts.every((artifact) =>
      isMeshProjectConsented(control.meshProjectConsents, artifact.repo)
    );
}

function stringsFromPayload(payload: Record<string, unknown> | undefined): string[] {
  if (!payload) return [];
  const keys = ["cwd", "path", "file", "filePath", "filename", "sessionKey"];
  return keys.flatMap((key) => typeof payload[key] === "string" ? [payload[key] as string] : []);
}

function selectorMatches(selector: string, candidates: string[]): boolean {
  if (selector === "*") return true;
  if (isAbsolute(selector)) {
    const root = resolve(selector);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return candidates.some((candidate) => {
      if (!isAbsolute(candidate)) return false;
      const path = resolve(candidate);
      return path === root || path.startsWith(prefix);
    });
  }
  const expected = selector.toLowerCase();
  return candidates.some((candidate) => {
    const value = candidate.toLowerCase();
    return value === expected || value.includes(expected);
  });
}

function sourceCandidates(
  kind: MeshContextSourceKind,
  episode: Episode,
  actions: ActionEvent[],
  store: Store,
): string[] {
  if (kind === "meeting") {
    return actions
      .filter((action) => MEETING_ACTIONS.has(action.action))
      .flatMap((action) => [
        action.app,
        action.window ?? "",
        ...action.evidence.flatMap((id) => {
          const event = store.events.get(id);
          return event ? [event.app, event.window] : [];
        }),
      ])
      .filter(Boolean);
  }
  if (kind === "agent_session") {
    return actions.flatMap((action) => stringsFromPayload(action.payload));
  }
  return [
    ...episode.artifacts,
    ...actions.filter((action) => DOCUMENT_ACTIONS.has(action.action))
      .flatMap((action) => stringsFromPayload(action.payload)),
  ];
}

function sourceIsPresent(kind: MeshContextSourceKind, actions: ActionEvent[]): boolean {
  if (kind === "meeting") return actions.some((action) => MEETING_ACTIONS.has(action.action));
  if (kind === "agent_session") {
    return actions.some((action) => typeof action.payload?.sessionKey === "string");
  }
  return actions.some((action) => DOCUMENT_ACTIONS.has(action.action));
}

function matchingConsent(
  control: PrivacyControl,
  kind: MeshContextSourceKind,
  episode: Episode,
  actions: ActionEvent[],
  store: Store,
): MeshContextSourceConsent | undefined {
  if (!sourceIsPresent(kind, actions)) return undefined;
  const candidates = sourceCandidates(kind, episode, actions, store);
  return control.meshContextSourceConsents.find((consent) =>
    consent.enabled
    && consent.kind === kind
    && selectorMatches(consent.localSelector, candidates)
  );
}

function groundedObservations(store: Store, episode: Episode): Observation[] {
  const actionIds = new Set(episode.actions);
  const eventIds = new Set(store.actions.byIds(episode.actions).flatMap((action) => action.evidence));
  return store.observations.byEpisode(episode.id).filter((observation) =>
    observation.evidence.length > 0
    && observation.evidence.some((id) => actionIds.has(id) || eventIds.has(id))
  );
}

function frameSummary(episode: Episode, observations: Observation[]): string {
  const latest = observations.at(-1);
  const semantic = latest?.decisionPoint
    ?? latest?.task
    ?? latest?.intent
    ?? latest?.suggestedQuestion;
  // A prompt-derived goal is private prompt content; the fuser's factual
  // summary remains the safe fallback, as in the v0 WorkFrame producer.
  const fallback = episode.payload?.goalSource === "prompt"
    ? episode.summary
    : episode.summary || episode.goal || "Activity observed";
  return redactText((semantic ?? fallback).replace(/\s+/g, " ").trim(), { maxChars: 500 });
}

function signalFor(episode: Episode, observations: Observation[]): ContextSignalKind {
  const latest = observations.at(-1);
  if (latest?.decisionPoint || (latest?.acceptedOptions.length ?? 0) > 0) return "decision";
  if (latest?.suggestedQuestion) return "question";
  const text = [latest?.task, latest?.intent, episode.summary].filter(Boolean).join(" ");
  if (/\b(?:handoff|hand over|take over|owner)\b/i.test(text)) return "handoff";
  if (/\b(?:must|required?|requirement|needs to)\b/i.test(text)) return "requirement";
  if (episode.uncertainty.length > 0 || (latest?.uncertainty.length ?? 0) > 0) return "risk";
  return "activity";
}

function claimIds(store: Store, episode: Episode): string[] {
  const out = new Set<string>();
  for (const edge of store.graph.edges()) {
    if (edge.kind !== "observed_in_episode" || edge.to !== episode.id) continue;
    const claimId = store.graph.getNode(edge.from)?.claimId;
    if (claimId && SAFE_OPAQUE.test(claimId)) out.add(claimId);
  }
  return [...out].sort();
}

function evidenceHashes(store: Store, episode: Episode, observations: Observation[]): string[] {
  const ids = new Set<string>();
  for (const action of store.actions.byIds(episode.actions)) {
    for (const id of action.evidence) ids.add(id);
  }
  for (const observation of observations) {
    for (const id of observation.evidence) ids.add(id);
  }
  const hashes = new Set<string>();
  for (const id of ids) {
    const direct = store.events.get(id)?.hash;
    if (direct) hashes.add(direct);
    const action = store.actions.get(id);
    for (const eventId of action?.evidence ?? []) {
      const hash = store.events.get(eventId)?.hash;
      if (hash) hashes.add(hash);
    }
  }
  return [...hashes].sort();
}

function sessionKey(actions: ActionEvent[]): string | undefined {
  const values = [...new Set(actions.flatMap((action) => {
    const value = action.payload?.sessionKey;
    return typeof value === "string" && SAFE_OPAQUE.test(value) ? [value] : [];
  }))];
  return values.length === 1 ? values[0] : undefined;
}

/**
 * Project an episode into zero or more consented v1 frames. Source selectors
 * are used only to choose a grant; only the grant id/shared label/initiatives
 * survive the explicit wire projection.
 */
export function episodeToContextFrames(
  episode: Episode,
  ctx: ContextFrameContext,
): ContextFrame[] {
  const actions = ctx.store.actions.byIds(episode.actions);
  const observations = groundedObservations(ctx.store, episode);
  const summary = frameSummary(episode, observations);
  const session = sessionKey(actions);
  const kinds: MeshContextSourceKind[] = ["meeting", "document", "agent_session"];
  return kinds.flatMap((kind) => {
    const consent = matchingConsent(ctx.control, kind, episode, actions, ctx.store);
    if (!consent) return [];
    // Agent sessions are never shared from a source grant alone: a live cwd →
    // canonical repo grant and one safe session key are both mandatory.
    if (kind === "agent_session" && (!ctx.project || !session)) return [];
    const artifactCandidates = [...new Set([
      ...episode.artifacts,
      ...actions.flatMap((action) => [action.payload?.path, action.payload?.filePath, action.payload?.file]
        .filter((value): value is string => typeof value === "string")),
    ])];
    const artifacts = ctx.project
      ? artifactCandidates.flatMap((artifact) => {
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(artifact)) return [];
          const path = toRepoRelativePath(artifact, ctx.project!.repoRoot);
          return path ? [{ repo: ctx.project!.project, path }] : [];
        })
      : [];
    if (kind === "agent_session" && artifacts.length === 0) return [];
    const sourceId = contextSourceWireId(consent);
    const idFor = (status: "active" | "done"): string =>
      `ctx:${sha256(`${episode.id}\0${status}\0${kind}\0${sourceId}`).slice(0, 24)}`;
    const id = idFor(ctx.status);
    return [redactContextFrame({
      v: 1,
      id,
      kind: "context_frame",
      person: ctx.person,
      device: ctx.device,
      ts: episode.endTs,
      source: {
        kind,
        id: sourceId,
        ...(consent.sharedLabel ? { label: consent.sharedLabel } : {}),
      },
      signal: signalFor(episode, observations),
      summary,
      status: ctx.status,
      entities: consent.initiativeIds.map((key) => ({ kind: "initiative" as const, key })),
      artifacts,
      links: ctx.status === "done"
        ? [{ relation: "updates", targetId: idFor("active"), reason: "Episode completed" }]
        : [],
      uncertainty: [...episode.uncertainty, ...observations.flatMap((item) => item.uncertainty)],
      claimsTouched: claimIds(ctx.store, episode),
      evidenceRefs: evidenceHashes(ctx.store, episode, observations),
      ...(kind === "agent_session" && session ? { sessionKey: session } : {}),
    })];
  });
}
