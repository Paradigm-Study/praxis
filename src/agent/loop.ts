import type { Claim, Episode, Observation, RawEvent } from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import { newId as defaultNewId } from "../core/ids.ts";
import { hashObject } from "../core/hash.ts";
import { toIso, toMs } from "../core/time.ts";
import { reconstruct } from "../reconstructor/reconstructor.ts";
import { fuse } from "../fuser/fuser.ts";
import { buildGraph } from "../memory/graph.ts";
import { buildBundle } from "../observer/bundle.ts";
import { defaultObserver, type Observer } from "../observer/observer.ts";
import { buildPlaybook, critique } from "../transfer/transfer.ts";
import { decide, type Decision } from "./policy.ts";
import { retrieveLongTermContext } from "./retrieve.ts";
import { maybeDispatch } from "./dispatch.ts";
import { MeshPublisher } from "../mesh/publisher.ts";
import type { AskHandler } from "./notify.ts";
import { logger } from "../core/log.ts";

const log = logger("agent");

export interface AgentLoopOptions {
  observer?: Observer;
  newId?: (prefix: string) => string;
  learnerMode?: boolean;
  /** Idle window before a live batch is processed. Default 1500ms. */
  debounceMs?: number;
  /** How far back to reconstruct each tick. Default 30 min. */
  windowMs?: number;
  /** Minimum gap between (costly) model observations. Default 120s. */
  observeIntervalMs?: number;
  /** Don't observe an episode until it has at least this many actions. Default 4. */
  minEpisodeActions?: number;
  /** Re-observe an episode once it has grown by this many actions. Default 6. */
  growthThreshold?: number;
  /** Proactively surface the agent's questions (with options) for the user. */
  onAsk?: AskHandler;
  onDecision?: (d: Decision, ctx: TickResult) => void;
  /**
   * Mesh publisher for closed episodes (tests inject one). When omitted, one is
   * built from PRAXIS_MESH_URL/PRAXIS_MESH_TOKEN/PRAXIS_PERSON — or publishing
   * stays off entirely if those aren't set.
   */
  meshPublisher?: MeshPublisher;
}

export interface TickResult {
  observation: Observation;
  decision: Decision;
  episodes: Episode[];
  claims: Claim[];
}

/**
 * The continuous agent loop (Layer 7):
 *   reconstruct → fuse → (throttled) observe with the model → update memory
 *   graph → decide (keep observing / ask expert / intervene / summarize).
 *
 * The policy and observer are identical across roles; only the learned graph
 * differs. Model observation is throttled (per-episode + a min interval) so it
 * can run all day at bounded cost.
 */
export class AgentLoop {
  #store: Store;
  #observer: Observer;
  #newId: (prefix: string) => string;
  #learnerMode: boolean;
  #onDecision: AgentLoopOptions["onDecision"];
  #onAsk: AskHandler | undefined;
  #surfaced = new Set<string>();
  #observed = new Map<string, number>(); // episode id -> action count at last observation
  #lastObserveTs = 0;
  #debounceMs: number;
  #windowMs: number;
  #observeIntervalMs: number;
  #minEpisodeActions: number;
  #growthThreshold: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #meshPublisher: MeshPublisher | undefined;
  /** Episode ids whose final ("done") frame has been published. */
  #publishedEpisodes = new Set<string>();
  /** Episode ids announced as active while still open. */
  #announcedEpisodes = new Set<string>();

  constructor(store: Store, opts: AgentLoopOptions = {}) {
    this.#store = store;
    this.#observer = opts.observer ?? defaultObserver();
    this.#newId = opts.newId ?? defaultNewId;
    this.#learnerMode = opts.learnerMode ?? false;
    this.#onDecision = opts.onDecision;
    this.#onAsk = opts.onAsk;
    this.#debounceMs = opts.debounceMs ?? 1500;
    this.#windowMs = opts.windowMs ?? 30 * 60_000;
    this.#observeIntervalMs = opts.observeIntervalMs ?? 120_000;
    this.#minEpisodeActions = opts.minEpisodeActions ?? 4;
    this.#growthThreshold = opts.growthThreshold ?? 6;
    // Mesh publishing (default OFF): active only with an injected publisher or
    // PRAXIS_MESH_URL + PRAXIS_MESH_TOKEN + PRAXIS_PERSON in the env.
    this.#meshPublisher = opts.meshPublisher ?? MeshPublisher.fromEnv(store);
  }

  /**
   * Publish episode workframes: every newly-closed episode (all but the
   * still-open last one) as "done", then the open episode as "active" (once
   * per episode id). Publishing done-before-active keeps the materializer's
   * latest-frame-per-(person, project) state pointing at the live work; the
   * publisher serializes the underlying POSTs, preserving this order.
   */
  #publishClosedEpisodes(episodes: Episode[]): void {
    const publisher = this.#meshPublisher;
    if (!publisher) return;
    for (const ep of episodes.slice(0, -1)) {
      if (this.#publishedEpisodes.has(ep.id)) continue;
      this.#publishedEpisodes.add(ep.id);
      // Fire-and-forget, fail open: a down relay must never break the loop.
      void publisher
        .onEpisodeClosed(ep)
        .catch((err) => log.warn("mesh publish failed", String(err)));
    }
    const open = episodes[episodes.length - 1];
    if (open && !this.#announcedEpisodes.has(open.id)) {
      this.#announcedEpisodes.add(open.id);
      void publisher
        .onEpisodeActive(open)
        .catch((err) => log.warn("mesh publish failed", String(err)));
    }
  }

