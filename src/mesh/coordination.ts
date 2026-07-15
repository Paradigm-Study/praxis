import { redactText } from "./redact.ts";
import { normalizeMeshProjectIdentity, safeRepoRelativePath } from "./projectConsent.ts";
import type {
  ContextEntityKind,
  ContextSignalKind,
  ContextSourceKind,
  CoordinationAction,
  CoordinationPayload,
  KnowledgeActivity,
  KnowledgeInitiative,
  KnowledgeRelationship,
  WorkFrameArtifact,
  WorkFrameStatus,
} from "./types.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function opaque(value: unknown, max = 120): string | undefined {
  return typeof value === "string"
    && value.length <= max
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
      ? value
      : undefined;
}

function text(value: unknown, max: number): string {
  return typeof value === "string"
    ? redactText(value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim(), { maxChars: max })
    : "";
}

function iso(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

const SOURCE_KINDS = new Set<ContextSourceKind>(["repository", "meeting", "document", "agent_session"]);
const SIGNALS = new Set<ContextSignalKind>(["activity", "decision", "requirement", "risk", "question", "handoff"]);
const STATUSES = new Set<WorkFrameStatus>(["active", "done", "abandoned"]);
const ENTITY_KINDS = new Set<ContextEntityKind>(["initiative", "goal", "ticket", "topic", "customer", "feature"]);

function artifacts(value: unknown): WorkFrameArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((item) => {
    const raw = record(item);
    const repo = normalizeMeshProjectIdentity(typeof raw?.repo === "string" ? raw.repo : "");
    const path = safeRepoRelativePath(typeof raw?.path === "string" ? raw.path : "");
    const branch = typeof raw?.branch === "string"
      && raw.branch.length <= 200
      && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw.branch)
        ? raw.branch
        : undefined;
    return repo && path ? [{ repo, path, ...(branch ? { branch } : {}) }] : [];
  });
}

function activities(value: unknown): KnowledgeActivity[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item) => {
    const raw = record(item);
    if (!raw) return [];
    const id = opaque(raw?.id);
    const person = opaque(raw?.person);
    const ts = iso(raw?.ts);
    const sourceId = opaque(raw?.sourceId);
    const signal = raw?.signal as ContextSignalKind;
    const status = raw?.status as WorkFrameStatus;
    const summary = text(raw?.summary, 500);
    const seq = Number(raw?.seq);
    if (!id || !person || !ts || !sourceId || !summary || !Number.isSafeInteger(seq) || seq < 0
      || !SIGNALS.has(signal) || !STATUSES.has(status)) return [];
    const sourceKinds = Array.isArray(raw.sourceKinds)
      ? [...new Set(raw.sourceKinds.filter((kind): kind is ContextSourceKind => SOURCE_KINDS.has(kind as ContextSourceKind)))].slice(0, 4)
      : [];
    const entities = Array.isArray(raw.entities)
      ? raw.entities.slice(0, 32).flatMap((item) => {
          const entity = record(item);
          const kind = entity?.kind as ContextEntityKind;
          const key = opaque(entity?.key);
          const label = text(entity?.label, 200);
          return ENTITY_KINDS.has(kind) && key
            ? [{ kind, key, ...(label ? { label } : {}) }]
            : [];
        })
      : [];
    const sourceLabel = text(raw.sourceLabel, 200);
    const sessionKey = opaque(raw.sessionKey);
    return [{
      id,
      seq,
      person,
      ts,
      sourceKinds,
      sourceId,
      ...(sourceLabel ? { sourceLabel } : {}),
      signal,
      summary,
      status,
      entities,
      artifacts: artifacts(raw.artifacts),
      ...(sessionKey ? { sessionKey } : {}),
    }];
  });
}

