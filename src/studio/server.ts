import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";
import { defaultDataDir, type Store } from "../storage/index.ts";
import type {
  ActionEvent,
  BoundaryReason,
  Claim,
  ClaimProvenance,
  Correction,
  CorrectionTarget,
  CorrectionVerdict,
  Episode,
  GraphEdge,
  GraphNode,
  Observation,
  RawEvent,
  StoredDecision,
} from "../core/types.ts";
import { newId } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import { buildPlaybook } from "../transfer/transfer.ts";
import { buildBrief } from "./brief.ts";
import { buildTeamGate } from "./teamGate.ts";
import { acknowledgeSteeringDirective, claimSteeringDirective } from "./directives.ts";
import { handleBrowserIngest } from "./browserIngest.ts";
import { createMcpRouter } from "../mcp/router.ts";
import { isAllowedOrigin } from "../mcp/protocol.ts";
import { MeshPublisher } from "../mesh/publisher.ts";
import {
  isMeshProjectConsented,
  normalizeMeshProjectIdentity,
} from "../mesh/projectConsent.ts";
import { buildGraph } from "../memory/graph.ts";
import { applyCorrections } from "../memory/consolidate.ts";
import { logger } from "../core/log.ts";
import { PrivacyControlStore, type PrivacyControl } from "../privacy/control.ts";
import {
  RuntimeStatusStore,
  type CaptureRuntimeStatus,
} from "../capture/runtimeStatus.ts";
import { publishNativeAcquisitionPolicy } from "../privacy/nativePolicy.ts";
import { EgressAuditor } from "../privacy/egress.ts";
import {
  RetentionPolicyStore,
  runMaintenance,
  storageUsage,
  type RetentionPolicy,
} from "../storage/maintenance.ts";
import { authorizeLocalRequest, validateLocalToken } from "../security/localAuth.ts";
import { parseWorkflowReview, WORKFLOW_REVIEW_NOTE } from "../workflow/review.ts";
import {
  DISMISSED_QUESTION_NOTE_PREFIX,
  actionQuestionWasResolved,
  decisionHasSubstantiveEvidence,
  isActionQuestionWorthy,
  isMeaningfulCorrection,
  normalizeQuestion,
  questionWasResolved,
  sameQuestion,
  uniqueQuestionDecisions,
} from "../agent/questionQuality.ts";

const log = logger("studio");

const WORKFLOW_PAGE_LIMIT = 25;
const EPISODE_SNAPSHOT_LIMIT = 200;
const CLAIM_SNAPSHOT_LIMIT = 400;
const GRAPH_NODE_SNAPSHOT_LIMIT = 400;
const GRAPH_EDGE_SNAPSHOT_LIMIT = 400;
const OBSERVATION_SNAPSHOT_LIMIT = 200;
const CORRECTION_SNAPSHOT_LIMIT = 400;
// Electron rejects daemon responses at 5,000,000 bytes. Leave room for headers,
// future envelope fields, and small differences between serializers.
const API_RESPONSE_MAX_BYTES = 4_500_000;
// A corrupted episode must not produce an unbounded SQLite IN clause. Normal
// episodes keep every referenced action; this ceiling is only a safety valve.
const WORKFLOW_ACTION_SAFETY_LIMIT = 1_000;
const WORKFLOW_TRUNCATION_FIELD_LIMIT = 80;
const WORKFLOW_BOUNDARY_REASONS = new Set<BoundaryReason>([
  "task_shift",
  "app_window_shift",
  "command_test_cycle",
  "file_save_commit",
  "conversation_turn",
  "long_dwell_gap",
  "user_correction",
  "session_start",
  "session_end",
]);
const CLAIM_PROVENANCES = new Set<ClaimProvenance>([
  "observed_pattern",
  "model_inference",
  "explicit_user_rule",
  "user_answer",
  "human_reviewed",
]);

export interface StudioOptions {
  /** Injectable for focused local-API tests; undefined uses the live env. */
  meshPublisher?: MeshPublisher | null;
}

function correctionTargetExists(
  store: Store,
  targetKind: CorrectionTarget,
  targetId: string,
): boolean {
  switch (targetKind) {
    case "action": return store.actions.get(targetId) !== undefined;
    case "episode": return store.episodes.get(targetId) !== undefined;
    case "claim": return store.claims.get(targetId) !== undefined;
    case "observation": return store.observations.get(targetId) !== undefined;
    case "decision": return store.decisions.get(targetId) !== undefined;
  }
}

interface WorkflowTruncation {
  truncated: boolean;
  fields: string[];
  omittedFieldCount: number;
  actionCounts: {
    referenced: number;
    included: number;
    omitted: number;
    missing: number;
  };
}

interface WorkflowEvidenceItem {
  episode: Omit<Episode, "payload">;
  actions: Array<Omit<ActionEvent, "payload">>;
  truncation: WorkflowTruncation;
}

interface WorkflowEvidencePage {
  items: WorkflowEvidenceItem[];
  nextCursor: string | null;
}

interface WorkflowCursor {
  v: 1;
  startTs: string;
  id: string;
}

class InvalidWorkflowCursorError extends Error {}

interface TruncationTracker {
  fields: string[];
  seen: Set<string>;
  omittedFieldCount: number;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Launch Praxis Studio: a JSON API over the ledger + a static web UI. */
export function startStudio(store: Store, port = 4319, options: StudioOptions = {}): Server {
  const webDir = join(import.meta.dirname, "web");
  const clients = new Set<ServerResponse>();
  const mcpRouter = createMcpRouter(store);
  const localToken = validateLocalToken(process.env.PRAXIS_LOCAL_TOKEN);
  const meshPublisher = options.meshPublisher === undefined
    ? MeshPublisher.fromEnv(store, {
        // Studio and capture are separate processes. A dedicated spool keeps
        // their atomic NDJSON rewrites from racing while retaining the same
        // bounded/redacted retry behavior for verification requests.
        spoolPath: join(defaultDataDir(), "mesh-verification-outbox.ndjson"),
      })
    : options.meshPublisher ?? undefined;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/api/health") {
        return json(res, 200, { ok: true });
      }
      if (
        (path === "/api/mesh/gate"
          || path === "/api/mesh/verify"
          || path.startsWith("/api/mesh/directives"))
        && !localToken
      ) {
        return json(res, 403, { error: "team agent endpoints require local authentication" });
      }
      if (
        (path.startsWith("/api/") || path === "/mcp" || path.startsWith("/mcp/")) &&
        !authorizeLocalRequest(req, res, localToken)
      ) {
        return;
      }
      // MCP mount (default OFF): every /mcp request goes to the router when
      // PRAXIS_MCP=1; a false return falls through to normal handling.
      if (
        process.env.PRAXIS_MCP === "1" &&
        (path === "/mcp" || path.startsWith("/mcp/")) &&
        mcpRouter(req, res)
      ) {
        return;
      }
      if (path === "/api/stream") return handleStream(req, res, clients);
      if (path.startsWith("/api/")) return handleApi(store, req, res, path, url, meshPublisher);
      return serveStatic(webDir, path, res);
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  // Live tail: poll the ledger for new rows (works across processes via WAL)
  // and push them to every connected SSE client. This is the "what it sees now".
  let cursor = store.events.maxRowid();
  let decisionCursor = store.decisions.maxRowid();
  const tailTimer = setInterval(() => {
    if (clients.size === 0) {
      cursor = store.events.maxRowid();
      decisionCursor = store.decisions.maxRowid();
      return;
    }
    const broadcast = (line: string) => {
      for (const c of clients) c.write(line);
    };

    const { maxRowid, events } = store.events.sinceRowid(cursor);
    if (events.length > 0) {
      cursor = maxRowid;
      for (const e of events) broadcast(`event: raw\ndata: ${JSON.stringify(e)}\n\n`);
      broadcast(
        `event: counts\ndata: ${JSON.stringify({
          events: store.events.count(),
          actions: store.actions.count(),
        })}\n\n`,
      );
    }

    // Live agent decisions (the loop's ask_expert / intervene / summarize).
    const dec = store.decisions.sinceRowid(decisionCursor);
    if (dec.decisions.length > 0) {
      decisionCursor = dec.maxRowid;
      for (const d of dec.decisions) broadcast(`event: decision\ndata: ${JSON.stringify(d)}\n\n`);
    }
  }, 750);
  tailTimer.unref();