  /** Should we spend a model observation on this episode right now? */
  #shouldObserve(ep: Episode, nowMs: number): boolean {
    if (ep.actions.length < this.#minEpisodeActions) return false;
    // Never observe an episode that ended outside the loop's window: after a
    // daemon restart the "latest" episode can be arbitrarily old, and acting
    // on it would e.g. dispatch an investigation for a months-old error.
    if (nowMs - toMs(ep.endTs) > this.#windowMs) return false;
    if (nowMs - this.#lastObserveTs < this.#observeIntervalMs) return false;
    const seen = this.#observed.get(ep.id);
    if (seen === undefined) return true; // never observed
    return ep.actions.length - seen >= this.#growthThreshold; // grew enough
  }

  /**
   * One cycle. Always refreshes the action/episode timeline (cheap); only spends
   * a model observation + decision when the throttle allows. Returns undefined
   * on the cheap path.
   */
  async tick(): Promise<TickResult | undefined> {
    const sinceMs = Date.now() - this.#windowMs;
    reconstruct(this.#store, { newId: this.#newId, range: { startTs: toIso(sinceMs) } });
    const episodes = fuse(this.#store, { newId: this.#newId });
    this.#publishClosedEpisodes(episodes);

    const latest = episodes[episodes.length - 1];
    if (!latest || !this.#shouldObserve(latest, Date.now())) return undefined;
    this.#lastObserveTs = Date.now();
    this.#observed.set(latest.id, latest.actions.length);

    // Observe the (capped) recent slice of this episode.
    const seconds = Math.min(
      300,
      Math.ceil((toMs(latest.endTs) - toMs(latest.startTs)) / 1000) + 1,
    );
    const bundle = buildBundle(this.#store, {
      endTs: latest.endTs,
      windowSeconds: seconds,
      includeImages: this.#observer.wantsImages,
      newId: this.#newId,
    });
    const observation = await this.#observer.observe(bundle, {
      episodeId: latest.id,
      newId: this.#newId,
    });
    this.#store.observations.put(observation);

    // Rebuild the graph AFTER storing the observation so its model-derived
    // claims (decisions / preferences / know-how) are folded in.
    const { claims } = buildGraph(this.#store, { newId: this.#newId });

    const advisories = this.#learnerMode
      ? critique(buildPlaybook(this.#store), this.#store.actions.byIds(latest.actions))
      : [];

    // Retrieve durable knowledge relevant to THIS observation before deciding,
    // so the policy can ground in what's already known and avoid re-asking it.
    const longTermContext = retrieveLongTermContext(this.#store, observation);

    const decision = decide({
      observation,
      actions: this.#store.actions.byIds(latest.actions),
      claims,
      surfacedClaims: this.#surfaced,
      learnerMode: this.#learnerMode,
      advisories,
      longTermContext,
    });
    if (decision.kind === "summarize_pattern" && decision.claim) {
      this.#surfaced.add(decision.claim.id);
    }

    if (decision.kind !== "keep_observing") {
      const stableId = `decision_${hashObject({
        k: decision.kind,
        q: decision.question ?? decision.reason,
        ev: [...(decision.evidence ?? [])].sort(),
      }).slice(0, 16)}`;
      this.#store.decisions.put({
        id: stableId,
        kind: decision.kind,
        reason: decision.reason,
        question: decision.question,
        evidence: decision.evidence ?? [],
        observationId: observation.id,
        claimId: decision.claim?.id,
        createdTs: observation.createdTs,
      });

      // Proactively speak up only when genuinely unsure — with candidate answers
      // to pick from (plus a free-text box, rendered by the menu-bar app). Skip
      // anything the user already answered (a correction on this question id).
      const alreadyAnswered = this.#store.corrections.byTarget(stableId).length > 0;
      if (
        (decision.kind === "ask_expert" || decision.kind === "intervene") &&
        decision.question &&
        !alreadyAnswered
      ) {
        this.#onAsk?.({
          id: stableId,
          question: decision.question,
          options: observation.options ?? [],
        });
      }

      // A dispatch decision executes through maybeDispatch — the same
      // persist-then-execute flow as ask_expert. Dry-run by default; only
      // PRAXIS_DISPATCH_SPAWN=1 permits a real spawn (see agent/dispatch.ts).
      if (decision.kind === "dispatch") {
        try {
          await maybeDispatch({
            store: this.#store,
            decision,
            observation,
            episode: latest,
            decisionId: stableId,
            newId: this.#newId,
          });
        } catch (err) {
          log.warn("dispatch failed", String(err));
        }
      }
    }

    const result: TickResult = { observation, decision, episodes, claims };
    log.info(`decision: ${decision.kind} — ${decision.reason}`);
    this.#onDecision?.(decision, result);
    return result;
  }

  /**
   * Live mode: debounced tick on each event batch (the model call inside is
   * separately throttled). Returns an unsubscribe function.
   */
  attach(stream: { subscribe: (fn: (e: RawEvent) => void) => () => void }): () => void {
    const unsub = stream.subscribe(() => {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = setTimeout(() => {
        void this.tick().catch((err) => log.warn("tick failed", String(err)));
      }, this.#debounceMs);
    });
    return () => {
      if (this.#timer) clearTimeout(this.#timer);
      unsub();
    };
  }
}
