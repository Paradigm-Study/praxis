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
    out.push({
      kind,
      text: text.replace(/\s+/g, " ").trim(),
      confidence,
      episodeId,
      day,
      provenance: "model_inference",
    });

  if (obs.decisionPoint) mk("decision_rule", obs.decisionPoint, 0.82);
  if (obs.inferredPreference) mk("taste_rule", obs.inferredPreference, 0.8);
  // acceptedOptions/rejectedOptions describe one explicit choice in this
  // episode. Keep them in the observation/episode receipt; only the dedicated
  // durable fields above are eligible for long-term memory claims.
  return out;
}
