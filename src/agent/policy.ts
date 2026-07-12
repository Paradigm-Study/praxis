import type { ActionEvent, Claim, Observation } from "../core/types.ts";
import { termCoverage } from "./retrieve.ts";
import { toMs } from "../core/time.ts";
import { redactText } from "../mesh/redact.ts";

export type DecisionKind =
  | "keep_observing"
  | "ask_expert"
  | "intervene"
  | "summarize_pattern"
  | "mark_uncertainty"
  | "dispatch";

export interface Decision {
  kind: DecisionKind;
  reason: string;
  /** For ask_expert: the question to surface (doc's centerpiece). */
  question?: string;
  /** For dispatch: the redacted task text to hand to a spawned agent. */
  task?: string;
  /** Evidence ids backing the decision. */
  evidence?: string[];
  /** For summarize_pattern: the claim being surfaced. */
  claim?: Claim;
  /** For intervene: advisories from the learned playbook. */
  advisories?: string[];
  /**
   * Relevant long-term knowledge that informed this decision (claim texts). Lets
   * the agent ground its reasoning in what's already known — and explains why an
   * already-established question was NOT re-asked.
   */
  grounding?: string[];
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
  /**
   * Long-term knowledge relevant to the CURRENT situation, retrieved before the
   * policy runs (see {@link retrieveLongTermContext}). Bounded to what bears on
   * the present observation — not the whole memory graph. The policy uses it to
   * avoid re-asking established things and to ground its reasoning.
   */
  longTermContext?: Claim[];
}

/** Minimum confidence for a long-term claim to count as "established". */
const ESTABLISHED_CONFIDENCE = 0.8;
/**
 * Min fraction of the QUESTION's terms a claim must cover to count as answering
 * it. Directional (not a symmetric overlap), so a short claim that merely shares
 * one generic word with the question does not suppress it.
 */
const ESTABLISHED_COVERAGE = 0.5;
/**
 * Only claim kinds that represent settled, answer-bearing knowledge can establish
 * an answer. Notably excludes `unresolved_question` (the opposite of settled) and
 * descriptive kinds like `artifact_type` / `teaching_move`.
 */
const ANSWER_BEARING_KINDS = new Set<string>([
  "decision_rule",
  "decision_heuristic",
  "correction",
  "taste_rule",
  "know_how",
  "workflow_pattern",
]);

/**
 * Confidence floor for an `encountered_error` action to warrant dispatching an
 * investigation agent — matches MIN_ERROR_CONFIDENCE in agent/dispatch.ts, the
 * module that executes the decision (and re-checks the floor itself).
 */
const DISPATCH_ERROR_CONFIDENCE = 0.6;
/**
 * Only a FRESH error justifies a dispatch decision; measured against the newest
 * action in the same window (not wall clock) so the policy stays deterministic.
 * Once the error ages out, the branch stops shadowing lower-priority decisions.
 */
const DISPATCH_ERROR_FRESH_MS = 10 * 60_000;

/**
 * The newest high-confidence, still-fresh `encountered_error` action in the
 * observed window, if any (see src/reconstructor/rules/errors.ts for how these
 * are reconstructed).
 */
function freshError(actions: ActionEvent[]): ActionEvent | undefined {
  let newestTs = -Infinity;
  for (const a of actions) newestTs = Math.max(newestTs, toMs(a.startTs));
  return actions
    .filter(
      (a) =>
        a.action === "encountered_error" &&
        a.confidence >= DISPATCH_ERROR_CONFIDENCE &&
        newestTs - toMs(a.startTs) <= DISPATCH_ERROR_FRESH_MS,
    )
    .sort((a, b) => toMs(b.startTs) - toMs(a.startTs))[0];
}

/**
 * The agent's decision policy. Deliberately general: the SAME policy runs for an
 * OpenClaw maintainer, an influencer, a designer, or a founder — only the
 * learned graph differs. It chooses among observing, asking, intervening,
 * summarizing a pattern, or flagging uncertainty.
 */
export function decide(input: PolicyInput): Decision {
  const { observation: obs } = input;
  const longTerm = input.longTermContext ?? [];
  const base = {
    observationId: obs.id,
    evidence: obs.evidence,
    ...(longTerm.length ? { grounding: longTerm.map((c) => c.text) } : {}),
  };

  // Before asking or flagging anything, consult long-term memory: is the thing
  // we're unsure about already established by durable, high-confidence knowledge?
  // If so, we shouldn't re-ask it — we already know the answer.
  const established =
    obs.suggestedQuestion && obs.uncertainty.length > 0
      ? longTerm.find(
          (c) =>
            c.confidence >= ESTABLISHED_CONFIDENCE &&
            ANSWER_BEARING_KINDS.has(c.kind) &&
            termCoverage(obs.suggestedQuestion!, c.text) >= ESTABLISHED_COVERAGE,
        )
      : undefined;

  // 1. In learner mode, a violation of the learned playbook => intervene.
  if (input.learnerMode && input.advisories && input.advisories.length > 0) {
    return {
      ...base,
      kind: "intervene",
      reason: "Learner action diverges from the expert's learned workflow.",
      advisories: input.advisories,
    };
  }

  // 2. A pressing uncertainty about a low-confidence action => ask the expert —
  //    UNLESS long-term memory has already established the answer.
  if (obs.uncertainty.length > 0 && obs.suggestedQuestion && !established) {
    return {
      ...base,
      kind: "ask_expert",
      reason: "An action is uncertain; verify with the expert before trusting it.",
      question: obs.suggestedQuestion,
    };
  }

  // 3. A fresh, high-confidence reconstructed error => dispatch an
  //    investigation agent. Deliberately BELOW ask_expert: when the human is
  //    already being engaged with a pressing question, don't also spin up an
  //    agent (the same philosophy as dispatch's stand-down guard). Advisory
  //    and cheap to repeat — agent/dispatch.ts enforces dedup, a daily budget,
  //    and stand-down, and dry-runs unless PRAXIS_DISPATCH_SPAWN=1.
  const errorAction = freshError(input.actions);
  if (errorAction) {
    const errorText =
      typeof errorAction.payload?.errorText === "string"
        ? errorAction.payload.errorText
        : errorAction.text;
    return {
      ...base,
      kind: "dispatch",
      reason: "A high-confidence error was reconstructed; dispatch an investigation.",
      task: redactText(errorText ?? "", { maxChars: 500 }),
      // The trigger action id FIRST so dispatch resolves it precisely.
      evidence: [errorAction.id, ...obs.evidence],
    };
  }

  // 4. A confident, reused pattern not yet surfaced => summarize it.
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

  // 5. Lingering uncertainty with no question => just flag it (unless long-term
  //    memory already resolved it).
  if (obs.uncertainty.length > 0 && !established) {
    return {
      ...base,
      kind: "mark_uncertainty",
      reason: obs.uncertainty[0]!,
    };
  }

  const reason = established
    ? `Already established in long-term memory — ${established.text} No need to ask.`
    : "Nothing actionable yet.";
  return { ...base, kind: "keep_observing", reason };
}
