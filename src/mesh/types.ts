/**
 * Mesh shared contract v0 — the wire types every paradigm-mesh package
 * (praxis, boardroom, mesh) implements EXACTLY. Do not extend these shapes
 * without bumping `v`; the relay and conductor parse them as-is.
 *
 * Privacy invariant (non-negotiable): nothing in a WorkFrame,
 * BoardroomLifecycle, or SyncVerification may carry raw events, blobs,
 * screen/audio content, or prompt/response bodies. `intent` is redacted text;
 * `evidenceRefs` are bare sha256 hashes that resolve ONLY on the owner's
 * machine.
 */

// ---------------------------------------------------------------------------
// WorkFrame — "what this person is doing right now", published on episode close
// ---------------------------------------------------------------------------

/** A repo-relative artifact a WorkFrame touches. */
export interface WorkFrameArtifact {
  /** Normalized git remote url (lowercase host, no .git, ssh→https). */
  repo: string;
  /** Repo-relative path. */
  path: string;
  branch?: string;
}

export type WorkFrameStatus = "active" | "done" | "abandoned";

export interface WorkFrame {
  v: 0;
  /** UUID (crypto.randomUUID()). */
  id: string;
  kind: "workframe";
  person: string;
  device: string;
  /** Git remote url or directory name. */
  project: string;
  /** ISO-8601. */
  ts: string;
  /** REDACTED one-line description of what the person is doing. */
  intent: string;
  status: WorkFrameStatus;
  artifacts: WorkFrameArtifact[];
  uncertainty: string[];
  /** Claim ids touched by this work. */
  claimsTouched: string[];
  /** sha256 hashes — resolve ONLY on the owner's machine. */
  evidenceRefs: string[];
  /** Optional agent session id. */
  sessionKey?: string;
}

// ---------------------------------------------------------------------------
// SyncVerification — content-free proof that one credential reached the relay
// ---------------------------------------------------------------------------

/**
 * This deliberately carries no project, intent, artifacts, evidence, or local
 * consent selector. Praxis gates it against a saved project locally; the relay
 * only needs the authenticated person/device and receipt timestamp.
 */
export interface SyncVerification {
  v: 0;
  kind: "sync_verification";
  person: string;
  device: string;
  /** ISO-8601. */
  ts: string;
}

// ---------------------------------------------------------------------------
// BoardroomLifecycle — card lifecycle events published by boardroom
// ---------------------------------------------------------------------------

export type LifecycleStage = "clarify" | "plan" | "spec" | "results";
export type LifecycleEvent = "raised" | "decided";

export interface LifecycleArtifact {
  repo: string;
  path: string;
}

export interface SpecCriterion {
  id: string;
  behavior: string;
}

export interface BoardroomLifecycle {
  v: 0;
  kind: "card_event";
  person: string;
  device: string;
  project: string;
  /** ISO-8601. */
  ts: string;
  cardId: string;
  stage: LifecycleStage;
  event: LifecycleEvent;
  verdict?: string;
  artifacts: LifecycleArtifact[];
  specCriteria: SpecCriterion[];
}

// ---------------------------------------------------------------------------
// ContextFrame v1 — source-neutral, privacy-minimized team knowledge
// ---------------------------------------------------------------------------

export type ContextFrameSourceKind =
  | "meeting"
  | "document"
  | "agent_session";

/** Read models may fold legacy repository frames alongside v1 sources. */
export type ContextSourceKind = "repository" | ContextFrameSourceKind;

export type ContextFrameStatus = "active" | "done";

export type ContextSignalKind =
  | "activity"
  | "decision"
  | "requirement"
  | "risk"
  | "question"
  | "handoff";

export type ContextEntityKind =
  | "initiative"
  | "goal"
  | "ticket"
  | "topic"
  | "customer"
  | "feature";

export type ContextLinkKind =
  | "supports"
  | "depends_on"
  | "blocks"
  | "updates"
  | "duplicates";

export interface ContextSourceRef {
  kind: ContextFrameSourceKind;
  /** Stable opaque source identity. Never a raw URL, local path, or title. */
  id: string;
  label?: string;
}

export interface ContextEntityRef {
  kind: ContextEntityKind;
  key: string;
  label?: string;
}

export interface ContextLink {
  relation: ContextLinkKind;
  targetId: string;
  reason: string;
}

/**
 * Additive v1 record for work that is not safely correlated by repository
 * identity alone. Local source selectors are deliberately absent.
 */
