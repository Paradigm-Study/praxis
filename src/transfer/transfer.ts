import type { ActionEvent, Claim } from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import { nowIso } from "../core/time.ts";
import { applyCorrections } from "../memory/consolidate.ts";
import { latestAcceptedWorkflowReview, resolveWorkflowReview } from "../workflow/review.ts";

/**
 * A playbook is the learned model made operable: the workflow, decision rules,
 * know-how, taste, and open questions distilled from the expert memory graph so
 * a learner or agent can practice/operate from it. Every item keeps its
 * evidence episodes, so guidance is always traceable.
 */
export interface PlaybookRule {
  text: string;
  confidence: number;
  evidenceEpisodes: string[];
}

export interface Playbook {
  generatedTs: string;
  workflow: string[];
  decisionRules: PlaybookRule[];
  knowHow: PlaybookRule[];
  tasteRules: PlaybookRule[];
  artifactTypes: string[];
  openQuestions: string[];
}

function rules(claims: Claim[], kind: string): PlaybookRule[] {
  return claims
    .filter((c) => c.kind === kind)
    .sort((a, b) => b.confidence - a.confidence)
    .map((c) => ({
      text: c.text,
      confidence: c.confidence,
      evidenceEpisodes: c.evidenceEpisodes,
    }));
}

/** Distill the expert memory graph into an operable playbook. */
export function buildPlaybook(store: Store): Playbook {
  const claims = applyCorrections(store.claims.all(), store.corrections.all());
  const reviewed = latestAcceptedWorkflowReview(store);
  const rejectedEpisodes = new Set(
    store.episodes.all()
      .filter((episode) => {
        const resolution = resolveWorkflowReview(store, episode);
        return resolution.reviewed && !resolution.review;
      })
      .map((episode) => episode.id),
  );
  const workflowClaim = rules(
    claims.filter((claim) =>
      claim.kind !== "workflow_pattern" ||
      claim.evidenceEpisodes.some((episodeId) => !rejectedEpisodes.has(episodeId))),
    "workflow_pattern",
  )[0];
  const workflow = reviewed?.review
    ? reviewed.review.steps.map((step) => step.title)
    : workflowClaim
      ? workflowClaim.text
          .replace(/^Workflow:\s*/, "")
          .split("→")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  return {
    generatedTs: nowIso(),
    workflow,
    decisionRules: rules(claims, "decision_rule"),
    knowHow: rules(claims, "know_how"),
    tasteRules: rules(claims, "taste_rule"),
    artifactTypes: rules(claims, "artifact_type").map((r) => r.text),
    openQuestions: rules(claims, "unresolved_question").map((r) => r.text),
  };
}

/**
 * Critique a sequence of (learner/agent) actions against the playbook. Returns
 * advisories where the actions diverge from the learned model — this is what
 * lets the agent "intervene in learner work" (Layer 7) and what the Transfer
 * view shows. Conformance-checking, not invention.
 */
export function critique(playbook: Playbook, actions: ActionEvent[]): string[] {
  const advisories: string[] = [];
  const has = (t: string) => actions.some((a) => a.action === t);
  const idx = (t: string) => actions.findIndex((a) => a.action === t);

  // Workflow conformance: tests should precede a commit.
  if (playbook.workflow.some((s) => /test/i.test(s)) && has("committed")) {
    const commitAt = idx("committed");
    const testedBefore = actions
      .slice(0, commitAt)
      .some((a) => a.action === "ran_command" && /test/i.test(a.text ?? ""));
    if (!testedBefore) {
      advisories.push(
        "Workflow expects running tests before committing, but no test run was " +
          "observed before this commit.",
      );
    }
  }

  // Decision-rule reminders relevant to the current work.
  for (const rule of playbook.decisionRules) {
    if (rule.confidence >= 0.85) {
      advisories.push(`Remember the decision rule: ${rule.text}`);
    }
  }

  // Failure handling know-how.
  if (
    has("inspected_failure") === false &&
    actions.some((a) => a.action === "ran_command" && (a.payload?.exitCode ?? 0) !== 0)
  ) {
    advisories.push(
      "A command failed but no inspection followed — the learned know-how is to " +
        "inspect failures before retrying.",
    );
  }

  return advisories;
}