  // Heartbeat so proxies don't drop idle SSE connections.
  const heartbeatTimer = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 15000);
  heartbeatTimer.unref();
  server.on("close", () => {
    clearInterval(tailTimer);
    clearInterval(heartbeatTimer);
  });

  // A second studio racing for the port must not crash-loop: if a healthy
  // studio already serves it, defer to that one and exit cleanly.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err;
    fetch(`http://localhost:${port}/api/status`, {
      headers: localToken ? { authorization: `Bearer ${localToken}` } : {},
    })
      .then((r) => {
        process.stdout.write(
          r.ok
            ? `Praxis Studio already running on :${port} — deferring to it.\n`
            : `port ${port} is taken by something that isn't a Studio\n`,
        );
        process.exit(r.ok ? 0 : 1);
      })
      .catch(() => {
        process.stdout.write(`port ${port} is taken and not responding\n`);
        process.exit(1);
      });
  });
  // Privacy invariant: praxis servers bind loopback only by default.
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(
      `\nPraxis Studio → http://localhost:${port}  (Ctrl-C to stop)\n`,
    );
  });
  return server;
}

function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  clients: Set<ServerResponse>,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

function serveStatic(webDir: string, path: string, res: ServerResponse): void {
  const rel = path === "/" ? "index.html" : path.replace(/^\//, "");
  const file = join(webDir, rel);
  if (!file.startsWith(webDir) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(body);
}

function boundedQueryInteger(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function encodeWorkflowCursor(episode: Pick<Episode, "startTs" | "id">): string {
  const cursor: WorkflowCursor = { v: 1, startTs: episode.startTs, id: episode.id };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeWorkflowCursor(value: string | null): WorkflowCursor | undefined {
  if (value === null) return undefined;
  if (
    value.length < 1 ||
    value.length > 2_048 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) throw new InvalidWorkflowCursorError("invalid workflow cursor");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new InvalidWorkflowCursorError("invalid workflow cursor");
    }
    const raw = parsed as Record<string, unknown>;
    const timestamp = typeof raw.startTs === "string" ? Date.parse(raw.startTs) : Number.NaN;
    if (
      raw.v !== 1 ||
      typeof raw.startTs !== "string" ||
      raw.startTs.length < 1 ||
      raw.startTs.length > 128 ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString() !== raw.startTs ||
      typeof raw.id !== "string" ||
      raw.id.length < 1 ||
      raw.id.length > 512
    ) throw new InvalidWorkflowCursorError("invalid workflow cursor");
    return { v: 1, startTs: raw.startTs, id: raw.id };
  } catch (error) {
    if (error instanceof InvalidWorkflowCursorError) throw error;
    throw new InvalidWorkflowCursorError("invalid workflow cursor");
  }
}

function truncationTracker(): TruncationTracker {
  return { fields: [], seen: new Set(), omittedFieldCount: 0 };
}

function noteTruncation(tracker: TruncationTracker, field: string): void {
  if (tracker.seen.has(field)) return;
  tracker.seen.add(field);
  if (tracker.fields.length < WORKFLOW_TRUNCATION_FIELD_LIMIT) tracker.fields.push(field);
  else tracker.omittedFieldCount += 1;
}

function clippedString(
  value: unknown,
  maxChars: number,
  field: string,
  tracker: TruncationTracker,
  fallback = "",
): string {
  if (typeof value !== "string") {
    noteTruncation(tracker, field);
    return fallback;
  }
  if (value.length > maxChars) noteTruncation(tracker, field);
  return value.slice(0, maxChars);
}

function optionalClippedString(
  value: unknown,
  maxChars: number,
  field: string,
  tracker: TruncationTracker,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    noteTruncation(tracker, field);
    return undefined;
  }
  if (value.length > maxChars) noteTruncation(tracker, field);
  return value.slice(0, maxChars);
}

function workflowBoundaryReason(
  value: unknown,
  tracker: TruncationTracker,
): BoundaryReason | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && WORKFLOW_BOUNDARY_REASONS.has(value as BoundaryReason)) {
    return value as BoundaryReason;
  }
  noteTruncation(tracker, "episode.boundaryReason");
  return undefined;
}

function clippedStrings(
  value: unknown,
  maxItems: number,
  maxChars: number,
  field: string,
  tracker: TruncationTracker,
): string[] {
  if (!Array.isArray(value)) {
    noteTruncation(tracker, field);
    return [];
  }
  if (value.length > maxItems) noteTruncation(tracker, field);
  const result: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    if (typeof item !== "string") {
      noteTruncation(tracker, field);
      continue;
    }
    if (item.length > maxChars) noteTruncation(tracker, field);
    result.push(item.slice(0, maxChars));
  }
  return result;
}

function selectedActionIds(
  episode: Episode,
  limit: number,
  tracker: TruncationTracker,
): string[] {
  const source: unknown[] = Array.isArray(episode.actions) ? episode.actions : [];
  const selected: string[] = [];
  for (const value of source.slice(0, limit)) {
    // Oversized or malformed identifiers are omitted instead of becoming large
    // SQLite parameters or ambiguous clipped joins.
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      noteTruncation(tracker, "episode.actions");
      continue;
    }
    selected.push(value);
  }
  if (selected.length < source.length) noteTruncation(tracker, "episode.actions");
  return selected;
}

function projectWorkflowAction(
  action: ActionEvent,
  index: number,
  tracker: TruncationTracker,
): Omit<ActionEvent, "payload"> {
  const field = (name: string) => `actions[${index}].${name}`;
  const rawConfidence = Number(action.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(1, rawConfidence))
    : 0;
  if (confidence !== rawConfidence) noteTruncation(tracker, field("confidence"));
  const window = optionalClippedString(action.window, 500, field("window"), tracker);
  const text = optionalClippedString(action.text, 2_000, field("text"), tracker);
  const uncertainty = action.uncertainty === undefined
    ? undefined
    : clippedStrings(action.uncertainty, 12, 500, field("uncertainty"), tracker);
  const reconstructedBy = action.reconstructedBy === undefined
    ? undefined
    : clippedStrings(action.reconstructedBy, 16, 160, field("reconstructedBy"), tracker);
  return {
    id: clippedString(action.id, 256, field("id"), tracker, `action-${index}`),
    type: "user_action",
    action: clippedString(action.action, 160, field("action"), tracker, "captured_action"),
    app: clippedString(action.app, 240, field("app"), tracker),
    ...(window !== undefined ? { window } : {}),
    startTs: clippedString(action.startTs, 64, field("startTs"), tracker, "1970-01-01T00:00:00.000Z"),
    endTs: clippedString(action.endTs, 64, field("endTs"), tracker, "1970-01-01T00:00:00.000Z"),
    ...(text !== undefined ? { text } : {}),
    confidence,
    evidence: clippedStrings(action.evidence, 24, 160, field("evidence"), tracker),
    ...(uncertainty !== undefined ? { uncertainty } : {}),
    ...(reconstructedBy !== undefined ? { reconstructedBy } : {}),
  };
}

function boundedHead<T>(items: T[], maxBytes = API_RESPONSE_MAX_BYTES): T[] {
  const result: T[] = [];
  let bytes = 2; // []
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes + itemBytes + (result.length > 0 ? 1 : 0) > maxBytes) break;
    result.push(item);
    bytes += itemBytes + (result.length > 1 ? 1 : 0);
  }
  return result;
}

