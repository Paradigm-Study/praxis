import type {
  ActionEvent,
  Claim,
  Episode,
  GraphEdge,
  GraphNode,
} from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import { newId as defaultNewId } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import { clamp01 } from "../reconstructor/confidence.ts";
import { episodeClaims, type ClaimCandidate } from "./claims.ts";
import { observationClaims } from "./modelClaims.ts";

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
  confidence: number;
  episodeIds: string[];
  days: Set<string>;
}

function noisyOr(ps: number[]): number {
  return clamp01(1 - ps.reduce((acc, p) => acc * (1 - p), 1));
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
  const newId = opts.newId ?? defaultNewId;
  const now = opts.now ?? nowIso();
  const episodes = store.episodes.all();

  // Gather per-episode facts and claim candidates.
  const facts = new Map<string, EpisodeFacts>();
  const candidates: ClaimCandidate[] = [];
  for (const ep of episodes) {
    const actions = store.actions.byIds(ep.actions);
    facts.set(ep.id, episodeFacts(actions));
    candidates.push(...episodeClaims(ep, actions));
  }

  // Model-derived claims: the role-agnostic path. Whatever the observer
  // understood (decisions, preferences, know-how) for any domain becomes a
  // claim, merged + confidence-raised across episodes alongside the templates.
  for (const obs of store.observations.all()) {
    if (obs.model === "mock" || !obs.episodeId) continue;
    candidates.push(...observationClaims(obs, obs.episodeId));
  }

  // Merge candidates by (kind, text).
  const merged = new Map<string, MergedClaim>();
  for (const c of candidates) {
    const key = `${c.kind}::${c.text}`;
    const m = merged.get(key);
    if (m) {
      if (!m.episodeIds.includes(c.episodeId)) m.episodeIds.push(c.episodeId);
      m.days.add(c.day);
      m.confidence = noisyOr([m.confidence, c.confidence]);
    } else {
      merged.set(key, {
        kind: c.kind,
        text: c.text,
        confidence: c.confidence,
        episodeIds: [c.episodeId],
        days: new Set([c.day]),
      });
    }
  }

  const claims: Claim[] = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeByKey = new Map<string, GraphNode>();

  const addEdge = (from: string, to: string, kind: string, data?: Record<string, unknown>) => {
    if (store.graph.hasEdge(from, to, kind)) return;
    if (edges.some((e) => e.from === from && e.to === to && e.kind === kind)) return;
    edges.push({ id: newId("edge"), from, to, kind, data, createdTs: now });
  };

  for (const m of merged.values()) {
    // Claim (reuse existing id when the text already exists).
    const existingClaim = store.claims.findByText(m.kind, m.text);
    const claim: Claim = {
      id: existingClaim?.id ?? newId("claim"),
      kind: m.kind,
      text: m.text,
      confidence: round2(m.confidence),
      evidenceEpisodes: m.episodeIds,
      createdTs: existingClaim?.createdTs ?? now,
      updatedTs: now,
    };
    claims.push(claim);

    // Node (one per claim).
    const existingNode = store.graph.findNode(m.kind, m.text);
    const node: GraphNode = {
      id: existingNode?.id ?? newId("node"),
      kind: m.kind,
      label: m.text,
      confidence: claim.confidence,
      claimId: claim.id,
      data: { days: [...m.days].sort(), episodes: m.episodeIds.length },
      createdTs: existingNode?.createdTs ?? now,
      updatedTs: now,
    };
    nodes.push(node);
    nodeByKey.set(`${m.kind}::${m.text}`, node);

    // Edges from this claim node to its evidence episodes.
    const multiDay = m.days.size >= 2;
    const sortedDays = [...m.days].sort();
    for (const epId of m.episodeIds) {
      addEdge(node.id, epId, "observed_in_episode");
      const f = facts.get(epId);
      if (!f) continue;
      if ((m.kind === "workflow_pattern" || m.kind === "know_how") && f.hadEdit) {
        addEdge(node.id, epId, "caused_file_change", { files: f.files });
      }
      if (m.kind === "know_how" && f.hadFail) {
        addEdge(node.id, epId, "followed_failed_test");
      }
      if ((m.kind === "know_how" || m.kind === "workflow_pattern") && f.hadPass) {
        addEdge(node.id, epId, "followed_passed_test");
      }
      if (m.kind === "teaching_move" && f.hadTeach) {
        addEdge(node.id, epId, "taught_to_learner");
      }
      if (multiDay) {
        const epDay = episodes.find((e) => e.id === epId)?.startTs.slice(0, 10);
        if (epDay && epDay !== sortedDays[0]) {
          addEdge(node.id, epId, "reused_across_days", { day: epDay });
        }
      }
    }
  }

  // contradicted_by_correction: a correction contradicts the decision rule's
  // rejected approach (they co-occur in the same episode).
  for (const corr of nodes.filter((n) => n.kind === "correction")) {
    for (const dr of nodes.filter((n) => n.kind === "decision_rule")) {
      const corrClaim = claims.find((c) => c.id === corr.claimId);
      const drClaim = claims.find((c) => c.id === dr.claimId);
      const shareEpisode = corrClaim?.evidenceEpisodes.some((e) =>
        drClaim?.evidenceEpisodes.includes(e),
      );
      if (shareEpisode) addEdge(corr.id, dr.id, "contradicted_by_correction");
    }
  }

  if (opts.persist !== false) {
    for (const c of claims) store.claims.put(c);
    for (const n of nodes) store.graph.putNode(n);
    for (const e of edges) store.graph.putEdge(e);
  }

  return { claims, nodes, edges };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
