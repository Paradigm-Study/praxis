/**
 * Praxis core domain model.
 *
 * The central design principle of the whole system lives in these types:
 *
 *   Raw taps prove what happened.   -> RawEvent (no confidence; it just *is*)
 *   The model explains why it mattered. -> ActionEvent / Observation / Claim
 *                                          (always carry `confidence` + `evidence`)
 *
 * A model is never the source of truth for user actions. Every interpretation
 * type below carries an `evidence` array of RawEvent / ActionEvent ids so any
 * claim can be traced back to the high-fidelity ledger that justifies it.
 */

// ---------------------------------------------------------------------------
// Layer 1 — Universal Capture: the raw event ledger
// ---------------------------------------------------------------------------

/** Every capture tap is normalized into one of these source channels. */
export type EventSource =
  | "screen_video" // low-FPS active screen/window frames (ScreenCaptureKit)
  | "accessibility" // active app UI tree, visible text, focused element
  | "input_events" // key/click timing, submit/save/send moments (CGEventTap)
  | "focus_timeline" // app/window switches + dwell time
  | "clipboard" // copy/paste movement
  | "filesystem" // file saves, changed paths, content hashes, diffs
  | "git" // commits, branches, staged diffs
  | "terminal" // commands, output summaries, exit codes
  | "ai_proxy" // prompts/responses from routed AI tools
  | "browser_dom" // URL, title, DOM snapshots
  | "audio" // optional speech transcript / meeting context
  | "synthetic"; // generated events for demos + tests

export const EVENT_SOURCES: readonly EventSource[] = [
  "screen_video",
  "accessibility",
  "input_events",
  "focus_timeline",
  "clipboard",
  "filesystem",
  "git",
  "terminal",
  "ai_proxy",
  "browser_dom",
  "audio",
  "synthetic",
];

/**
 * The atomic unit of the ledger. A RawEvent is a *fact*: it asserts only that a
 * tap observed something at a point in time. Large data (screenshots, video
 * chunks, terminal logs, file snapshots, audio) is offloaded to the blob store
 * and referenced by hash in `blobRefs`.
 */
export interface RawEvent {
  /** `event_...` */
  id: string;
  /** ISO-8601 timestamp, millisecond precision. */
  ts: string;
  source: EventSource;
  /** Foreground application, e.g. "Codex". */
  app: string;
  /** Foreground window title. */
  window: string;
  /** Source-specific event type, e.g. "focused_text_changed". */
  type: string;
  /** Source-specific structured fields. Small enough to live inline. */
  payload: Record<string, unknown>;
  /** Content hashes of any large blobs this event references. */
  blobRefs: string[];
  /** sha256 of the canonical event content (used for dedupe + integrity). */
  hash: string;
}

// ---------------------------------------------------------------------------
// Layer 2 — Storage: blobs
// ---------------------------------------------------------------------------

export type BlobKind =
  | "image" // screen frame / screenshot
  | "video" // screen video chunk
  | "text" // terminal log, AX dump, DOM snapshot
  | "file" // captured file snapshot
  | "audio" // audio chunk
  | "diff"; // unified diff