export interface ContextFrame {
  v: 1;
  id: string;
  kind: "context_frame";
  person: string;
  device: string;
  ts: string;
  source: ContextSourceRef;
  signal: ContextSignalKind;
  summary: string;
  status: ContextFrameStatus;
  entities: ContextEntityRef[];
  artifacts: WorkFrameArtifact[];
  links: ContextLink[];
  uncertainty: string[];
  claimsTouched: string[];
  evidenceRefs: string[];
  sessionKey?: string;
}

/** Anything POSTable to the relay's /outbox/:person. */
export type MeshFrame = WorkFrame | BoardroomLifecycle | ContextFrame | SyncVerification;

// ---------------------------------------------------------------------------
// BriefPayload — GET /brief response (relay) / GET /api/brief (studio)
// ---------------------------------------------------------------------------

export interface BriefTeammate {
  person: string;
  intent: string;
  artifacts: WorkFrameArtifact[];
  ts: string;
}

export interface BriefLockedSpec {
  person: string;
  cardId: string;
  specCriteria: SpecCriterion[];
  artifacts: LifecycleArtifact[];
  ts: string;
}

export interface BriefRecentDecision {
  person: string;
  project?: string;
  cardId: string;
  stage: LifecycleStage;
  verdict?: string;
  ts: string;
}

export interface BriefPayload {
  teammates: BriefTeammate[];
  lockedSpecs: BriefLockedSpec[];
  recentDecisions: BriefRecentDecision[];
}

// ---------------------------------------------------------------------------
// Cross-source coordination read model (GET /v1/coordination)
// ---------------------------------------------------------------------------

export interface KnowledgeActivity {
  id: string;
  seq: number;
  person: string;
  ts: string;
  sourceKinds: ContextSourceKind[];
  sourceId: string;
  sourceLabel?: string;
  signal: ContextSignalKind;
  summary: string;
  status: WorkFrameStatus;
  entities: ContextEntityRef[];
  artifacts: WorkFrameArtifact[];
  sessionKey?: string;
}

export interface KnowledgeRelationship {
  id: string;
  fromId: string;
  toId: string;
  kind: "related" | "overlap" | "dependency" | "impact" | "duplicate";
  score: number;
  reasons: Array<{
    kind: "shared_entity" | "shared_terms" | "artifact_overlap" | "explicit_link";
    detail: string;
    weight: number;
  }>;
  ts: string;
}

export interface KnowledgeInitiative {
  id: string;
  label: string;
  activityIds: string[];
  people: string[];
  sourceKinds: ContextSourceKind[];
  updatedAt: string;
}

export interface CoordinationAction {
  id: number;
  person: string;
  targets: string[];
  triggerClass: string;
  ts: string;
  severity: "info" | "warn" | "urgent";
  message: string;
  evidence: string[];
  receipts: Array<{
    channel: "team_feed" | "boardroom" | "agent";
    status: "delivered" | "failed" | "skipped";
    attemptedAt: string;
    error?: string;
  }>;
  verdict?: string;
}

export interface CoordinationPayload {
  generatedAt: string;
  activities: KnowledgeActivity[];
  relationships: KnowledgeRelationship[];
  initiatives: KnowledgeInitiative[];
  actions: CoordinationAction[];
}

// ---------------------------------------------------------------------------
// DispatchRecord — a persisted record of the agent deciding to dispatch work
// to a spawned agent (praxis-local; never leaves the machine un-redacted)
// ---------------------------------------------------------------------------

export type DispatchMode = "dry_run" | "spawned";
export type DispatchStatus = "planned" | "running" | "completed" | "failed";

export interface DispatchRecord {
  v: 0;
  /** `dispatch_...` (newId("dispatch")). */
  id: string;
  /** ISO-8601. */
  ts: string;
  /** REDACTED task text handed to the dispatched agent. */
  task: string;
  /** Why the policy decided to dispatch. */
  reason: string;
  /** Episode that triggered the dispatch, if any. */
  episodeId?: string;
  /** The persisted StoredDecision id this dispatch executes. */
  decisionId?: string;
  /** ActionEvent / RawEvent ids backing the dispatch decision. */
  evidence: string[];
  /** "dry_run" unless PRAXIS_DISPATCH_SPAWN=1 allowed a real spawn. */
  mode: DispatchMode;
  /** argv that was (dry_run: would have been) spawned, e.g. ["claude","-p",...]. */
  command?: string[];
  /** Agent session id when actually spawned (feeds WorkFrame.sessionKey). */
  sessionKey?: string;
  status: DispatchStatus;
  /** REDACTED one-line outcome summary, when known. */
  resultSummary?: string;
}
