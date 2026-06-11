import type { ActionEvent, Claim, Observation } from "../core/types.ts";

export type DecisionKind =
  | "keep_observing"
  | "ask_expert"
  | "intervene"
  | "summarize_pattern"
  | "mark_uncertainty";

export interface Decision {
  kind: DecisionKind;
  reason: string;
  /** For ask_expert: the question to surface (doc's centerpiece). */
  question?: string;
  /** Evidence ids backing the decision. */
  evidence?: string[];
  /** For summarize_pattern: the claim being surfaced. */
  claim?: Claim;
  /** For intervene: advisories from the learned playbook. */
  advisories?: string[];
  observationId: string;
}

export interface PolicyInput {
  observation: Observation;
  actions: ActionEvent[];
  claims: Claim[];
  /** Already-surfaced claim ids, so patterns aren't announced twice. */
  surfacedClaims?: Set<string>;
  /** Operating mode — the policy is role-agnostic; only behavior differs. */
  learnerMode?: boolean;
  advisories?: string[];
}

/**
 * The agent's decision policy. Deliberately general: the SAME policy runs for an
 * OpenClaw maintainer, an influencer, a designer, or a founder — only the
 * learned graph differs. It chooses among observing, asking, intervening,
 * summarizing a pattern, or flagging uncertainty.
 */
export function decide(input: PolicyInput): Decision {
  const { observation: obs } = input;
  const base = { observationId: obs.id, evidence: obs.evidence };

  // 1. In learner mode, a violation of the learned playbook => intervene.
  if (input.learnerMode && input.advisories && input.advisories.length > 0) {
    return {
      ...base,
      kind: "intervene",
      reason: "Learner action diverges from the expert's learned workflow.",
      advisories: input.advisories,
    };
  }

  // 2. A pressing uncertainty about a low-confidence action => ask the expert.
  if (obs.uncertainty.length > 0 && obs.suggestedQuestion) {
    return {
      ...base,
      kind: "ask_expert",
      reason: "An action is uncertain; verify with the expert before trusting it.",
      question: obs.suggestedQuestion,
    };
  }

  // 3. A confident, reused pattern not yet surfaced => summarize it.
  const pattern = input.claims
    .filter(
      (c) =>
        (c.kind === "workflow_pattern" || c.kind === "decision_rule") &&
        c.confidence >= 0.85 &&
        c.evidenceEpisodes.length >= 2 &&
        !input.surfacedClaims?.has(c.id),
    )
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (pattern) {
    return {
      ...base,
      kind: "summarize_pattern",
      reason: "A high-confidence pattern has recurred across episodes.",
      claim: pattern,
    };
  }

  // 4. Lingering uncertainty with no question => just flag it.
  if (obs.uncertainty.length > 0) {
    return {
      ...base,
      kind: "mark_uncertainty",
      reason: obs.uncertainty[0]!,
    };
  }

  return { ...base, kind: "keep_observing", reason: "Nothing actionable yet." };
}
