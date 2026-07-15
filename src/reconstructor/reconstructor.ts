import type { ActionEvent, RawEvent } from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import type { EventRange } from "../storage/eventStore.ts";
import { newId as defaultNewId } from "../core/ids.ts";
import { toMs } from "../core/time.ts";
import { coalesceEditActions } from "./coalesce.ts";
import { buildContext } from "./evidence.ts";
import type { Rule } from "./rule.ts";
import { navigationRules } from "./rules/navigation.ts";
import { conversationRules } from "./rules/conversation.ts";
import { fileRules } from "./rules/files.ts";
import { terminalRules } from "./rules/terminal.ts";
import { inputRules } from "./rules/input.ts";
import { audioRules } from "./rules/audio.ts";
import { agentRules } from "./rules/agent.ts";
import { errorRules } from "./rules/errors.ts";

/** The full deterministic rule set, in display order. */
export const ALL_RULES: Rule[] = [
  ...navigationRules,
  ...conversationRules,
  ...fileRules,
  ...terminalRules,
  ...inputRules,
  ...audioRules,
  ...agentRules,
  ...errorRules,
];

export interface ReconstructOptions {
  rules?: Rule[];
  newId?: (prefix: string) => string;
  blob?: (hash: string) => string | undefined;
}

/** Pure reconstruction over an event list — no storage involved. */
export function reconstructEvents(
  events: RawEvent[],
  opts: ReconstructOptions = {},
): ActionEvent[] {
  const rules = opts.rules ?? ALL_RULES;
  const ctx = buildContext(events, opts.newId ?? defaultNewId, opts.blob);
  const candidates: ActionEvent[] = [];
  for (const rule of rules) {
    for (const action of rule(ctx)) candidates.push(action);
  }
  const actions = coalesceEditActions(candidates);
  actions.sort(
    (a, b) =>
      toMs(a.startTs) - toMs(b.startTs) ||
      toMs(a.endTs) - toMs(b.endTs) ||
      a.action.localeCompare(b.action),
  );
  return actions;
}

export interface ReconstructFromStore extends ReconstructOptions {
  range?: EventRange;
  persist?: boolean;
  /**
   * Replace stale actions in the reconstructed time range. Defaults on only
   * for the complete rule/source set; filtered/limited reads are not a complete
   * projection and therefore cannot safely reconcile.
   */
  reconcile?: boolean;
}

/**
 * Longest backward/forward correlation currently used by a deterministic rule:
 * terminal retries and conversation activity both look across ten minutes.
 * Rolling reconstruction includes this pre/post-roll so a cutoff cannot turn
 * one meeting into `listened_audio` + `spoke_aloud`, lose a retry's first run,
 * or orphan a conversational response/correction.
 */
export const RECONSTRUCTION_CORRELATION_HORIZON_MS = 10 * 60_000;

function expandedReconciliationRange(
  range: EventRange | undefined,
): EventRange | undefined {
  if (!range) return undefined;
  return {
    ...range,
    ...(range.startTs
      ? {
          startTs: new Date(
            toMs(range.startTs) - RECONSTRUCTION_CORRELATION_HORIZON_MS,
          ).toISOString(),
        }
      : {}),
    ...(range.endTs
      ? {
          endTs: new Date(
            toMs(range.endTs) + RECONSTRUCTION_CORRELATION_HORIZON_MS,
          ).toISOString(),
        }
      : {}),
  };
}

/**
 * A materialized action can be much longer than any rule's correlation
 * lookback (for example, a continuous multi-hour call). If that action crosses
 * a rolling reconciliation boundary, reading only the fixed pre-roll rebuilds
 * it from a later segment, changing both its content-addressed id and the id of
 * the episode anchored to it.
 *
 * Expand the raw read to the complete persisted intervals that intersect the
 * bounded reconciliation window. The deletion scope remains bounded to the
 * fixed correlation window: earlier point actions brought into the read are
 * context, not candidates for destructive reconciliation.
 */
function rawRangeCoveringMaterializedActions(
  store: Store,
  reconciliationRange: EventRange | undefined,
): EventRange | undefined {
  if (!reconciliationRange) return undefined;
  if (!reconciliationRange.startTs && !reconciliationRange.endTs) {
    return reconciliationRange;
  }

  const overlapping = store.actions.overlapping({
    startTs: reconciliationRange.startTs,
    endTs: reconciliationRange.endTs,
  });
  if (overlapping.length === 0) return reconciliationRange;

  let startMs = reconciliationRange.startTs
    ? toMs(reconciliationRange.startTs)
    : undefined;
  let endMs = reconciliationRange.endTs
    ? toMs(reconciliationRange.endTs)
    : undefined;
  for (const action of overlapping) {
    if (startMs !== undefined) startMs = Math.min(startMs, toMs(action.startTs));
    if (endMs !== undefined) {
      // Raw-event ranges are half-open, while an action's endTs names its last
      // included event. Advance one millisecond so the endpoint is retained.
      endMs = Math.max(endMs, toMs(action.endTs) + 1);
    }
  }

  return {
    ...reconciliationRange,
    ...(startMs !== undefined ? { startTs: new Date(startMs).toISOString() } : {}),
    ...(endMs !== undefined ? { endTs: new Date(endMs).toISOString() } : {}),
  };
}

function overlapsRange(action: ActionEvent, range: EventRange | undefined): boolean {
  if (!range) return true;
  if (range.startTs && toMs(action.endTs) < toMs(range.startTs)) return false;
  if (range.endTs && toMs(action.startTs) >= toMs(range.endTs)) return false;
  return true;
}

/**
 * Read raw events from the ledger, reconstruct actions, and (by default) write
 * them back. The blob reader is wired so rules can resolve text that the capture
 * pipeline offloaded to the blob store.
 */
export function reconstruct(
  store: Store,
  opts: ReconstructFromStore = {},
): ActionEvent[] {
  const completeProjection =
    opts.rules === undefined &&
    !opts.range?.sources?.length &&
    !opts.range?.apps?.length &&
    opts.range?.limit === undefined;
  const reconcile = opts.persist !== false && (opts.reconcile ?? completeProjection);
  if (reconcile && !completeProjection) {
    throw new Error(
      "cannot reconcile actions from a filtered, limited, or partial-rule reconstruction",
    );
  }

  // An event just inside the requested window can invalidate a prior action
  // just outside it (e.g. mic speech changes recent system-only playback into
  // one meeting), so the correlation-expanded range is the deletion scope.
  // The raw read can extend farther to preserve an already-materialized action
  // that crosses that scope, without destructively reconciling older context.
  const reconciliationRange = reconcile
    ? expandedReconciliationRange(opts.range)
    : opts.range;
  const materializationRange = reconcile
    ? rawRangeCoveringMaterializedActions(store, reconciliationRange)
    : reconciliationRange;
  const events = store.events.range(materializationRange);
  const materializedActions = reconstructEvents(events, {
    rules: opts.rules,
    newId: opts.newId,
    blob: opts.blob ?? ((h) => store.blobs.getText(h)),
  });
  if (opts.persist !== false) {
    if (reconcile) {
      store.actions.reconcileRange(
        materializedActions.filter((action) => overlapsRange(action, reconciliationRange)),
        {
          startTs: reconciliationRange?.startTs,
          endTs: reconciliationRange?.endTs,
        },
      );
    } else {
      store.actions.putMany(materializedActions);
    }
  }
  // Preserve the caller's requested view even though persistence uses a
  // correlation pre/post-roll for correctness.
  return materializedActions.filter((action) => overlapsRange(action, opts.range));
}
