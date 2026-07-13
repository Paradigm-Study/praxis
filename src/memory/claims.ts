import type {
  ActionEvent,
  ClaimKind,
  ClaimProvenance,
  Episode,
} from "../core/types.ts";
import { correctionDirective } from "../reconstructor/correctionText.ts";

/**
 * A claim candidate derived from a single episode, before cross-episode merge.
 * `day` lets the graph builder detect patterns reused across days.
 */
export interface ClaimCandidate {
  kind: ClaimKind;
  text: string;
  confidence: number;
  episodeId: string;
  day: string;
  provenance?: ClaimProvenance;
}

const has = (actions: ActionEvent[], type: string) =>
  actions.some((a) => a.action === type);

/**
 * Derive evidence-backed claims from one episode's actions. Each claim is
 * grounded in actions that actually occurred — the model never invents these;
 * a later layer (the observer) only proposes; corrections adjust confidence.
 */
export function episodeClaims(
  episode: Episode,
  actions: ActionEvent[],
): ClaimCandidate[] {
  const day = episode.startTs.slice(0, 10);
  const mk = (
    kind: ClaimKind,
    text: string,
    confidence: number,
    provenance: ClaimProvenance = "observed_pattern",
  ): ClaimCandidate => ({
    kind,
    text,
    confidence,
    episodeId: episode.id,
    day,
    provenance,
  });
  const out: ClaimCandidate[] = [];

  // Corrections are valuable episode receipts, but only explicit durable-rule
  // language may become immediately trusted guidance. Task-local choices stay
  // provisional; conversational follow-ups create no memory claim at all.
  for (const a of actions) {
    if (a.action !== "corrected_agent" || !a.text) continue;
    const rejected =
      typeof a.payload?.rejects === "string" ? a.payload.rejects : undefined;
    const directive = correctionDirective(a.text);
    const durableScope =
      /^(?:always|never|require|i\s+prefer|from\s+now\s+on|going\s+forward|as\s+a\s+rule)\b/i.test(directive) ||
      /\bsource\s+of\s+truth\b/i.test(directive);
    if (durableScope || /^(?:prefer|avoid)\b/i.test(directive)) {
      out.push(mk(
        "decision_rule",
        decisionRuleText(a.text, rejected),
        0.9,
        durableScope ? "explicit_user_rule" : "observed_pattern",
      ));
    } else if (
      /^(?:do not|don'?t)\b/i.test(directive) &&
      !/^(?:do not|don'?t)\s+do\s+that\b/i.test(directive)
    ) {
      out.push(mk(
        "decision_heuristic",
        `Contextual correction: ${directive}`.slice(0, 500),
        0.82,
        "observed_pattern",
      ));
    } else if (
      /^(?:use|choose|keep|switch|replace|remove|add|change|leave|restore|run|make)\b/i.test(directive) &&
      (rejected !== undefined || /\b(?:instead(?:\s+of)?|rather\s+than|over)\b/i.test(directive))
    ) {
      out.push(mk(
        "decision_heuristic",
        `Contextual choice: ${directive}`.slice(0, 500),
        0.82,
        "observed_pattern",
      ));
    }
  }

  // workflow_pattern — the *stable* core cycle. Failure-handling is captured
  // separately as know_how, so the same workflow label recurs across days even
  // when one run had no failing test (this is what enables reused_across_days).
  const steps: string[] = [];
  if (has(actions, "submitted_message")) steps.push("consult AI");
  if (has(actions, "edited_file")) steps.push("edit implementation");
  if (actions.some((a) => a.action === "ran_command")) steps.push("run tests");
  if (has(actions, "committed")) steps.push("commit when green");
  if (steps.length >= 3) {
    // A single episode makes a workflow a hypothesis (~0.7); reuse across days
    // raises confidence via noisy-OR merge in the graph builder.
    out.push(
      mk("workflow_pattern", `Workflow: ${steps.join(" → ")}`, 0.45 + 0.05 * steps.length),
    );
  }

  // know_how — failure-handling.
  if (has(actions, "inspected_failure") && has(actions, "retried")) {
    out.push(
      mk(
        "know_how",
        "When a test fails, inspect the output, fix the implementation, and re-run until green.",
        0.8,
      ),
    );
  }

  // taste_rule — selective acceptance of AI edits.
  if (has(actions, "accepted_suggestion")) {
    out.push(
      mk("taste_rule", "Reviews AI-proposed edits and accepts before saving.", 0.7),
    );
  }

  // artifact_type — primary file types, but only for real editing (not commit
  // file-lists or machine-written files), so it doesn't fragment into noise.
  if (has(actions, "edited_file") || has(actions, "saved_file")) {
    const exts = new Set<string>();
    for (const art of episode.artifacts) {
      const m = art.match(/\.([a-z0-9]{1,5})$/i);
      const ext = m ? `.${m[1]!.toLowerCase()}` : undefined;
      if (ext && !/\.(db|db-wal|db-shm|log|lock|tmp|swp|map)$/.test(ext)) exts.add(ext);
    }
    if (exts.size) {
      out.push(
        mk("artifact_type", `Primary artifacts: ${[...exts].sort().join(", ")}`, 0.75),
      );
    }
  }

  return out;
}

function decisionRuleText(correctionText: string, rejected?: string): string {
  const prefer = correctionText.match(/prefer\s+([^.;\n]+)/i)?.[1]?.trim();
  if (prefer && rejected) return `Prefer ${prefer} over ${rejected}.`;
  if (prefer) return `Prefer ${prefer}.`;
  if (rejected) return `Avoid ${rejected}.`;
  return correctionText.replace(/\s+/g, " ").trim().slice(0, 140);
}