/** Keep the newest suffix while preserving the API's historical ASC order. */
function boundedTail<T>(items: T[], maxBytes = API_RESPONSE_MAX_BYTES): T[] {
  const result: T[] = [];
  let bytes = 2; // []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes + itemBytes + (result.length > 0 ? 1 : 0) > maxBytes) break;
    result.unshift(item);
    bytes += itemBytes + (result.length > 1 ? 1 : 0);
  }
  return result;
}

function projectSnapshotEvent(event: RawEvent): RawEvent {
  const tracker = truncationTracker();
  return {
    id: clippedString(event.id, 256, "event.id", tracker, "event"),
    ts: clippedString(event.ts, 64, "event.ts", tracker, "1970-01-01T00:00:00.000Z"),
    source: event.source,
    app: clippedString(event.app, 240, "event.app", tracker),
    window: clippedString(event.window, 500, "event.window", tracker),
    type: clippedString(event.type, 160, "event.type", tracker, "captured_event"),
    // The feed is a bounded timeline index. Full event payload remains
    // available from /api/event/:id when a user drills into one receipt.
    payload: {},
    blobRefs: clippedStrings(event.blobRefs, 32, 256, "event.blobRefs", tracker),
    hash: clippedString(event.hash, 256, "event.hash", tracker),
  };
}

function projectSnapshotAction(action: ActionEvent, index: number): Omit<ActionEvent, "payload"> {
  return projectWorkflowAction(action, index, truncationTracker());
}

function projectSnapshotEpisode(episode: Episode): Omit<Episode, "payload"> {
  const tracker = truncationTracker();
  const actions = selectedActionIds(episode, 128, tracker);
  const id = clippedString(episode.id, 256, "episode.id", tracker, "episode");
  const startTs = clippedString(episode.startTs, 64, "episode.startTs", tracker, "1970-01-01T00:00:00.000Z");
  const endTs = clippedString(episode.endTs, 64, "episode.endTs", tracker, "1970-01-01T00:00:00.000Z");
  const summary = clippedString(episode.summary, 2_000, "episode.summary", tracker);
  const goal = optionalClippedString(episode.goal, 1_000, "episode.goal", tracker);
  const boundaryReason = workflowBoundaryReason(episode.boundaryReason, tracker);
  const artifacts = clippedStrings(episode.artifacts, 32, 500, "episode.artifacts", tracker);
  const decisionPoints = clippedStrings(episode.decisionPoints, 16, 500, "episode.decisionPoints", tracker);
  const rejectedPaths = clippedStrings(episode.rejectedPaths, 16, 500, "episode.rejectedPaths", tracker);
  let uncertainty = clippedStrings(episode.uncertainty, 16, 500, "episode.uncertainty", tracker);
  if (tracker.seen.size > 0) {
    uncertainty = [
      ...uncertainty.slice(0, 15),
      "Episode snapshot was truncated for safe desktop display.",
    ];
  }
  return {
    id,
    type: "context_episode",
    startTs,
    endTs,
    summary,
    ...(goal !== undefined ? { goal } : {}),
    actions,
    artifacts,
    decisionPoints,
    rejectedPaths,
    uncertainty,
    ...(boundaryReason !== undefined ? { boundaryReason } : {}),
  };
}

function projectSnapshotClaim(claim: Claim): Claim {
  const tracker = truncationTracker();
  const confidence = Number.isFinite(claim.confidence)
    ? Math.max(0, Math.min(1, claim.confidence))
    : 0;
  const provenance = claim.provenance !== undefined
    && CLAIM_PROVENANCES.has(claim.provenance)
    ? claim.provenance
    : undefined;
  return {
    id: clippedString(claim.id, 256, "claim.id", tracker, "claim"),
    kind: clippedString(claim.kind, 160, "claim.kind", tracker, "unknown"),
    text: clippedString(claim.text, 4_000, "claim.text", tracker, "Unavailable claim"),
    confidence,
    evidenceEpisodes: clippedStrings(claim.evidenceEpisodes, 64, 256, "claim.evidenceEpisodes", tracker),
    ...(provenance !== undefined ? { provenance } : {}),
    createdTs: clippedString(claim.createdTs, 64, "claim.createdTs", tracker, "1970-01-01T00:00:00.000Z"),
    updatedTs: clippedString(claim.updatedTs, 64, "claim.updatedTs", tracker, "1970-01-01T00:00:00.000Z"),
  };
}

function projectSnapshotNode(node: GraphNode): Omit<GraphNode, "data"> {
  const tracker = truncationTracker();
  const confidence = Number.isFinite(node.confidence)
    ? Math.max(0, Math.min(1, node.confidence))
    : 0;
  const claimId = optionalClippedString(node.claimId, 256, "node.claimId", tracker);
  return {
    id: clippedString(node.id, 256, "node.id", tracker, "node"),
    kind: clippedString(node.kind, 160, "node.kind", tracker, "unknown"),
    label: clippedString(node.label, 4_000, "node.label", tracker, "Unavailable node"),
    confidence,
    ...(claimId !== undefined ? { claimId } : {}),
    createdTs: clippedString(node.createdTs, 64, "node.createdTs", tracker, "1970-01-01T00:00:00.000Z"),
    updatedTs: clippedString(node.updatedTs, 64, "node.updatedTs", tracker, "1970-01-01T00:00:00.000Z"),
  };
}

function projectSnapshotEdge(edge: GraphEdge): Omit<GraphEdge, "data"> {
  const tracker = truncationTracker();
  return {
    id: clippedString(edge.id, 256, "edge.id", tracker, "edge"),
    from: clippedString(edge.from, 256, "edge.from", tracker, "unknown"),
    to: clippedString(edge.to, 256, "edge.to", tracker, "unknown"),
    kind: clippedString(edge.kind, 160, "edge.kind", tracker, "unknown"),
    createdTs: clippedString(edge.createdTs, 64, "edge.createdTs", tracker, "1970-01-01T00:00:00.000Z"),
  };
}

function projectSnapshotObservation(observation: Observation): Observation {
  const tracker = truncationTracker();
  const optionalText = (value: unknown, max: number, field: string) =>
    optionalClippedString(value, max, field, tracker);
  const episodeId = optionalText(observation.episodeId, 256, "observation.episodeId");
  const intent = optionalText(observation.intent, 2_000, "observation.intent");
  const task = optionalText(observation.task, 2_000, "observation.task");
  const decisionPoint = optionalText(observation.decisionPoint, 2_000, "observation.decisionPoint");
  const inferredPreference = optionalText(observation.inferredPreference, 2_000, "observation.inferredPreference");
  const suggestedQuestion = optionalText(observation.suggestedQuestion, 2_000, "observation.suggestedQuestion");
  const options = observation.options === undefined
    ? undefined
    : clippedStrings(observation.options, 16, 500, "observation.options", tracker);
  return {
    id: clippedString(observation.id, 256, "observation.id", tracker, "observation"),
    bundleId: clippedString(observation.bundleId, 256, "observation.bundleId", tracker, "bundle"),
    ...(episodeId !== undefined ? { episodeId } : {}),
    ...(intent !== undefined ? { intent } : {}),
    ...(task !== undefined ? { task } : {}),
    ...(decisionPoint !== undefined ? { decisionPoint } : {}),
    acceptedOptions: clippedStrings(observation.acceptedOptions, 16, 500, "observation.acceptedOptions", tracker),
    rejectedOptions: clippedStrings(observation.rejectedOptions, 16, 500, "observation.rejectedOptions", tracker),
    ...(inferredPreference !== undefined ? { inferredPreference } : {}),
    uncertainty: clippedStrings(observation.uncertainty, 16, 500, "observation.uncertainty", tracker),
    ...(suggestedQuestion !== undefined ? { suggestedQuestion } : {}),
    ...(options !== undefined ? { options } : {}),
    evidence: clippedStrings(observation.evidence, 64, 256, "observation.evidence", tracker),
    model: clippedString(observation.model, 240, "observation.model", tracker, "unknown"),
    createdTs: clippedString(observation.createdTs, 64, "observation.createdTs", tracker, "1970-01-01T00:00:00.000Z"),
  };
}

