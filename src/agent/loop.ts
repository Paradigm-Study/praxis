import type { Claim, Episode, Observation, RawEvent } from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import { newId as defaultNewId } from "../core/ids.ts";
import { hashObject } from "../core/hash.ts";
import { toIso, toMs } from "../core/time.ts";
import { reconstruct } from "../reconstructor/reconstructor.ts";
import { fuse } from "../fuser/fuser.ts";
import { buildGraph } from "../memory/graph.ts";
import { buildBundle } from "../observer/bundle.ts";
import {
  defaultObserver,
  RemoteObserverConsentError,
  type Observer,
} from "../observer/observer.ts";
import { buildPlaybook, critique } from "../transfer/transfer.ts";
import { decide, type Decision } from "./policy.ts";
import { retrieveLongTermContext } from "./retrieve.ts";
import { maybeDispatch } from "./dispatch.ts";
import { MeshPublisher } from "../mesh/publisher.ts";
import type { AskHandler } from "./notify.ts";
import { logger } from "../core/log.ts";
import { RuntimeStatusStore } from "../capture/runtimeStatus.ts";
import { normalizeQuestion, questionWasResolved } from "./questionQuality.ts";
import { PrivacyControlStore } from "../privacy/control.ts";
import { isHumanCorrection } from "../memory/consolidate.ts";

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
  /** Initial delay after an attached/background tick fails. Default 5s. */
  failureRetryBaseMs?: number;
  /** Maximum delay between attached/background failure retries. Default 5 min. */
  failureRetryMaxMs?: number;
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
  #failureRetryBaseMs: number;
  #failureRetryMaxMs: number;
  #automaticFailureCount = 0;
  #retryNotBeforeMs = 0;
  #historyReconciled = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #attached = false;
  #inFlight: Promise<TickResult | undefined> | undefined;
  #rerunRequested = false;
  #meshPublisher: MeshPublisher | undefined;
  /** Episode ids whose final ("done") frame has been published. */
  #publishedEpisodes = new Set<string>();
  /** Episode ids announced as active while still open. */
  #announcedEpisodes = new Set<string>();
  #runtime: RuntimeStatusStore;
  #privacy: PrivacyControlStore;

  constructor(store: Store, opts: AgentLoopOptions = {}) {
    this.#store = store;
    this.#runtime = RuntimeStatusStore.forStore(store);
    this.#privacy = PrivacyControlStore.forStore(store);
    this.#observer = opts.observer ?? defaultObserver(store);
    this.#newId = opts.newId ?? defaultNewId;
    this.#learnerMode = opts.learnerMode ?? false;
    this.#onDecision = opts.onDecision;
    this.#onAsk = opts.onAsk;
    this.#debounceMs = opts.debounceMs ?? 1500;
    this.#windowMs = opts.windowMs ?? 30 * 60_000;
    this.#observeIntervalMs = opts.observeIntervalMs ?? 120_000;
    this.#minEpisodeActions = opts.minEpisodeActions ?? 4;
    this.#growthThreshold = opts.growthThreshold ?? 6;
    this.#failureRetryBaseMs = Math.max(1, opts.failureRetryBaseMs ?? 5_000);
    this.#failureRetryMaxMs = Math.max(
      this.#failureRetryBaseMs,
      opts.failureRetryMaxMs ?? 5 * 60_000,
    );
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

  /** Whether to observe now, or when a final throttled observation becomes eligible. */
  #observationEligibility(
    ep: Episode,
    nowMs: number,
  ): { eligible: boolean; retryInMs?: number } {
    if (ep.actions.length < this.#minEpisodeActions) return { eligible: false };
    // Never observe an episode that ended outside the loop's window: after a
    // daemon restart the "latest" episode can be arbitrarily old, and acting
    // on it would e.g. dispatch an investigation for a months-old error.
    if (nowMs - toMs(ep.endTs) > this.#windowMs) return { eligible: false };
    const seen = this.#observed.get(ep.id);
    const needsObservation = seen === undefined || ep.actions.length - seen >= this.#growthThreshold;
    if (!needsObservation) return { eligible: false };
    const retryInMs = this.#observeIntervalMs - (nowMs - this.#lastObserveTs);
    return retryInMs > 0
      ? { eligible: false, retryInMs }
      : { eligible: true };
  }

  #scheduleTick(delayMs: number): void {
    if (!this.#attached) return;
    if (this.#timer) clearTimeout(this.#timer);
    const nowMs = Date.now();
    const backoffRemainingMs = Math.max(0, this.#retryNotBeforeMs - nowMs);
    const effectiveDelayMs = Math.max(0, delayMs, backoffRemainingMs);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.tick().catch((error) => {
        const exponent = Math.min(30, this.#automaticFailureCount);
        const retryMs = Math.min(
          this.#failureRetryMaxMs,
          this.#failureRetryBaseMs * 2 ** exponent,
        );
        this.#automaticFailureCount += 1;
        this.#retryNotBeforeMs = Date.now() + retryMs;
        log.warn(`tick failed; retrying in ${retryMs}ms`, String(error));
        this.#scheduleTick(retryMs);
      });
    }, effectiveDelayMs);
    this.#timer.unref?.();
  }

  #clearFailureBackoff(): void {
    this.#automaticFailureCount = 0;
    this.#retryNotBeforeMs = 0;
  }

  /**
   * One cycle. Always refreshes the action/episode timeline (cheap); only spends
   * a model observation + decision when the throttle allows. Returns undefined
   * on the cheap path.
   */
  tick(): Promise<TickResult | undefined> {
    if (this.#inFlight) {
      this.#rerunRequested = true;
      return this.#inFlight;
    }
    const run = (async () => {
      let result: TickResult | undefined;
      do {
        this.#rerunRequested = false;
        const next = await this.#tickOnce();
        if (next !== undefined) result = next;
      } while (this.#rerunRequested);
      // Any fully successful drain is a recovery, even when reconstruction
      // makes the paid observer unnecessary (for example, the failed episode
      // was corrected away). Do not carry a stale max-delay gate into later
      // unrelated activity. A rejected drain skips this reset.
      this.#clearFailureBackoff();
      return result;
    })();
    this.#inFlight = run;
    void run.finally(() => {
      if (this.#inFlight === run) this.#inFlight = undefined;
    }).catch(() => {
      // The caller observes the original rejection; avoid an unhandled
      // rejection from this bookkeeping-only finally chain.
    });
    return run;
  }

  async #tickOnce(): Promise<TickResult | undefined> {
    const sinceMs = Date.now() - this.#windowMs;
    // The first tick after startup repairs historical materializations under
    // the current rules. Later ticks replace only the rolling window, keeping
    // steady-state work bounded while still retracting evolving interpretations.
    const repairingHistory = !this.#historyReconciled;
    const range = repairingHistory ? undefined : { startTs: toIso(sinceMs) };
    reconstruct(this.#store, { newId: this.#newId, range, reconcile: true });
    const episodes = fuse(this.#store, { newId: this.#newId });
    this.#publishClosedEpisodes(episodes);
    // Deterministic episode claims and retractions must never wait for a paid
    // observer call. Rebuild after every successful reconcile/fuse, including
    // cheap/throttled/resource-blocked ticks and final activity bursts.
    buildGraph(this.#store, { newId: this.#newId });
    if (repairingHistory) this.#historyReconciled = true;

    const latest = episodes[episodes.length - 1];
    if (!latest) return undefined;
    const eligibility = this.#observationEligibility(latest, Date.now());
    if (!eligibility.eligible) {
      if (eligibility.retryInMs !== undefined) this.#scheduleTick(eligibility.retryInMs);
      return undefined;
    }
    const resources = this.#runtime.read().resources;
    if (
      this.#observer.remote &&
      (resources.suspended || (resources.batteryAware && resources.powerSource === "battery"))
    ) {
      return undefined;
    }
    const privacy = this.#privacy.read();
    if (this.#observer.remote && !privacy.cloudObserverConsent) {
      this.#recordCloudConsentBlocked();
      return undefined;
    }
    // Observe the (capped) recent slice of this episode.
    const seconds = Math.min(
      300,
      Math.ceil((toMs(latest.endTs) - toMs(latest.startTs)) / 1000) + 1,
    );
    const bundle = buildBundle(this.#store, {
      endTs: latest.endTs,
      windowSeconds: seconds,
      includeImages:
        this.#observer.wantsImages === true &&
        (!this.#observer.remote || privacy.screenshotConsent),
      newId: this.#newId,
    });
    // Privacy is cross-process and can change while the synchronous bundle is
    // assembled. Re-read immediately before the provider call; if screenshot
    // consent was withdrawn, discard already-loaded image bytes as well.
    if (this.#observer.remote) {
      const currentPrivacy = this.#privacy.read();
      if (!currentPrivacy.cloudObserverConsent) {
        this.#recordCloudConsentBlocked();
        return undefined;
      }
      if (!currentPrivacy.screenshotConsent && bundle.frameImages) {
        bundle.frameImages = undefined;
      }
    }
    let observation: Observation;
    try {
      observation = await this.#observer.observe(bundle, {
        episodeId: latest.id,
        newId: this.#newId,
      });
    } catch (error) {
      if (error instanceof RemoteObserverConsentError) {
        this.#recordCloudConsentBlocked();
        return undefined;
      }
      const interpretation = this.#runtime.read().interpretation;
      if (this.#observer.remote && interpretation) {
        this.#runtime.write({
          interpretation: {
            ...interpretation,
            active: "none",
            status: "failed",
            reason: "runtime-error",
            lastError: String(error).slice(0, 300),
          },
        });
      }
      throw error;
    }
    let claims: Claim[];
    try {
      // Persisting an interpretation and materializing its memory projection
      // are one unit. A projection failure rolls the observation back, leaves
      // the growth/throttle slot untouched, and is retryable on the same
      // episode without requiring unrelated activity.
      this.#store.db.exec("BEGIN IMMEDIATE");
      this.#store.observations.put(observation);
      ({ claims } = buildGraph(this.#store, { newId: this.#newId }));
      this.#store.db.exec("COMMIT");
    } catch (error) {
      try {
        this.#store.db.exec("ROLLBACK");
      } catch {
        // Preserve the projection error if SQLite already aborted the scope.
      }
      const interpretation = this.#runtime.read().interpretation;
      if (this.#observer.remote && interpretation) {
        this.#runtime.write({
          interpretation: {
            ...interpretation,
            active: "none",
            status: "failed",
            reason: "runtime-error",
            lastError: String(error).slice(0, 300),
          },
        });
      }
      throw error;
    }
    const interpretation = this.#runtime.read().interpretation;
    if (this.#observer.remote && interpretation) {
      this.#runtime.write({
        interpretation: {
          ...interpretation,
          active: "model",
          status: "ready",
          model: this.#observer.model,
          reason: undefined,
          lastSuccessAt: observation.createdTs,
          lastError: undefined,
        },
      });
    }
    // Only a successfully persisted and projected observation consumes the
    // throttle/growth slot.
    this.#lastObserveTs = Date.now();
    this.#observed.set(latest.id, latest.actions.length);

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
      const semanticIdentity =
        decision.kind === "ask_expert" || decision.kind === "intervene"
          ? normalizeQuestion(decision.question ?? decision.reason)
          : decision.kind === "dispatch"
            ? {
                task: normalizeQuestion(decision.task ?? decision.reason),
                trigger: decision.evidence?.[0],
              }
            : decision.claim?.id ?? normalizeQuestion(decision.reason);
      const stableId = `decision_${hashObject({
        kind: decision.kind,
        identity: semanticIdentity,
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
      const corrections = this.#store.corrections.all();
      const alreadyAnswered = decision.question
        ? questionWasResolved(stableId, decision.question, corrections)
        : corrections.some(
            (correction) =>
              isHumanCorrection(correction) && correction.targetId === stableId,
          );
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

  #recordCloudConsentBlocked(): void {
    const current = this.#runtime.read().interpretation;
    this.#runtime.write({
      interpretation: {
        requested: current?.requested ?? "anthropic",
        active: "none",
        status: "fallback",
        model: current?.model ?? this.#observer.model,
        reason: "cloud-consent-disabled",
        lastSuccessAt: current?.lastSuccessAt,
        lastError: undefined,
      },
    });
  }

  /**
   * Live mode: debounced tick on each event batch (the model call inside is
   * separately throttled). Returns an unsubscribe function.
   */
  attach(stream: { subscribe: (fn: (e: RawEvent) => void) => () => void }): () => void {
    this.#attached = true;
    const schedule = () => this.#scheduleTick(this.#debounceMs);
    const unsub = stream.subscribe(schedule);
    // Repair historical projections even when the machine is idle or every
    // live source is permission-blocked. Waiting for a new event can otherwise
    // leave stale actions and claims visible indefinitely after an upgrade.
    schedule();
    return () => {
      this.#attached = false;
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#clearFailureBackoff();
      unsub();
    };
  }
}
