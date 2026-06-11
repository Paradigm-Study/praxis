import type { Observation } from "../core/types.ts";
import type { ClaimCandidate } from "./claims.ts";

/**
 * Turn a model observation into evidence-backed claim candidates. This is the
 * ROLE-AGNOSTIC path: the LLM interprets whatever the user is doing (coding,
 * sales, HR, research…) and we record the decisions / preferences / know-how it
 * extracted, with the episode as evidence. Merged + confidence-raised across
 * episodes by the graph builder, so recurring patterns harden into a model of
 * how this specific person works.
 */
export function observationClaims(
  obs: Observation,
  episodeId: string,
): ClaimCandidate[] {
  const day = obs.createdTs.slice(0, 10);
  const out: ClaimCandidate[] = [];
  const mk = (kind: ClaimCandidate["kind"], text: string, confidence: number) =>
    out.push({ kind, text: text.replace(/\s+/g, " ").trim(), confidence, episodeId, day });

  if (obs.decisionPoint) mk("decision_rule", obs.decisionPoint, 0.82);
  if (obs.inferredPreference) mk("taste_rule", obs.inferredPreference, 0.8);
  for (const a of obs.acceptedOptions) if (a.trim()) mk("know_how", `Prefers: ${a}`, 0.75);
  for (const r of obs.rejectedOptions) if (r.trim()) mk("decision_rule", `Avoids: ${r}`, 0.75);
  if (obs.suggestedQuestion && obs.uncertainty.length) {
    mk("unresolved_question", obs.suggestedQuestion, 0.5);
  }
  return out;
}
