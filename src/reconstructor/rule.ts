import type { ActionEvent, ActionType } from "../core/types.ts";
import type { RuleContext } from "./evidence.ts";
import type { Scored } from "./confidence.ts";
import { hashObject } from "../core/hash.ts";

/** A deterministic reconstruction rule: events in, candidate actions out. */
export type Rule = (ctx: RuleContext) => ActionEvent[];

export interface ActionDraft {
  action: ActionType | (string & {});
  app: string;
  window?: string;
  startTs: string;
  endTs: string;
  text?: string;
  scored: Scored;
  uncertainty?: string[];
  payload?: Record<string, unknown>;
  reconstructedBy: string;
}

/**
 * Build a stored-ready ActionEvent from a rule's scored candidate.
 *
 * The id is CONTENT-ADDRESSED (a hash of action + app + window + evidence), so
 * reconstructing the same evidence always yields the same id. This makes the
 * reconstructor idempotent — the live loop can re-run over a window every tick
 * and the rows REPLACE in place instead of piling up. (Earlier this used a
 * random id per call, which duplicated all of history every tick.)
 */
export function mkAction(ctx: RuleContext, d: ActionDraft): ActionEvent {
  // Keyed on the *anchor* evidence (the triggering event), not the full
  // evidence set or endTs — so the id stays stable even as corroborating
  // signals accrue near the live edge, avoiding orphaned rows.
  const stableId = `action_${hashObject({
    a: d.action,
    app: d.app,
    s: d.startTs,
    anchor: d.scored.evidence[0] ?? "",
  }).slice(0, 16)}`;
  return {
    id: stableId,
    type: "user_action",
    action: d.action,
    app: d.app,
    window: d.window,
    startTs: d.startTs,
    endTs: d.endTs,
    text: d.text,
    confidence: d.scored.confidence,
    evidence: d.scored.evidence,
    uncertainty: d.uncertainty && d.uncertainty.length ? d.uncertainty : undefined,
    payload: d.payload,
    reconstructedBy: [d.reconstructedBy],
  };
}
