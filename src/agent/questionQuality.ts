import type { ActionEvent, Correction, Observation, StoredDecision } from "../core/types.ts";
import { explicitDirectiveConflict } from "../core/textOpposition.ts";
import { isHumanCorrection } from "../memory/consolidate.ts";

export const DISMISSED_QUESTION_NOTE_PREFIX = "question-dismissed:";

/** Actions that describe ambient computer state rather than a consequential choice. */
const AMBIENT_ACTIONS = new Set([
  "switched_app",
  "opened_file",
  "typed_draft",
  "listened_audio",
]);

/** Actions whose meaning can justify asking the user a focused clarification. */
const SUBSTANTIVE_ACTIONS = new Set([
  "submitted_message",
  "answered_question",
  "corrected_agent",
  "accepted_suggestion",
  "rejected_suggestion",
  "committed",
  "ran_command",
  "inspected_failure",
  "edited_file",
  "saved_file",
  "retried",
  "attended_meeting",
  "taught_learner",
]);

const CORRECTION_PLACEHOLDERS = new Set([
  "close but not quite",
  "no correct it",
  "no ill correct it",
  "no i ll correct it",
  "no i will correct it",
  "no i was doing something else",
]);

/** Stable text normalization for question identity, deduplication, and dismissal. */
export function normalizeQuestion(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function terms(value: string): Set<string> {
  return new Set(
    normalizeQuestion(value)
      .split(" ")
      .filter(
        (term) =>
          term.length > 2 &&
          ![
            "the",
            "and",
            "that",
            "this",
            "because",
            "correct",
            "right",
            "think",
            "you",
            "did",
            "was",
            "were",
          ].includes(term),
      ),
  );
}

function orderedTerms(value: string): string[] {
  const allowed = terms(value);
  return normalizeQuestion(value)
    .split(" ")
    .filter((term) => allowed.has(term));
}

function orderedOverlap(left: string[], right: string[]): number {
  const rows = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      rows[i]![j] = left[i - 1] === right[j - 1]
        ? rows[i - 1]![j - 1]! + 1
        : Math.max(rows[i - 1]![j]!, rows[i]![j - 1]!);
    }
  }
  return rows[left.length]![right.length]! / Math.max(left.length, right.length);
}

/** Conservative near-duplicate test; distinct short questions never collapse. */
export function sameQuestion(left: string, right: string): boolean {
  const a = normalizeQuestion(left);
  const b = normalizeQuestion(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (explicitDirectiveConflict(left, right)) return false;
  const at = terms(a);
  const bt = terms(b);
  if (at.size < 4 || bt.size < 4) {
    // Short questions are too easy to over-merge by fuzzy overlap, but UI
    // framing such as "I think … Correct?" should not defeat a dismissal.
    // Require the complete meaningful term set to match in that case.
    return (
      at.size >= 2 &&
      at.size === bt.size &&
      [...at].every((term) => bt.has(term))
    );
  }
  let overlap = 0;
  for (const term of at) if (bt.has(term)) overlap += 1;
  if (overlap / Math.max(at.size, bt.size) < 0.7) return false;
  // Preserve direction and sequence. Bag-of-words alone would collapse
  // opposite questions such as "Postgres instead of SQLite" and the reverse.
  return orderedOverlap(orderedTerms(a), orderedTerms(b)) >= 0.7;
}

function structuredError(action: ActionEvent): boolean {
  if (action.action !== "encountered_error" || action.confidence < 0.65) return false;
  const kinds = action.payload?.signalKinds;
  if (!Array.isArray(kinds)) return false;
  const structured = new Set(
    kinds.filter((kind): kind is string => typeof kind === "string"),
  );
  return structured.has("terminal_error") || structured.has("agent_tool_error");
}

/** Whether an action contains enough grounded meaning to spend human attention on. */
export function substantiveAction(action: ActionEvent): boolean {
  if (AMBIENT_ACTIONS.has(action.action)) return false;
  if (action.action === "encountered_error") return structuredError(action);
  if (action.action === "spoke_aloud") return false;
  return SUBSTANTIVE_ACTIONS.has(action.action) && action.confidence >= 0.65;
}

/** Persisted decisions must retain real consequential action evidence. */
export function decisionHasSubstantiveEvidence(
  decision: StoredDecision,
  actions: ActionEvent[],
): boolean {
  const evidence = new Set(decision.evidence);
  return actions.some((action) => evidence.has(action.id) && substantiveAction(action));
}

/**
 * A question is eligible only when a semantic observer produced it and its
 * evidence includes consequential activity. Offline reconstruction can report
 * facts, but it must not manufacture questions about weak OCR or ambient state.
 */
export function isQuestionWorthy(observation: Observation, actions: ActionEvent[]): boolean {
  const question = observation.suggestedQuestion?.trim();
  if (!question || question.length < 12 || question.length > 500) return false;
  if (observation.model === "mock" || observation.uncertainty.length === 0) return false;

  const evidence = new Set(observation.evidence);
  const cited = actions.filter((action) => evidence.has(action.id));
  return cited.some(substantiveAction);
}

/** Raw action-verification cards are an expert review tool, not a noise inbox. */
export function isActionQuestionWorthy(action: ActionEvent): boolean {
  if (!substantiveAction(action)) return false;
  if (!action.uncertainty?.length) return false;
  const text = action.text?.replace(/\s+/g, " ").trim();
  return Boolean(text && text.length >= 8);
}

/** Reject UI labels masquerading as user-authored correction text. */
export function isMeaningfulCorrection(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = normalizeQuestion(value);
  return normalized.length >= 3 && !CORRECTION_PLACEHOLDERS.has(normalized);
}

/** Newest-first semantic dedupe for persisted agent questions. */
export function uniqueQuestionDecisions(decisions: StoredDecision[], limit: number): StoredDecision[] {
  const out: StoredDecision[] = [];
  for (const decision of decisions) {
    if (!decision.question || out.some((prior) => sameQuestion(prior.question!, decision.question!))) continue;
    out.push(decision);
    if (out.length >= limit) break;
  }
  return out;
}

/** Exact-id and semantic resolution, shared by the Studio and injected brief. */
export function questionWasResolved(
  questionId: string,
  question: string,
  corrections: Correction[],
): boolean {
  return corrections.some((correction) => {
    if (!isHumanCorrection(correction)) return false;
    if (correction.targetKind !== "decision") return false;
    if (correction.targetId === questionId) return true;
    if (!correction.note) return false;
    if (correction.note.startsWith(DISMISSED_QUESTION_NOTE_PREFIX)) {
      return sameQuestion(
        question,
        correction.note.slice(DISMISSED_QUESTION_NOTE_PREFIX.length),
      );
    }
    return sameQuestion(question, correction.note);
  });
}

/** Action review cards can be re-keyed when evidence windows change. */
export function actionQuestionWasResolved(
  actionId: string,
  proposed: string,
  corrections: Correction[],
): boolean {
  return corrections.some((correction) => {
    if (!isHumanCorrection(correction)) return false;
    if (correction.targetKind !== "action") return false;
    if (correction.targetId === actionId) return true;
    if (!correction.note?.startsWith(DISMISSED_QUESTION_NOTE_PREFIX)) return false;
    return sameQuestion(
      proposed,
      correction.note.slice(DISMISSED_QUESTION_NOTE_PREFIX.length),
    );
  });
}