function projectSnapshotCorrection(correction: Correction): Correction {
  const tracker = truncationTracker();
  const correctedText = optionalClippedString(
    correction.correctedText,
    64 * 1024,
    "correction.correctedText",
    tracker,
  );
  const note = optionalClippedString(correction.note, 2_000, "correction.note", tracker);
  return {
    id: clippedString(correction.id, 256, "correction.id", tracker, "correction"),
    targetKind: correction.targetKind,
    targetId: clippedString(correction.targetId, 256, "correction.targetId", tracker, "unknown"),
    verdict: correction.verdict,
    origin:
      correction.origin === "human" || correction.origin === "agent"
        ? correction.origin
        : "legacy",
    ...(correctedText !== undefined ? { correctedText } : {}),
    ...(note !== undefined ? { note } : {}),
    createdTs: clippedString(correction.createdTs, 64, "correction.createdTs", tracker, "1970-01-01T00:00:00.000Z"),
  };
}

function projectSnapshotDecision(decision: StoredDecision): StoredDecision {
  const tracker = truncationTracker();
  const question = optionalClippedString(decision.question, 2_000, "decision.question", tracker);
  const observationId = optionalClippedString(decision.observationId, 256, "decision.observationId", tracker);
  const claimId = optionalClippedString(decision.claimId, 256, "decision.claimId", tracker);
  return {
    id: clippedString(decision.id, 256, "decision.id", tracker, "decision"),
    kind: clippedString(decision.kind, 160, "decision.kind", tracker, "unknown"),
    reason: clippedString(decision.reason, 4_000, "decision.reason", tracker),
    ...(question !== undefined ? { question } : {}),
    evidence: clippedStrings(decision.evidence, 64, 256, "decision.evidence", tracker),
    ...(observationId !== undefined ? { observationId } : {}),
    ...(claimId !== undefined ? { claimId } : {}),
    createdTs: clippedString(decision.createdTs, 64, "decision.createdTs", tracker, "1970-01-01T00:00:00.000Z"),
  };
}

function projectWorkflowItem(
  store: Store,
  episode: Episode,
  actionLimit: number,
): WorkflowEvidenceItem {
  const tracker = truncationTracker();
  const sourceActionCount = Array.isArray(episode.actions) ? episode.actions.length : 0;
  const actionIds = selectedActionIds(episode, actionLimit, tracker);
  const sourceActions = store.actions.byIds(actionIds);
  const existingActionIds = new Set(sourceActions.map((action) => action.id));
  const missingActionCount = actionIds.filter((id) => !existingActionIds.has(id)).length;
  const projectedActions = sourceActions.map((action, index) => projectWorkflowAction(action, index, tracker));
  const episodeId = clippedString(episode.id, 256, "episode.id", tracker, "episode");
  const startTs = clippedString(episode.startTs, 64, "episode.startTs", tracker, "1970-01-01T00:00:00.000Z");
  const endTs = clippedString(episode.endTs, 64, "episode.endTs", tracker, "1970-01-01T00:00:00.000Z");
  const summary = clippedString(episode.summary, 2_000, "episode.summary", tracker);
  const goal = optionalClippedString(episode.goal, 1_000, "episode.goal", tracker);
  const boundaryReason = workflowBoundaryReason(episode.boundaryReason, tracker);
  const artifacts = clippedStrings(episode.artifacts, 64, 500, "episode.artifacts", tracker);
  const decisionPoints = clippedStrings(episode.decisionPoints, 32, 500, "episode.decisionPoints", tracker);
  const rejectedPaths = clippedStrings(episode.rejectedPaths, 32, 500, "episode.rejectedPaths", tracker);
  let uncertainty = clippedStrings(episode.uncertainty, 32, 500, "episode.uncertainty", tracker);
  const omittedActionCount = Math.max(0, sourceActionCount - actionIds.length);
  if (tracker.seen.size > 0 || missingActionCount > 0) {
    const warning = `Workflow evidence was truncated: included ${sourceActions.length} of ${sourceActionCount} referenced actions; shortened, omitted, or missing evidence may make this review incomplete.`;
    uncertainty = [...uncertainty.slice(0, 31), warning.slice(0, 500)];
  }
  const item: WorkflowEvidenceItem = {
    episode: {
      id: episodeId,
      type: "context_episode",
      startTs,
      endTs,
      summary,
      ...(goal !== undefined ? { goal } : {}),
      actions: actionIds,
      artifacts,
      decisionPoints,
      rejectedPaths,
      uncertainty,
      ...(boundaryReason !== undefined ? { boundaryReason } : {}),
    },
    actions: projectedActions,
    truncation: {
      truncated: false,
      fields: tracker.fields,
      omittedFieldCount: tracker.omittedFieldCount,
      actionCounts: {
        referenced: sourceActionCount,
        included: sourceActions.length,
        omitted: omittedActionCount,
        missing: missingActionCount,
      },
    },
  };
  item.truncation.truncated = tracker.seen.size > 0 || missingActionCount > 0;
  return item;
}

function workflowPageBytes(items: WorkflowEvidenceItem[], nextCursor: string | null): number {
  return Buffer.byteLength(JSON.stringify({ items, nextCursor }), "utf8");
}

function workflowEvidencePage(store: Store, url: URL): WorkflowEvidencePage {
  const limit = boundedQueryInteger(url.searchParams.get("limit"), WORKFLOW_PAGE_LIMIT, 1, WORKFLOW_PAGE_LIMIT);
  const cursor = decodeWorkflowCursor(url.searchParams.get("cursor"));
  // Fetch one extra row so continuation is exact without a separate COUNT.
  const fetched = store.episodes.pageAfter(limit + 1, cursor);
  const candidates = fetched.slice(0, limit);
  const items: WorkflowEvidenceItem[] = [];

  for (const episode of candidates) {
    let actionLimit = Math.min(episode.actions.length, WORKFLOW_ACTION_SAFETY_LIMIT);
    let item = projectWorkflowItem(store, episode, actionLimit);
    let bytes = workflowPageBytes([...items, item], encodeWorkflowCursor(episode));

    // Usually the page is shortened between episodes. If one episode alone is
    // oversized, progressively omit its tail actions and report that omission.
    while (items.length === 0 && bytes > API_RESPONSE_MAX_BYTES && actionLimit > 0) {
      actionLimit = Math.floor(actionLimit / 2);
      item = projectWorkflowItem(store, episode, actionLimit);
      bytes = workflowPageBytes([item], encodeWorkflowCursor(episode));
    }
    if (bytes > API_RESPONSE_MAX_BYTES) {
      if (items.length === 0) throw new Error("bounded workflow projection exceeds response limit");
      break;
    }
    items.push(item);
  }

  const hasMore = items.length < candidates.length || fetched.length > limit;
  const last = items.length > 0 ? candidates[items.length - 1] : undefined;
  return { items, nextCursor: hasMore && last ? encodeWorkflowCursor(last) : null };
}