export interface BlobRecord {
  /** sha256 content hash — also the lookup key. */
  hash: string;
  kind: BlobKind;
  /** Path inside the content-addressed blob directory. */
  path: string;
  bytes: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Layer 3 — Action Reconstructor: exact user actions
// ---------------------------------------------------------------------------

/**
 * The canonical, supported action vocabulary. The reconstructor may also emit
 * descriptive low-confidence labels (e.g. "possibly_reading_discord_thread"),
 * so the type is widened with `(string & {})` to keep literal autocomplete while
 * permitting open-vocabulary weak actions.
 */
export type ActionType =
  | "switched_app"
  | "opened_file"
  | "opened_page"
  | "read_dwelled"
  | "typed_draft"
  | "submitted_message"
  | "received_response"
  | "copied"
  | "pasted"
  | "clicked_control"
  | "accepted_suggestion"
  | "rejected_suggestion"
  | "edited_file"
  | "saved_file"
  | "ran_command"
  | "inspected_failure"
  | "retried"
  | "committed"
  | "corrected_agent"
  | "answered_question"
  | "taught_learner"
  | "attended_meeting"
  | "listened_audio";

export const ACTION_TYPES: readonly ActionType[] = [
  "switched_app",
  "opened_file",
  "opened_page",
  "read_dwelled",
  "typed_draft",
  "submitted_message",
  "received_response",
  "copied",
  "pasted",
  "clicked_control",
  "accepted_suggestion",
  "rejected_suggestion",
  "edited_file",
  "saved_file",
  "ran_command",
  "inspected_failure",
  "retried",
  "committed",
  "corrected_agent",
  "answered_question",
  "taught_learner",
  "attended_meeting",
  "listened_audio",
];

/**
 * A reconstructed user action. Unlike a RawEvent, this is an *interpretation*:
 * it has a confidence and points back at the raw events that justify it. Weak
 * evidence yields a low confidence and a populated `uncertainty` list.
 */
export interface ActionEvent {
  /** `action_...` */
  id: string;
  type: "user_action";
  action: ActionType | (string & {});
  app: string;
  window?: string;
  startTs: string;
  endTs: string;
  /** Human-meaningful text the action centered on (a message, a command, …). */
  text?: string;
  /** 0..1 — how strongly the evidence supports this reconstruction. */
  confidence: number;
  /** RawEvent ids that justify this action. Never empty for a real action. */
  evidence: string[];
  /** Why we are unsure, when confidence is low. */
  uncertainty?: string[];
  /** Action-specific structured fields (path, command, exitCode, …). */
  payload?: Record<string, unknown>;
  /** Names of the deterministic rule(s) that fired. */
  reconstructedBy?: string[];
}

// ---------------------------------------------------------------------------
// Layer 4 — Context Episode Fuser
// ---------------------------------------------------------------------------

/** Why the fuser closed one episode and started the next. */
export type BoundaryReason =
  | "task_shift"
  | "app_window_shift"
  | "command_test_cycle"
  | "file_save_commit"
  | "conversation_turn"
  | "long_dwell_gap"
  | "user_correction"
  | "session_start"
  | "session_end";

export interface Episode {
  /** `episode_...` */
  id: string;
  type: "context_episode";
  startTs: string;
  endTs: string;
  summary: string;
  goal?: string;
  /** ActionEvent ids fused into this episode. */
  actions: string[];
  /** Files / URLs / artifacts touched. */
  artifacts: string[];
  decisionPoints: string[];
  rejectedPaths: string[];
  uncertainty: string[];
  /** What triggered the boundary that *opened* this episode. */
  boundaryReason?: BoundaryReason;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Layer 5 — Multimodal Observer
// ---------------------------------------------------------------------------

/**
 * A bounded slice of recent context handed to the observer model. The observer
 * never sees unbounded history — only the last ~30-120s, assembled here.
 */
export interface ContextBundle {
  id: string;
  startTs: string;
  endTs: string;
  windowSeconds: number;
  /** Blob hashes of screen frames in the window. */
  frames: string[];
  /** OCR'd visible text from screen frames (extracted at capture time). */
  frameText: string[];
  /** Base64 frame images for a multimodal model (only when requested). */
  frameImages?: Array<{ hash: string; base64: string; mediaType: string }>;
  /** Accessibility text snapshots. */
  axText: string[];
  inputEvents: RawEvent[];
  focus: RawEvent[];
  terminal: RawEvent[];
  fileDiffs: RawEvent[];
  /** On-device audio transcript segments + playback-state events. */
  audio: RawEvent[];
  /** Reconstructed conversation turns (submitted/answered). */
  conversationTurns: ActionEvent[];
  /** All reconstructed actions in the window. */
  actions: ActionEvent[];
}

/**
 * The observer's interpretation of a bundle. CRITICAL: this is model output and
 * is *always* attached to evidence. It is never written into the ledger as fact.
 */
export interface Observation {
  /** `obs_...` */
  id: string;
  bundleId: string;
  episodeId?: string;
  intent?: string;
  task?: string;
  decisionPoint?: string;
  acceptedOptions: string[];
  rejectedOptions: string[];
  inferredPreference?: string;
  uncertainty: string[];
  suggestedQuestion?: string;
  /** 2-4 candidate answers to suggestedQuestion the user can pick from. */
  options?: string[];
  /** ActionEvent / RawEvent ids backing this interpretation. */
  evidence: string[];
  /** Which model produced this (or "mock" for the offline observer). */
  model: string;
  createdTs: string;
}

// ---------------------------------------------------------------------------
// Layer 6 — Expert Memory Graph
// ---------------------------------------------------------------------------

export type ClaimKind =
  | "workflow_pattern"
  | "know_how"
  | "taste_rule"
  | "decision_rule"
  | "decision_heuristic"
  | "teaching_move"
  | "artifact_type"
  | "correction"
  | "unresolved_question";

export const CLAIM_KINDS: readonly ClaimKind[] = [
  "workflow_pattern",
  "know_how",
  "taste_rule",
  "decision_rule",
  "decision_heuristic",
  "teaching_move",
  "artifact_type",
  "correction",
  "unresolved_question",
];

export type ClaimProvenance =
  | "observed_pattern"
  | "model_inference"
  | "explicit_user_rule"
  | "user_answer"
  | "human_reviewed";

export interface Claim {
  /** `claim_...` */
  id: string;
  kind: ClaimKind | (string & {});
  text: string;
  confidence: number;
  /** Episode ids that evidence this claim. */
  evidenceEpisodes: string[];
  /** How the canonical claim entered memory; never infer trust from wording. */
  provenance?: ClaimProvenance;
  createdTs: string;
  updatedTs: string;
}

export type GraphNodeKind = ClaimKind;

export type GraphEdgeKind =
  | "observed_in_episode"
  | "caused_file_change"
  | "followed_failed_test"
  | "followed_passed_test"
  | "contradicted_by_correction"
  | "reused_across_days"
  | "taught_to_learner";

export const GRAPH_EDGE_KINDS: readonly GraphEdgeKind[] = [
  "observed_in_episode",
  "caused_file_change",
  "followed_failed_test",
  "followed_passed_test",
  "contradicted_by_correction",
  "reused_across_days",
  "taught_to_learner",
];

export interface GraphNode {
  /** `node_...` */
  id: string;
  kind: GraphNodeKind | (string & {});
  label: string;
  confidence: number;
  /** Backing claim id, if this node was promoted from a claim. */
  claimId?: string;
  data?: Record<string, unknown>;
  createdTs: string;
  updatedTs: string;
}

export interface GraphEdge {
  /** `edge_...` */
  id: string;
  from: string; // GraphNode id OR episode id (for observed_in_episode)
  to: string;
  kind: GraphEdgeKind | (string & {});
  data?: Record<string, unknown>;
  createdTs: string;
}

// ---------------------------------------------------------------------------
// Corrections — the human-in-the-loop that keeps the model honest
// ---------------------------------------------------------------------------

export type CorrectionTarget =
  | "action"
  | "episode"
  | "claim"
  | "observation"
  | "decision";
export type CorrectionVerdict = "confirmed" | "rejected" | "edited";
/**
 * Trust boundary for correction receipts. Only `human` receipts may alter
 * derived memory. `agent` receipts are auditable suggestions; `legacy` rows
 * predate origin tracking and fail closed until a person reviews them again.
 */
export type CorrectionOrigin = "human" | "agent" | "legacy";

/**
 * A verdict receipt on an interpretation. Human receipts power the "I think
 * you did X because Y — correct?" loop and may feed back into the graph. Agent
 * suggestions and ambiguous legacy receipts are retained for audit only.
 */
export interface Correction {
  /** `corr_...` */
  id: string;
  targetKind: CorrectionTarget;
  targetId: string;
  verdict: CorrectionVerdict;
  /** Who authored the verdict; missing/unknown values are never human trust. */
  origin?: CorrectionOrigin;
  /** Replacement text when verdict is "edited". */
  correctedText?: string;
  note?: string;
  createdTs: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Anything that is a model interpretation rather than a raw fact implements
 * this shape: it can always be traced back to the ledger.
 */
export interface Interpretation {
  confidence: number;
  evidence: string[];
}

/** A half-open time window [start, end). */
export interface TimeWindow {
  startTs: string;
  endTs: string;
}

/**
 * A persisted agent-loop decision (Layer 7 output). Stored so the Studio can
 * surface the agent's live questions/interventions. Like all interpretations it
 * carries evidence; `kind` is the policy's DecisionKind.
 */
export interface StoredDecision {
  /** `decision_...` */
  id: string;
  kind: string;
  reason: string;
  question?: string;
  evidence: string[];
  observationId?: string;
  claimId?: string;
  createdTs: string;
}