function relationships(value: unknown): KnowledgeRelationship[] {
  if (!Array.isArray(value)) return [];
  const kinds = new Set(["related", "overlap", "dependency", "impact", "duplicate"]);
  const reasonKinds = new Set(["shared_entity", "shared_terms", "artifact_overlap", "explicit_link"]);
  return value.slice(0, 200).flatMap((item) => {
    const raw = record(item);
    if (!raw) return [];
    const id = opaque(raw?.id);
    const fromId = opaque(raw?.fromId);
    const toId = opaque(raw?.toId);
    const kind = raw?.kind;
    const score = Number(raw?.score);
    const ts = iso(raw?.ts);
    if (!id || !fromId || !toId || !kinds.has(String(kind)) || !Number.isFinite(score)
      || score < 0 || score > 1 || !ts) return [];
    const reasons = Array.isArray(raw.reasons)
      ? raw.reasons.slice(0, 16).flatMap((item) => {
          const reason = record(item);
          const reasonKind = reason?.kind;
          const detail = text(reason?.detail, 240);
          const weight = Number(reason?.weight);
          return reasonKinds.has(String(reasonKind)) && detail && Number.isFinite(weight) && weight >= 0 && weight <= 1
            ? [{ kind: reasonKind as KnowledgeRelationship["reasons"][number]["kind"], detail, weight }]
            : [];
        })
      : [];
    return [{ id, fromId, toId, kind: kind as KnowledgeRelationship["kind"], score, reasons, ts }];
  });
}

function initiatives(value: unknown): KnowledgeInitiative[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item) => {
    const raw = record(item);
    if (!raw) return [];
    const id = opaque(raw?.id);
    const label = text(raw?.label, 200);
    const updatedAt = iso(raw?.updatedAt);
    if (!id || !label || !updatedAt) return [];
    const activityIds = Array.isArray(raw.activityIds)
      ? raw.activityIds.flatMap((value) => opaque(value) ?? []).slice(0, 100)
      : [];
    const people = Array.isArray(raw.people)
      ? raw.people.flatMap((value) => opaque(value) ?? []).slice(0, 100)
      : [];
    const sourceKinds = Array.isArray(raw.sourceKinds)
      ? [...new Set(raw.sourceKinds.filter((kind): kind is ContextSourceKind => SOURCE_KINDS.has(kind as ContextSourceKind)))].slice(0, 4)
      : [];
    return [{ id, label, activityIds, people, sourceKinds, updatedAt }];
  });
}

function actions(value: unknown): CoordinationAction[] {
  if (!Array.isArray(value)) return [];
  const severities = new Set(["info", "warn", "urgent"]);
  const channels = new Set(["team_feed", "boardroom", "agent"]);
  const deliveryStatuses = new Set(["delivered", "failed", "skipped"]);
  return value.slice(0, 100).flatMap((item) => {
    const raw = record(item);
    if (!raw) return [];
    const id = Number(raw?.id);
    const person = opaque(raw?.person);
    const ts = iso(raw?.ts);
    const severity = raw?.severity;
    const message = text(raw?.message, 500);
    const triggerClass = opaque(raw?.triggerClass);
    if (!Number.isSafeInteger(id) || id < 0 || !person || !ts || !severities.has(String(severity))
      || !message || !triggerClass) return [];
    const targets = Array.isArray(raw.targets)
      ? raw.targets.flatMap((value) => opaque(value) ?? []).slice(0, 32)
      : [];
    const evidence = Array.isArray(raw.evidence)
      ? raw.evidence.flatMap((value) => opaque(value) ?? []).slice(0, 64)
      : [];
    const receipts = Array.isArray(raw.receipts)
      ? raw.receipts.slice(0, 16).flatMap((item) => {
          const receipt = record(item);
          const channel = receipt?.channel;
          const status = receipt?.status;
          const attemptedAt = iso(receipt?.attemptedAt);
          const error = text(receipt?.error, 240);
          return channels.has(String(channel)) && deliveryStatuses.has(String(status)) && attemptedAt
            ? [{
                channel: channel as CoordinationAction["receipts"][number]["channel"],
                status: status as CoordinationAction["receipts"][number]["status"],
                attemptedAt,
                ...(error ? { error } : {}),
              }]
            : [];
        })
      : [];
    const verdict = text(raw.verdict, 120);
    return [{
      id,
      person,
      targets,
      triggerClass,
      ts,
      severity: severity as CoordinationAction["severity"],
      message,
      evidence,
      receipts,
      ...(verdict ? { verdict } : {}),
    }];
  });
}

/** Bound and whitelist untrusted coordination JSON before local agent use. */
export function normalizeCoordinationPayload(value: unknown): CoordinationPayload | undefined {
  const raw = record(value);
  const generatedAt = iso(raw?.generatedAt);
  if (!raw || !generatedAt) return undefined;
  return {
    generatedAt,
    activities: activities(raw.activities),
    relationships: relationships(raw.relationships),
    initiatives: initiatives(raw.initiatives),
    actions: actions(raw.actions),
  };
}