function handleApi(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  meshPublisher?: MeshPublisher,
): void {
  // --- reads ---
  if (req.method === "GET") {
    if (path === "/api/mesh/directives/claim") {
      const sessionKey = url.searchParams.get("sessionKey");
      const cwd = url.searchParams.get("cwd");
      if (!sessionKey || !cwd) return json(res, 400, { error: "sessionKey and cwd are required" });
      void claimSteeringDirective(store, { sessionKey, cwd })
        .then((result) => json(res, 200, result))
        .catch((error) => {
          log.debug("directive claim failed open", String(error));
          json(res, 200, { directive: null });
        });
      return;
    }
    if (path === "/api/mesh/gate") {
      const cwd = url.searchParams.get("cwd");
      const targetPath = url.searchParams.get("path");
      if (!cwd || !targetPath) {
        return json(res, 400, { error: "cwd and path are required" });
      }
      void buildTeamGate(store, { cwd, path: targetPath })
        .then((result) => json(res, 200, result))
        .catch((err) => json(res, 500, { error: String(err) }));
      return;
    }
    // Team brief (async — may consult the mesh relay; empty when mesh is off).
    if (path === "/api/brief") {
      void buildBrief(store, {
        person: url.searchParams.get("person") ?? undefined,
        project: url.searchParams.get("project") ?? undefined,
        cwd: url.searchParams.get("cwd") ?? undefined,
      })
        .then((brief) => json(res, 200, brief))
        .catch((err) => json(res, 500, { error: String(err) }));
      return;
    }
    switch (path) {
      case "/api/status":
        return json(res, 200, {
          counts: {
            events: store.events.count(),
            actions: store.actions.count(),
            episodes: store.episodes.count(),
            claims: store.claims.count(),
            graph: store.graph.counts(),
          },
          eventsPerDay: store.analytics.eventsPerDay(),
          capture: captureStatus(store),
        });
      case "/api/capture/status":
        return json(res, 200, captureStatus(store));
      case "/api/privacy":
        return json(res, 200, PrivacyControlStore.forStore(store).read());
      case "/api/mesh/projects":
        return json(res, 200, {
          projects: PrivacyControlStore.forStore(store).read().meshProjectConsents,
        });
      case "/api/mesh/sources":
        return json(res, 200, {
          sources: PrivacyControlStore.forStore(store).read().meshContextSourceConsents,
        });
      case "/api/egress":
        return json(
          res,
          200,
          EgressAuditor.forStore(store).recent(Number(url.searchParams.get("limit") ?? 100)),
        );
      case "/api/storage/status":
        return json(res, 200, {
          usage: storageUsage(store),
          retention: RetentionPolicyStore.forStore(store).read(),
          encryption: {
            enabled: store.encryption.enabled,
            activeVersion: store.encryption.activeVersion,
            keyVersions: store.encryption.keyVersions,
          },
        });
      case "/api/storage/retention":
        return json(res, 200, RetentionPolicyStore.forStore(store).read());
      case "/api/feed":
        return json(
          res,
          200,
          boundedHead(store.events.recent(300).map(projectSnapshotEvent)),
        );
      case "/api/actions":
        // Newest first, bounded — the timeline grows forever; the browser
        // must not be handed (and animate) tens of thousands of rows.
        return json(
          res,
          200,
          boundedHead(store.actions.recent(400).map(projectSnapshotAction)),
        );
      case "/api/episodes": { // Oldest-to-newest within the bounded recent window.
        const limit = boundedQueryInteger(
          url.searchParams.get("limit"),
          EPISODE_SNAPSHOT_LIMIT,
          1,
          EPISODE_SNAPSHOT_LIMIT,
        );
        const episodes = store.episodes.recentProjection(limit).map(projectSnapshotEpisode);
        return json(res, 200, boundedTail(episodes));
      }
      case "/api/workflows": {
        try {
          return json(res, 200, workflowEvidencePage(store, url));
        } catch (error) {
          if (error instanceof InvalidWorkflowCursorError) {
            return json(res, 400, { error: "invalid workflow cursor" });
          }
          throw error;
        }
      }
      case "/api/claims": {
        const limit = boundedQueryInteger(
          url.searchParams.get("limit"),
          CLAIM_SNAPSHOT_LIMIT,
          1,
          CLAIM_SNAPSHOT_LIMIT,
        );
        const claims = applyCorrections(
          store.claims.all(),
          store.corrections.all().filter((correction) => correction.targetKind === "claim"),
        )
          .sort((left, right) =>
            right.confidence - left.confidence || right.updatedTs.localeCompare(left.updatedTs),
          )
          .slice(0, limit);
        return json(res, 200, boundedHead(claims.map(projectSnapshotClaim)));
      }
      case "/api/graph": {
        const nodeLimit = boundedQueryInteger(
          url.searchParams.get("nodes"),
          GRAPH_NODE_SNAPSHOT_LIMIT,
          1,
          GRAPH_NODE_SNAPSHOT_LIMIT,
        );
        const edgeLimit = boundedQueryInteger(
          url.searchParams.get("edges"),
          GRAPH_EDGE_SNAPSHOT_LIMIT,
          1,
          GRAPH_EDGE_SNAPSHOT_LIMIT,
        );
        // Reserve independent budgets so a pathological node label cannot
        // starve every edge (or vice versa) from the same snapshot.
        const nodes = boundedHead(store.graph.nodes(nodeLimit).map(projectSnapshotNode), 3_000_000);
        const edges = boundedHead(store.graph.edges(edgeLimit).map(projectSnapshotEdge), 1_400_000);
        return json(res, 200, { nodes, edges });
      }
      case "/api/observations": {
        const limit = boundedQueryInteger(
          url.searchParams.get("limit"),
          OBSERVATION_SNAPSHOT_LIMIT,
          1,
          OBSERVATION_SNAPSHOT_LIMIT,
        );
        const observations = store.observations.recent(limit).map(projectSnapshotObservation);
        return json(res, 200, boundedTail(observations));
      }
      case "/api/corrections": {
        const limit = boundedQueryInteger(
          url.searchParams.get("limit"),
          CORRECTION_SNAPSHOT_LIMIT,
          1,
          CORRECTION_SNAPSHOT_LIMIT,
        );
        const corrections = store.corrections.recent(limit).map(projectSnapshotCorrection);
        return json(res, 200, boundedTail(corrections));
      }
      case "/api/decisions":
        return json(
          res,
          200,
          boundedHead(store.decisions.recent(50).map(projectSnapshotDecision)),
        );
      case "/api/playbook":
        return json(res, 200, buildPlaybook(store));
      case "/api/connections":
        return json(res, 200, connections(store));
      case "/api/questions":
        return json(res, 200, questions(store));
    }
    if (path.startsWith("/api/event/")) {
      const ev = store.events.get(decodeURIComponent(path.slice("/api/event/".length)));
      return ev ? json(res, 200, ev) : json(res, 404, { error: "not found" });
    }
    if (path.startsWith("/api/blob/")) {
      const hash = decodeURIComponent(path.slice("/api/blob/".length));
      const rec = store.blobs.record(hash);
      const buf = store.blobs.get(hash);
      if (!rec || !buf) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": rec.kind === "image" ? "application/octet-stream" : "text/plain" });
      return void res.end(buf);
    }
  }

  // --- writes: browser-extension event batches ---
  if (req.method === "POST" && path === "/api/ingest/browser") {
    return handleBrowserIngest(store, req, res);
  }

  // Browser writes to loopback APIs must carry a local Origin. Non-browser
  // clients (Electron main, CLI, hooks) normally omit Origin and are allowed.
  if (
    (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") &&
    !isAllowedOrigin(headerValue(req.headers.origin))
  ) {
    return json(res, 403, { error: "origin not allowed" });
  }

  // --- writes: privacy/capture control -----------------------------------
  if (req.method === "POST" && path === "/api/mesh/verify") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      if (!data || typeof data.project !== "string") {
        return json(res, 400, { ok: false, error: "project is required" });
      }
      if (
        typeof data.teamId !== "string"
        || typeof data.deviceId !== "string"
        || !/^[A-Za-z0-9._:-]{1,120}$/.test(data.teamId)
        || !/^[A-Za-z0-9._:-]{1,120}$/.test(data.deviceId)
      ) {
        return json(res, 400, { ok: false, error: "team relay scope is required" });
      }
      const project = normalizeMeshProjectIdentity(data.project);
      if (!project) {
        return json(res, 400, { ok: false, error: "project identity is invalid" });
      }
      const consents = PrivacyControlStore.forStore(store).read().meshProjectConsents;
      if (!isMeshProjectConsented(consents, project)) {
        return json(res, 403, { ok: false, error: "project is not currently consented" });
      }
      if (!meshPublisher) {
        return json(res, 503, { ok: false, error: "team relay is not configured" });
      }
      if (meshPublisher.teamId !== data.teamId || meshPublisher.device !== data.deviceId) {
        return json(res, 409, { ok: false, error: "team relay scope changed; restart required" });
      }
      void meshPublisher.publishVerification(project, { teamId: data.teamId, deviceId: data.deviceId })
        .then((result) => json(res, result.ok ? 200 : 502, result))
        .catch((error) => {
          log.debug("mesh verification publish failed open", String(error));
          json(res, 502, { ok: false, error: "team relay did not confirm verification" });
        });
    });
  }
  if (req.method === "PUT" && path === "/api/privacy") {
    return readBody(req, res, (body) => {
      const data = safeParse(body);
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return json(res, 400, { error: "privacy control must be a JSON object" });
      }
      const control = PrivacyControlStore.forStore(store).update(data as Partial<PrivacyControl>);
      publishNativeAcquisitionPolicy(store);
      return json(res, 200, control);
    });
  }
  if (req.method === "PUT" && path === "/api/mesh/projects") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      if (!data || !Array.isArray(data.projects)) {
        return json(res, 400, { error: "projects must be an array" });
      }
      const control = PrivacyControlStore.forStore(store).update({
        meshProjectConsents: data.projects as PrivacyControl["meshProjectConsents"],
      });
      return json(res, 200, { projects: control.meshProjectConsents });
    });
  }
  if (req.method === "PUT" && path === "/api/mesh/sources") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      if (!data || !Array.isArray(data.sources)) {
        return json(res, 400, { error: "sources must be an array" });
      }
      const control = PrivacyControlStore.forStore(store).update({
        meshContextSourceConsents: data.sources as PrivacyControl["meshContextSourceConsents"],
      });
      return json(res, 200, { sources: control.meshContextSourceConsents });
    });
  }
  const directiveAck = /^\/api\/mesh\/directives\/([^/]+)\/ack$/.exec(path);
  if (req.method === "POST" && directiveAck?.[1]) {
    let id: string;
    try {
      id = decodeURIComponent(directiveAck[1]);
    } catch {
      return json(res, 400, { error: "invalid directive id" });
    }
    void acknowledgeSteeringDirective(store, id)
      .then((result) => json(res, 200, result))
      .catch((error) => {
        log.debug("directive ack reporting failed open", String(error));
        json(res, 200, { ok: true });
      });
    return;
  }
  if (req.method === "PUT" && path === "/api/runtime/resources") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      if (
        (data?.powerSource !== "ac" && data?.powerSource !== "battery") ||
        typeof data.suspended !== "boolean" ||
        typeof data.batteryAware !== "boolean"
      ) {
        return json(res, 400, {
          error: "powerSource ('ac'|'battery'), suspended, and batteryAware are required",
        });
      }
      const status = RuntimeStatusStore.forStore(store).updateResources({
        powerSource: data.powerSource,
        suspended: data.suspended,
        batteryAware: data.batteryAware,
      });
      publishNativeAcquisitionPolicy(store);
      return json(res, 200, captureStatus(store, status));
    });
  }
  if (req.method === "POST" && path === "/api/capture/pause") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      const minutes = data?.minutes === undefined ? 15 : Number(data.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
        return json(res, 400, { error: "minutes must be an integer from 1 to 1440" });
      }
      const control = PrivacyControlStore.forStore(store);
      const updated = control.update({
        mode: "paused",
        pausedUntil: new Date(Date.now() + minutes * 60_000).toISOString(),
      });
      publishNativeAcquisitionPolicy(store);
      return json(res, 200, updated);
    });
  }
  if (req.method === "POST" && path === "/api/capture/resume") {
    const control = PrivacyControlStore.forStore(store);
    const updated = control.update({ mode: "normal", pausedUntil: undefined });
    publishNativeAcquisitionPolicy(store);
    return json(res, 200, updated);
  }

  // --- writes: retention/quota maintenance ------------------------------
  if (req.method === "PUT" && path === "/api/storage/retention") {
    return readBody(req, res, (body) => {
      const data = safeParse(body);
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return json(res, 400, { error: "retention policy must be a JSON object" });
      }
      return json(
        res,
        200,
        RetentionPolicyStore.forStore(store).update(data as Partial<RetentionPolicy>),
      );
    });
  }
  if (req.method === "POST" && path === "/api/storage/maintenance") {
    return json(res, 200, runMaintenance(store));
  }

  // --- writes: real local forget -----------------------------------------
  if (req.method === "POST" && path === "/api/forget") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      const minutes = Number(data?.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
        return json(res, 400, { error: "minutes must be an integer from 1 to 1440" });
      }
      const result = forgetRecent(store, minutes);
      log.info(`forgot ${result.events} event(s) from the last ${minutes} minute(s)`);
      return json(res, 200, result);
    });
  }

  // --- writes: corrections (the human-in-the-loop) ---
  if (req.method === "POST" && path === "/api/correction") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      if (!data?.targetKind || !data?.targetId || !data?.verdict) {
        return json(res, 400, { error: "targetKind, targetId, verdict required" });
      }
      const targetKind = String(data.targetKind) as CorrectionTarget;
      const verdict = String(data.verdict) as CorrectionVerdict;
      if (!["action", "episode", "claim", "observation", "decision"].includes(targetKind)) {
        return json(res, 400, { error: "invalid correction targetKind" });
      }
      if (!["confirmed", "rejected", "edited"].includes(verdict)) {
        return json(res, 400, { error: "invalid correction verdict" });
      }
      const targetId = String(data.targetId);
      const note = data.note ? String(data.note) : undefined;
      const correctedText = data.correctedText ? String(data.correctedText) : undefined;
      const isWorkflowReview = note === WORKFLOW_REVIEW_NOTE;
      if (isWorkflowReview) {
        if (targetKind !== "episode") {
          return json(res, 400, { error: "workflow reviews must target an episode" });
        }
        if (verdict !== "rejected" && !parseWorkflowReview(correctedText)) {
          return json(res, 400, { error: "invalid workflow review payload" });
        }
      } else if (verdict === "edited" && !isMeaningfulCorrection(correctedText)) {
        return json(res, 400, { error: "edited corrections require replacement text" });
      }
      const correction: Correction = {
        id: newId("corr"),
        targetKind,
        targetId,
        verdict,
        origin: "human",
        correctedText,
        note,
        createdTs: nowIso(),
      };
      // A correction and its derived memory projection are one unit. This is
      // true for action/episode/observation/decision corrections too: accepting
      // a verdict while leaving contradicted claims visible breaks trust.
      store.db.exec("BEGIN IMMEDIATE");
      try {
        // Validate under the same writer lock as the receipt. Otherwise a
        // concurrent projection/forget can remove the target between a
        // successful check and this insert, leaving an orphan correction.
        if (!correctionTargetExists(store, targetKind, targetId)) {
          store.db.exec("ROLLBACK");
          return json(res, 404, {
            error: isWorkflowReview
              ? "workflow episode not found"
              : `${targetKind} correction target not found`,
          });
        }
        store.corrections.put(correction);
        buildGraph(store);
        store.db.exec("COMMIT");
      } catch (error) {
        try {
          store.db.exec("ROLLBACK");
        } catch {
          // Preserve the materialization error if SQLite already aborted.
        }
        log.error(`correction rolled back: ${String(error)}`);
        return json(res, 500, { error: "correction could not be persisted" });
      }
      log.info(`correction: ${correction.verdict} on ${correction.targetId}`);
      return json(res, 200, correction);
    });
  }

  // --- writes: answers to the agent's proactive questions ---
  if (req.method === "POST" && path === "/api/answer") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      const dismissed = data?.dismissed === true;
      if (!data?.questionId || (!dismissed && data.answer == null)) {
        return json(res, 400, { error: "questionId and answer (or dismissed) required" });
      }
      const question = data.question ? String(data.question).trim() : "";
      const correctedText = dismissed ? undefined : String(data.answer).trim();
      if (!dismissed && !isMeaningfulCorrection(correctedText)) {
        return json(res, 400, { error: "answer requires your replacement text" });
      }
      const answer: Correction = {
        id: newId("corr"),
        targetKind: "decision" as const,
        targetId: String(data.questionId),
        verdict: dismissed ? "rejected" as const : "edited" as const,
        origin: "human",
        correctedText,
        note: dismissed
          ? `${DISMISSED_QUESTION_NOTE_PREFIX}${normalizeQuestion(question)}`
          : question || undefined,
        createdTs: nowIso(),
      };
      store.db.exec("BEGIN IMMEDIATE");
      try {
        const decision = store.decisions.get(answer.targetId);
        if (
          !decision ||
          !decision.question ||
          (decision.kind !== "ask_expert" && decision.kind !== "intervene")
        ) {
          store.db.exec("ROLLBACK");
          return json(res, 404, { error: "question not found" });
        }
        store.corrections.put(answer);
        buildGraph(store);
        store.db.exec("COMMIT");
      } catch (error) {
        try {
          store.db.exec("ROLLBACK");
        } catch {
          // Preserve the materialization error if SQLite already aborted.
        }
        log.error(`answer rolled back: ${String(error)}`);
        return json(res, 500, { error: "answer could not be persisted" });
      }
      log.info(`${dismissed ? "dismissed question" : "answered question"} → ${answer.targetId}`);
      return json(res, 200, answer);
    });
  }

  json(res, 404, { error: "no such endpoint" });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function captureStatus(
  store: Store,
  supplied?: ReturnType<RuntimeStatusStore["read"]>,
): unknown {
  const runtime = supplied ?? RuntimeStatusStore.forStore(store).read();
  const privacy = PrivacyControlStore.forStore(store).read();
  const pauseActive =
    privacy.mode === "paused" &&
    (!privacy.pausedUntil || Date.parse(privacy.pausedUntil) > Date.now());
  const effectiveMode = privacy.mode === "private"
    ? "private"
    : pauseActive
      ? "paused"
      : "normal";
  const nativeActive = runtime.activeSources.some(
    (source) => source === "native" || source === "native-stdin",
  );
  const agentSessionsActive = runtime.activeSources.includes("agent_sessions");
  const sourceLastEventAt = runtime.sourceLastEventAt ?? {};
  const channelLastEventAt = runtime.channelLastEventAt ?? {};
  const contextHealth = ({
    enabled,
    producerActive,
    lastEventAt,
    readiness,
    freshnessMs,
    resourceBlockReason,
  }: {
    enabled: boolean;
    producerActive: boolean;
    lastEventAt?: string;
    readiness: NonNullable<CaptureRuntimeStatus["sourceReadiness"]>["accessibility"];
    freshnessMs: number;
    resourceBlockReason?: string;
  }) => {
    let status: "disabled" | "blocked" | "unavailable" | "unknown" | "watching" | "receiving";
    let reason: string | undefined;
    if (!enabled) {
      status = "disabled";
      reason = "privacy-source-disabled";
    } else if (readiness?.status === "disabled") {
      status = "disabled";
      reason = readiness.reason;
    } else if (effectiveMode !== "normal") {
      status = "blocked";
      reason = effectiveMode === "private" ? "private-mode" : "capture-paused";
    } else if (runtime.resources.suspended) {
      status = "blocked";
      reason = "resource-suspended";
    } else if (resourceBlockReason) {
      status = "blocked";
      reason = resourceBlockReason;
    } else if (!producerActive) {
      status = "unavailable";
      reason = "producer-not-running";
    } else if (readiness?.status === "blocked" || readiness?.status === "unavailable") {
      status = readiness.status;
      reason = readiness.reason;
    } else if (readiness?.status !== "ready") {
      status = "unknown";
      reason = "readiness-not-reported";
    } else if (
      lastEventAt &&
      Number.isFinite(Date.parse(lastEventAt)) &&
      Date.now() - Date.parse(lastEventAt) <= freshnessMs
    ) {
      status = "receiving";
    } else {
      status = "watching";
    }
    return {
      status,
      ...(reason ? { reason } : {}),
      ...(lastEventAt ? { lastEventAt } : {}),
    };
  };
  const screenResourceBlock = runtime.resources.batteryAware && runtime.resources.powerSource === "battery"
    ? "battery-aware-screen-suppression"
    : undefined;
  return {
    ...runtime,
    stale:
      runtime.state === "running" &&
      Date.now() - Date.parse(runtime.updatedAt) > 30_000,
    effectiveState: runtime.resources.suspended ? "suspended" : runtime.state,
    effectiveMode,
    health: {
      // Reaching this authenticated endpoint proves only the Studio daemon is
      // connected. Evidence-channel and interpretation readiness are separate.
      daemon: { status: "connected" },
      screenContext: contextHealth({
        enabled: privacy.sources.screen_video,
        producerActive: nativeActive,
        lastEventAt: channelLastEventAt.screen_recording ?? sourceLastEventAt.screen_video,
        readiness: runtime.sourceReadiness?.screen_recording,
        freshnessMs: 2 * 60_000,
        resourceBlockReason: screenResourceBlock,
      }),
      accessibility: contextHealth({
        enabled: privacy.sources.accessibility,
        producerActive: nativeActive,
        lastEventAt: channelLastEventAt.accessibility ?? sourceLastEventAt.accessibility,
        readiness: runtime.sourceReadiness?.accessibility,
        freshnessMs: 2 * 60_000,
      }),
      agentContext: contextHealth({
        enabled: privacy.sources.ai_proxy,
        producerActive: agentSessionsActive,
        lastEventAt: channelLastEventAt.agent_sessions ?? sourceLastEventAt.ai_proxy,
        readiness: runtime.sourceReadiness?.agent_sessions,
        freshnessMs: 5 * 60_000,
      }),
      systemAudio: contextHealth({
        enabled: privacy.sources.audio,
        producerActive: nativeActive,
        lastEventAt: channelLastEventAt.audio_system,
        readiness: runtime.sourceReadiness?.audio_system,
        freshnessMs: 2 * 60_000,
      }),
      microphoneAudio: contextHealth({
        enabled: privacy.sources.audio,
        producerActive: nativeActive,
        lastEventAt: channelLastEventAt.audio_mic,
        readiness: runtime.sourceReadiness?.audio_mic,
        freshnessMs: 2 * 60_000,
      }),
      interpretation: runtime.interpretation ?? {
        requested: "none",
        active: "none",
        status: "disabled",
      },
    },
    privacy: {
      mode: privacy.mode,
      ...(privacy.pausedUntil ? { pausedUntil: privacy.pausedUntil } : {}),
    },
  };
}

