import type {
  ActionEvent,
  Claim,
  Correction,
  Episode,
  GraphEdge,
  GraphNode,
  ClaimProvenance,
} from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import { newId as defaultNewId } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import { clamp01 } from "../reconstructor/confidence.ts";
import { episodeClaims, type ClaimCandidate } from "./claims.ts";
import { observationClaims } from "./modelClaims.ts";
import {
  applyCorrections,
  claimTextSimilarity,
  isHumanCorrection,
} from "./consolidate.ts";
import {
  resolveWorkflowReviewCorrection,
  WORKFLOW_REVIEW_NOTE,
} from "../workflow/review.ts";
import { DISMISSED_QUESTION_NOTE_PREFIX } from "../agent/questionQuality.ts";
import { substantiveAction } from "../agent/questionQuality.ts";

export interface BuildGraphOptions {
  newId?: (prefix: string) => string;
  persist?: boolean;
  now?: string;
}

export interface GraphResult {
  claims: Claim[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface EpisodeFacts {
  hadFail: boolean;
  hadPass: boolean;
  hadEdit: boolean;
  hadTeach: boolean;
  files: string[];
}

interface MergedClaim {
  kind: string;
  text: string;
  canonicalConfidence: number;
  variants: Set<string>;
  confidence: number;
  episodeIds: string[];
  episodeIdSet: Set<string>;
  days: Set<string>;
  provenance?: ClaimProvenance;
}

const PROVENANCE_PRIORITY: Record<ClaimProvenance, number> = {
  human_reviewed: 5,
  explicit_user_rule: 4,
  user_answer: 3,
  observed_pattern: 2,
  model_inference: 1,
};

function strongerProvenance(
  current: ClaimProvenance | undefined,
  candidate: ClaimProvenance | undefined,
): ClaimProvenance | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  return PROVENANCE_PRIORITY[candidate] > PROVENANCE_PRIORITY[current]
    ? candidate
    : current;
}

function noisyOr(ps: number[]): number {
  return clamp01(1 - ps.reduce((acc, p) => acc * (1 - p), 1));
}

function latestCorrections(corrections: Correction[]): Map<string, Correction> {
  const latest = new Map<string, Correction>();
  for (const correction of corrections) latest.set(correction.targetId, correction);
  return latest;
}

function episodeFacts(actions: ActionEvent[]): EpisodeFacts {
  const files = new Set<string>();
  let hadFail = false;
  let hadPass = false;
  let hadEdit = false;
  let hadTeach = false;
  for (const a of actions) {
    if (a.action === "edited_file" || a.action === "saved_file") {
      hadEdit = true;
      if (typeof a.payload?.path === "string") files.add(a.payload.path);
    }
    if (a.action === "committed" && Array.isArray(a.payload?.files)) {
      for (const f of a.payload.files) if (typeof f === "string") files.add(f);
    }
    if (a.action === "ran_command" || a.action === "inspected_failure") {
      if ((a.payload?.exitCode ?? 0) !== 0 || a.action === "inspected_failure")
        hadFail = true;
      if ((a.payload?.exitCode ?? 1) === 0) hadPass = true;
    }
    if (a.action === "taught_learner") hadTeach = true;
  }
  return { hadFail, hadPass, hadEdit, hadTeach, files: [...files] };
}

/**
 * Build (or refresh) the expert memory graph from episodes.
 *
 * Claims are merged across episodes: identical (kind, text) claims pool their
 * evidence episodes and their confidence rises via noisy-OR. Each merged claim
 * becomes a node; typed edges connect it to the episodes that evidence it,
 * caused file changes, followed failing/passing tests, or recur across days.
 */
export function buildGraph(store: Store, opts: BuildGraphOptions = {}): GraphResult {
  if (opts.persist === false) return projectGraph(store, opts);

  // The projection is shared by the capture agent and Studio, which are
  // separate processes in the packaged app. Acquire the SQLite writer lock
  // before reading any source rows so a correction cannot race a stale agent
  // rebuild. A savepoint keeps this composable with Studio's correction +
  // projection transaction while still making every standalone rebuild atomic.
  const nested = store.db.isTransaction;
  store.db.exec(nested ? "SAVEPOINT praxis_graph_projection" : "BEGIN IMMEDIATE");
  try {
    const result = projectGraph(store, opts);
    store.db.exec(nested ? "RELEASE SAVEPOINT praxis_graph_projection" : "COMMIT");
    return result;
  } catch (error) {
    try {
      if (nested) {
        store.db.exec(
          "ROLLBACK TO SAVEPOINT praxis_graph_projection; RELEASE SAVEPOINT praxis_graph_projection",
        );
      } else {
        store.db.exec("ROLLBACK");
      }
    } catch {
      // Preserve the projection failure if SQLite already aborted the scope.
    }
    throw error;
  }
}

function projectGraph(store: Store, opts: BuildGraphOptions): GraphResult {
  const newId = opts.newId ?? defaultNewId;
  const now = opts.now ?? nowIso();
  const episodes = store.episodes.all();
  // Agent-reported and pre-origin legacy receipts remain auditable but can
  // never rewrite, confirm, reject, or suppress the derived human memory graph.
  const corrections = store.corrections.all().filter(isHumanCorrection);
  const latest = latestCorrections(corrections);
  const latestGenericEpisode = latestCorrections(
    corrections.filter(
      (correction) =>
        correction.targetKind === "episode" &&
        correction.note !== WORKFLOW_REVIEW_NOTE,
    ),
  );
  const latestWorkflowEpisode = latestCorrections(
    corrections.filter(
      (correction) =>
        correction.targetKind === "episode" &&
        correction.note === WORKFLOW_REVIEW_NOTE,
    ),
  );
  const rejectedEpisodes = new Set(
    [...latestGenericEpisode.values()]
      .filter((correction) => correction.verdict === "rejected")
      .map((correction) => correction.targetId),
  );
  const activeEpisodes = episodes.filter((episode) => !rejectedEpisodes.has(episode.id));
  const activeEpisodeIds = new Set(activeEpisodes.map((episode) => episode.id));
  const activeEpisodeDay = new Map(
    activeEpisodes.map((episode) => [episode.id, episode.startTs.slice(0, 10)]),
  );

  // Gather per-episode facts and claim candidates.
  const facts = new Map<string, EpisodeFacts>();
  const substantiveEvidenceByEpisode = new Map<string, Set<string>>();
  const candidates: ClaimCandidate[] = [];
  for (const ep of activeEpisodes) {
    const actions = store.actions.byIds(ep.actions).flatMap((action) => {
      const correction = latest.get(action.id);
      if (correction?.targetKind !== "action") {
        return action.confidence >= 0.65 && !action.uncertainty?.length ? [action] : [];
      }
      if (correction.note?.startsWith(DISMISSED_QUESTION_NOTE_PREFIX)) {
        // Dismissing the review card says "don't ask me again", not "this
        // action is false". Keep the evidence semantics independent.
        return action.confidence >= 0.65 && !action.uncertainty?.length ? [action] : [];
      }
      if (correction.verdict === "rejected") return [];
      if (correction.verdict === "edited" && correction.correctedText) {
        // Text alone cannot safely change the action kind. Remove the original
        // interpretation from inference. The correction remains an auditable
        // receipt, but episodic replacement text is not a global memory rule.
        return [];
      }
      if (correction.verdict === "confirmed") {
        return [{ ...action, confidence: Math.max(action.confidence, 0.95), uncertainty: undefined }];
      }
      return action.confidence >= 0.65 && !action.uncertainty?.length ? [action] : [];
    });
    facts.set(ep.id, episodeFacts(actions));
    substantiveEvidenceByEpisode.set(
      ep.id,
      new Set(actions.filter(substantiveAction).map((action) => action.id)),
    );
    const episodeCorrection = latestGenericEpisode.get(ep.id);
    const inferred = episodeCorrection?.verdict === "edited"
      ? []
      : episodeClaims(ep, actions);
    const reviewed = resolveWorkflowReviewCorrection(
      ep,
      latestWorkflowEpisode.get(ep.id),
    );
    candidates.push(...(reviewed.reviewed
      ? inferred.filter((candidate) => candidate.kind !== "workflow_pattern")
      : inferred));
    if (reviewed.candidate) candidates.push(reviewed.candidate);
  }

  const decisionByObservation = new Map(
    store.decisions.all()
      .filter((decision) => decision.observationId)
      .map((decision) => [decision.observationId!, decision]),
  );
  const observationsByEpisode = new Map<string, ReturnType<typeof store.observations.all>>();
  for (const observation of store.observations.all()) {
    if (
      observation.model === "mock" ||
      !observation.episodeId ||
      !activeEpisodeIds.has(observation.episodeId)
    ) continue;
    const group = observationsByEpisode.get(observation.episodeId) ?? [];
    group.push(observation);
    observationsByEpisode.set(observation.episodeId, group);
  }

  // Only the latest model observation for a growing episode may contribute
  // inferred claims. A human-authored answer from any earlier observation wins
  // over later re-observation and suppresses speculative memory.
  for (const [episodeId, observations] of observationsByEpisode) {
    const authored: Array<{
      kind: "observation_edit" | "decision_answer";
      ts: string;
      text?: string;
      question?: string;
    }> = [];
    for (const observation of observations) {
      const observationCorrection = latest.get(observation.id);
      if (
        observationCorrection?.targetKind === "observation" &&
        observationCorrection.verdict === "edited" &&
        observationCorrection.correctedText?.trim()
      ) {
        authored.push({
          kind: "observation_edit",
          ts: observationCorrection.createdTs,
        });
        continue;
      }
      const decision = decisionByObservation.get(observation.id);
      const answer = decision ? latest.get(decision.id) : undefined;
      if (
        answer?.targetKind === "decision" &&
        answer.verdict === "edited" &&
        answer.correctedText?.trim()
      ) {
        authored.push({
          kind: "decision_answer",
          ts: answer.createdTs,
          text: answer.correctedText,
          question: decision?.question ?? observation.suggestedQuestion,
        });
      }
    }
    const latestAuthored = authored.sort((left, right) =>
      left.ts.localeCompare(right.ts),
    ).at(-1);
    if (latestAuthored) {
      if (
        latestAuthored.kind === "decision_answer" &&
        latestAuthored.text?.trim() &&
        latestAuthored.question?.trim()
      ) {
        candidates.push({
          kind: "decision_heuristic",
          text: `Answer to “${latestAuthored.question.replace(/\s+/g, " ").trim()}”: ${latestAuthored.text.replace(/\s+/g, " ").trim()}`.slice(0, 1_500),
          confidence: 0.98,
          episodeId,
          day: activeEpisodeDay.get(episodeId)!,
          provenance: "user_answer",
        });
      }
      // Authored text wins over the speculative model fields. Contextual
      // question answers remain provisional until repeated or claim-reviewed;
      // generic observation edits stay only in correction receipts.
      continue;
    }

    const obs = observations.at(-1)!;
    const substantiveEvidence = substantiveEvidenceByEpisode.get(episodeId) ?? new Set<string>();
    if (!obs.evidence.some((evidenceId) => substantiveEvidence.has(evidenceId))) continue;
    const observationCorrection = latest.get(obs.id);
    if (observationCorrection?.targetKind === "observation") {
      if (observationCorrection.verdict === "rejected") continue;
      if (observationCorrection.verdict === "edited") continue;
      // confirmed falls through to the original model-derived fields.
    } else if (obs.uncertainty.length > 0) {
      const decision = decisionByObservation.get(obs.id);
      const answer = decision ? latest.get(decision.id) : undefined;
      if (answer?.targetKind !== "decision" || answer.verdict === "rejected") continue;
      if (answer.verdict === "edited") continue;
      // A confirmed decision answer explicitly admits the proposal below.
    }
    candidates.push(...observationClaims(obs, episodeId));
  }

  // Merge candidates by (kind, text).
  const merged: MergedClaim[] = [];
  const mergedByKind = new Map<string, MergedClaim[]>();
  for (const c of candidates) {
    const sameKind = mergedByKind.get(c.kind) ?? [];
    const m = sameKind
      .map((entry) => ({ entry, similarity: claimTextSimilarity(entry.text, c.text) }))
      .filter(({ similarity }) => similarity >= 0.6)
      .sort((left, right) => right.similarity - left.similarity)[0]?.entry;
    if (m) {
      const independentEpisode = !m.episodeIdSet.has(c.episodeId);
      if (independentEpisode) {
        m.episodeIdSet.add(c.episodeId);
        m.episodeIds.push(c.episodeId);
      }
      m.days.add(c.day);
      m.variants.add(c.text);
      m.provenance = strongerProvenance(m.provenance, c.provenance);
      m.confidence = independentEpisode
        ? noisyOr([m.confidence, c.confidence])
        : Math.max(m.confidence, c.confidence);
      if (c.confidence > m.canonicalConfidence) {
        m.text = c.text;
        m.canonicalConfidence = c.confidence;
      }
    } else {
      const created: MergedClaim = {
        kind: c.kind,
        text: c.text,
        canonicalConfidence: c.confidence,
        variants: new Set([c.text]),
        confidence: c.confidence,
        episodeIds: [c.episodeId],
        episodeIdSet: new Set([c.episodeId]),
        days: new Set([c.day]),
        provenance: c.provenance,
      };
      merged.push(created);
      sameKind.push(created);
      mergedByKind.set(c.kind, sameKind);
    }
  }

  const rawClaims: Claim[] = [];
  const claimContext = new Map<string, MergedClaim>();
  const existingClaims = store.claims.all();
  const existingClaimsByKind = new Map<string, Claim[]>();
  for (const claim of existingClaims) {
    const sameKind = existingClaimsByKind.get(claim.kind) ?? [];
    sameKind.push(claim);
    existingClaimsByKind.set(claim.kind, sameKind);
  }
  const reusedClaimIds = new Set<string>();
  for (const m of merged) {
    const existingClaim = (existingClaimsByKind.get(m.kind) ?? [])
      .filter((claim) =>
        !reusedClaimIds.has(claim.id) &&
        (claim.text === m.text || claimTextSimilarity(claim.text, m.text) >= 0.6),
      )
      .sort((left, right) =>
        Number(right.text === m.text) - Number(left.text === m.text) ||
        right.evidenceEpisodes.length - left.evidenceEpisodes.length ||
        left.createdTs.localeCompare(right.createdTs),
      )[0];
    if (existingClaim) reusedClaimIds.add(existingClaim.id);
    const claim: Claim = {
      id: existingClaim?.id ?? newId("claim"),
      kind: m.kind,
      text: m.text,
      confidence: round2(m.confidence),
      evidenceEpisodes: m.episodeIds,
      provenance: m.provenance,
      createdTs: existingClaim?.createdTs ?? now,
      updatedTs: now,
    };
    rawClaims.push(claim);
    claimContext.set(claim.id, m);
  }
  // Claim corrections are an override over the raw evidence projection. Keep
  // raw rows stable so a rejected/edited target id remains meaningful across
  // every rebuild; only corrected claims receive graph nodes and edges.
  const claims = applyCorrections(
    rawClaims,
    corrections.filter((correction) => correction.targetKind === "claim"),
  );
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const storedNodes = store.graph.nodes();
  const storedNodeByClaim = new Map(
    storedNodes
      .filter((node) => node.claimId)
      .map((node) => [node.claimId!, node]),
  );
  const nodeLabelKey = (kind: string, label: string) => JSON.stringify([kind, label]);
  const storedNodeByLabel = new Map<string, GraphNode>();
  for (const node of storedNodes) {
    const key = nodeLabelKey(node.kind, node.label);
    if (!storedNodeByLabel.has(key)) storedNodeByLabel.set(key, node);
  }
  const edgeKey = (from: string, to: string, kind: string) =>
    JSON.stringify([from, to, kind]);
  const storedEdgeByKey = new Map<string, GraphEdge>();
  for (const edge of store.graph.edges()) {
    const key = edgeKey(edge.from, edge.to, edge.kind);
    if (!storedEdgeByKey.has(key)) storedEdgeByKey.set(key, edge);
  }
  const projectedEdgeKeys = new Set<string>();
  const addEdge = (from: string, to: string, kind: string, data?: Record<string, unknown>) => {
    const key = edgeKey(from, to, kind);
    if (projectedEdgeKeys.has(key)) return;
    projectedEdgeKeys.add(key);
    const existing = storedEdgeByKey.get(key);
    edges.push({
      id: existing?.id ?? newId("edge"),
      from,
      to,
      kind,
      data,
      createdTs: existing?.createdTs ?? now,
    });
  };

  for (const claim of claims) {
    const m = claimContext.get(claim.id)!;
    // Node (one per claim).
    const existingNode = storedNodeByClaim.get(claim.id)
      ?? storedNodeByLabel.get(nodeLabelKey(claim.kind, claim.text));
    const node: GraphNode = {
      id: existingNode?.id ?? newId("node"),
      kind: claim.kind,
      label: claim.text,
      confidence: claim.confidence,
      claimId: claim.id,
      data: {
        days: [...m.days].sort(),
        episodes: m.episodeIds.length,
        variants: [...m.variants].filter((variant) => variant !== claim.text),
      },
      createdTs: existingNode?.createdTs ?? now,
      updatedTs: now,
    };
    nodes.push(node);

    // Edges from this claim node to its evidence episodes.
    const multiDay = m.days.size >= 2;
    const sortedDays = [...m.days].sort();
    for (const epId of m.episodeIds) {
      addEdge(node.id, epId, "observed_in_episode");
      const f = facts.get(epId);
      if (!f) continue;
      if ((claim.kind === "workflow_pattern" || claim.kind === "know_how") && f.hadEdit) {
        addEdge(node.id, epId, "caused_file_change", { files: f.files });
      }
      if (claim.kind === "know_how" && f.hadFail) {
        addEdge(node.id, epId, "followed_failed_test");
      }
      if ((claim.kind === "know_how" || claim.kind === "workflow_pattern") && f.hadPass) {
        addEdge(node.id, epId, "followed_passed_test");
      }
      if (claim.kind === "teaching_move" && f.hadTeach) {
        addEdge(node.id, epId, "taught_to_learner");
      }
      if (multiDay) {
        const epDay = activeEpisodeDay.get(epId);
        if (epDay && epDay !== sortedDays[0]) {
          addEdge(node.id, epId, "reused_across_days", { day: epDay });
        }
      }
    }
  }

  // contradicted_by_correction: a correction contradicts the decision rule's
  // rejected approach (they co-occur in the same episode).
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const decisionNodesByEpisode = new Map<string, GraphNode[]>();
  for (const decisionNode of nodes.filter((node) => node.kind === "decision_rule")) {
    const claim = claimById.get(decisionNode.claimId ?? "");
    for (const episodeId of claim?.evidenceEpisodes ?? []) {
      const episodeNodes = decisionNodesByEpisode.get(episodeId) ?? [];
      episodeNodes.push(decisionNode);
      decisionNodesByEpisode.set(episodeId, episodeNodes);
    }
  }
  for (const correctionNode of nodes.filter((node) => node.kind === "correction")) {
    const correctionClaim = claimById.get(correctionNode.claimId ?? "");
    const contradicted = new Set<string>();
    for (const episodeId of correctionClaim?.evidenceEpisodes ?? []) {
      for (const decisionNode of decisionNodesByEpisode.get(episodeId) ?? []) {
        if (contradicted.has(decisionNode.id)) continue;
        contradicted.add(decisionNode.id);
        addEdge(
          correctionNode.id,
          decisionNode.id,
          "contradicted_by_correction",
        );
      }
    }
  }

  if (opts.persist !== false) {
    // Claims/nodes/edges are one materialized projection of the active
    // episodes. Reconcile EVERY derived kind: retaining obsolete unresolved or
    // artifact claims is what previously let noise accumulate indefinitely.
    const activeRawClaimIds = new Set(rawClaims.map((claim) => claim.id));
    const activeNodeIds = new Set(nodes.map((node) => node.id));
    for (const stale of existingClaims) {
      if (activeRawClaimIds.has(stale.id)) continue;
      store.graph.removeClaimNode(stale.id);
      store.claims.remove(stale.id);
    }
    for (const stale of storedNodes) {
      if (!activeNodeIds.has(stale.id)) store.graph.removeNode(stale.id);
    }
    store.graph.clearEdges();
    for (const c of rawClaims) store.claims.put(c);
    for (const n of nodes) store.graph.putNode(n);
    for (const e of edges) store.graph.putEdge(e);
  }

  return { claims, nodes, edges };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