export interface ForgetResult {
  cutoff: string;
  events: number;
  actions: number;
  episodes: number;
  blobs: number;
}

/**
 * Permanently remove the requested recent capture window and its derived
 * interpretations. Candidate blobs are unlinked only when no retained event
 * references them. Claims/graph are rebuilt from the retained episodes so no
 * memory node keeps evidence that was deliberately forgotten.
 */
export function forgetRecent(
  store: Store,
  minutes: number,
  nowMs = Date.now(),
): ForgetResult {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new RangeError("minutes must be an integer from 1 to 1440");
  }
  const cutoff = new Date(nowMs - minutes * 60_000).toISOString();
  const forgottenRows = store.db
    .prepare("SELECT blob_refs FROM raw_events WHERE ts >= ?")
    .all(cutoff) as Array<{ blob_refs: string }>;
  const candidateBlobs = new Set<string>();
  for (const row of forgottenRows) {
    try {
      for (const hash of JSON.parse(row.blob_refs) as unknown[]) {
        if (typeof hash === "string") candidateBlobs.add(hash);
      }
    } catch {
      // A malformed legacy ref list must not block forgetting its event.
    }
  }

  const count = (table: string, column: string): number =>
    Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} >= ?`).get(cutoff) as { n: number }).n);
  const result: ForgetResult = {
    cutoff,
    events: count("raw_events", "ts"),
    actions: count("action_events", "end_ts"),
    episodes: count("episodes", "end_ts"),
    blobs: 0,
  };

  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare("DELETE FROM raw_events WHERE ts >= ?").run(cutoff);
    store.db.prepare("DELETE FROM action_events WHERE end_ts >= ?").run(cutoff);
    store.db.prepare("DELETE FROM episodes WHERE end_ts >= ?").run(cutoff);
    store.db.prepare("DELETE FROM observations WHERE created_ts >= ?").run(cutoff);
    store.db.prepare("DELETE FROM decisions WHERE created_ts >= ?").run(cutoff);
    store.db.prepare("DELETE FROM corrections WHERE created_ts >= ?").run(cutoff);
    // Claims and graph are derived from the retained episodes/observations.
    store.db.exec("DELETE FROM graph_edges; DELETE FROM graph_nodes; DELETE FROM claims;");
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }

  buildGraph(store);
  const retainedRefs = new Set(store.events.range().flatMap((event) => event.blobRefs));
  for (const hash of candidateBlobs) {
    if (retainedRefs.has(hash)) continue;
    const record = store.blobs.record(hash);
    if (record) {
      try {
        unlinkSync(record.path);
      } catch {
        // Missing blob bytes are already effectively forgotten.
      }
    }
    store.db.prepare("DELETE FROM blobs WHERE hash = ?").run(hash);
    result.blobs += 1;
  }
  return result;
}

/** Recurring patterns across days — for the Connections view. */
function connections(store: Store): unknown {
  const edges = store.graph.edges();
  const nodes = new Map(store.graph.nodes().map((n) => [n.id, n]));
  const reused = edges.filter((e) => e.kind === "reused_across_days");
  const byNode = new Map<string, { node: unknown; days: Set<string> }>();
  for (const e of reused) {
    const n = nodes.get(e.from);
    if (!n) continue;
    const entry = byNode.get(e.from) ?? { node: n, days: new Set<string>() };
    if (e.data?.day) entry.days.add(String(e.data.day));
    byNode.set(e.from, entry);
  }
  return [...byNode.values()].map((v) => ({
    node: v.node,
    days: [...v.days].sort(),
  }));
}

/**
 * The correction cards: every uncertain interpretation, framed as
 * "I think you did X because Y. Evidence: A, B, C. Correct?" with the raw
 * evidence resolved so the user can verify before confirming.
 */
function questions(store: Store): unknown {
  const corrections = store.corrections.all();

  // The agent's proactive questions (it said it was unsure WHY) — each with
  // candidate answers to pick from. The card also offers a free-text box.
  const agent = uniqueQuestionDecisions(
    store.decisions
      .recent(100)
      .filter(
      (d) =>
        (d.kind === "ask_expert" || d.kind === "intervene") &&
        d.question &&
        decisionHasSubstantiveEvidence(d, store.actions.byIds(d.evidence)) &&
        !questionWasResolved(d.id, d.question, corrections),
      ),
    8,
  )
    .map((d) => {
      const tracker = truncationTracker();
      const obs = d.observationId ? store.observations.get(d.observationId) : undefined;
      return {
        questionId: clippedString(d.id, 256, "question.id", tracker, "question"),
        question: clippedString(d.question, 2_000, "question.question", tracker, "What should happen next?"),
        options: clippedStrings(obs?.options ?? [], 8, 500, "question.options", tracker),
        kind: clippedString(d.kind, 160, "question.kind", tracker, "ask_expert"),
        createdTs: clippedString(d.createdTs, 64, "question.createdTs", tracker, "1970-01-01T00:00:00.000Z"),
        evidence: clippedStrings(d.evidence ?? [], 24, 256, "question.evidence", tracker)
          .map((id) => evidenceSummary(store, id)),
      };
    });

  // Per-action verification cards (uncertain reconstructions).
  const candidateCards: ActionEvent[] = [];
  // SQL-bounded newest-first scan. Stop as soon as the consumer inbox is full;
  // lifetime O(n²) semantic dedupe makes a frequently-polled endpoint degrade
  // with every day the app runs.
  for (const action of store.actions.recent(500)) {
    if (
      !isActionQuestionWorthy(action) ||
      actionQuestionWasResolved(action.id, propose(action), corrections) ||
      candidateCards.some((prior) => sameQuestion(propose(prior), propose(action)))
    ) continue;
    candidateCards.push(action);
    if (candidateCards.length >= 20) break;
  }
  const cards = candidateCards
    .map((a) => ({
      actionId: a.id.slice(0, 256),
      proposed: propose(a),
      action: a.action.slice(0, 160),
      app: a.app.slice(0, 240),
      text: a.text?.slice(0, 2_000),
      confidence: a.confidence,
      uncertainty: (a.uncertainty ?? []).slice(0, 12).map((item) => item.slice(0, 500)),
      evidence: a.evidence.slice(0, 24).map((id) => evidenceSummary(store, id.slice(0, 256))),
    }));

  return { agent, cards };
}

function propose(a: ActionEvent): string {
  const verb = a.action.startsWith("possibly_reading")
    ? "were reading"
    : a.action.replace(/_/g, " ");
  const why = a.uncertainty?.length
    ? a.uncertainty[0]
    : `${a.evidence.length} raw signal(s) corroborate it (${Math.round(a.confidence * 100)}% confidence)`;
  const what = a.text ? ` "${a.text.replace(/\s+/g, " ").slice(0, 70)}"` : "";
  return `I think you ${verb}${what} in ${a.app} because ${why}. Correct?`;
}

function evidenceSummary(store: Store, id: string): unknown {
  const ev: RawEvent | undefined = store.events.get(id);
  if (!ev) return { id: id.slice(0, 256), label: id.slice(0, 256) };
  const text =
    (ev.payload.text as string) ??
    (ev.payload.value as string) ??
    (ev.payload.cmd as string) ??
    (ev.payload.title as string) ??
    "";
  return {
    id: id.slice(0, 256),
    source: ev.source,
    type: ev.type.slice(0, 160),
    app: ev.app.slice(0, 240),
    ts: ev.ts.slice(0, 64),
    label: `${ev.source}/${ev.type}`.slice(0, 320),
    snippet: String(text).slice(0, 80),
    blobRefs: ev.blobRefs.slice(0, 32).map((hash) => hash.slice(0, 256)),
  };
}

// --------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  cb: (body: string) => void,
  maxBytes = 64 * 1024,
): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let rejected = false;
  req.on("data", (chunk: Buffer | string) => {
    if (rejected) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      rejected = true;
      res.writeHead(413, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: "request body too large" }), () => req.destroy());
      return;
    }
    chunks.push(buffer);
  });
  req.on("end", () => {
    if (!rejected) cb(Buffer.concat(chunks, bytes).toString("utf8"));
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
