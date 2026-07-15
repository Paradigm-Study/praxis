import type { Claim, Correction } from "../core/types.ts";
import { explicitDirectiveConflict } from "../core/textOpposition.ts";

/** Only an authenticated human-facing surface can author durable feedback. */
export function isHumanCorrection(correction: Correction): boolean {
  return correction.origin === "human";
}

/**
 * Consolidate raw claims into a tight profile — WITHOUT losing signal.
 *
 * This is a PURE, NON-DESTRUCTIVE derivation: the raw claims table is never
 * touched. Anti-over-consolidation guardrails:
 *   1. Merge only WITHIN a kind (never collapse a taste rule into a decision).
 *   2. Conservative lexical similarity → biased to UNDER-merge (the safe failure
 *      mode: a missed dedup leaves a near-duplicate, never a lost distinct claim).
 *   3. Merging is MONOTONIC: a cluster unions all evidence episodes and takes the
 *      noisy-OR of confidences, so it's strictly more-evidenced, never less.
 *   4. One-off claims are kept and labelled `provisional`, not deleted — low
 *      frequency ≠ noise.
 *   5. Evidence coverage is preserved by construction (every claim joins exactly
 *      one cluster) and asserted by {@link evidenceCoverage}.
 */

/**
 * Inviolability tier — borrowed from dot-skill's layered persona ("Layer 0:
 * never violate" → soft preference). It tells a downstream agent which learned
 * rules are hard constraints vs. helpful defaults, instead of a flat list:
 *   hard    — an explicit user correction, or a durable high-confidence decision
 *             rule. Treat as a constraint; do not violate.
 *   strong  — a durable preference/heuristic/pattern. Follow unless there's a
 *             concrete reason not to.
 *   soft    — a one-off (provisional) preference. A weak default, not a rule.
 *   context — an open question the model is unsure about; ask, don't assume.
 */
export type PriorityTier = "hard" | "strong" | "soft" | "context";

/** Sort key — lower is higher priority. */
export const PRIORITY_ORDER: Record<PriorityTier, number> = {
  hard: 0,
  strong: 1,
  soft: 2,
  context: 3,
};

/** Map a consolidated entry's (kind, durability, confidence) to its tier. */
export function priorityOf(
  kind: string,
  tier: "durable" | "provisional",
  confidence: number,
): PriorityTier {
  if (kind === "correction") return "hard"; // the user explicitly overrode us
  if (kind === "unresolved_question") return "context";
  const durable = tier === "durable";
  if (kind === "decision_rule" && durable && confidence >= 0.8) return "hard";
  return durable ? "strong" : "soft";
}

export interface ProfileEntry {
  kind: string;
  canonical: string; // the representative phrasing (highest-confidence variant)
  variants: string[]; // the other phrasings folded in (nothing is discarded)
  confidence: number;
  evidenceEpisodes: string[]; // union across the cluster
  tier: "durable" | "provisional";
  /** Inviolability tier for a downstream agent. See {@link PriorityTier}. */
  priority: PriorityTier;
  claimIds: string[];
}

export interface ConsolidateOptions {
  /** Jaccard threshold to merge (high → under-merge). Default 0.45. */
  threshold?: number;
  /** Min distinct evidence episodes for a claim to count as durable. Default 2. */
  durableEpisodes?: number;
  /**
   * User corrections to fold in (dot-skill's `correction_handler` idea). Applied
   * as a NON-DESTRUCTIVE override layer on the derived view — the raw claims
   * table is never touched:
   *   verdict "rejected" → the claim is dropped from the profile.
   *   verdict "edited"   → its text is replaced with the user's wording and its
   *                        confidence floored to 0.9 (user-authored = strong),
   *                        and effective provenance becomes human-reviewed.
   *   verdict "confirmed"→ its confidence is floored to 0.9 and effective
   *                        provenance becomes human-reviewed.
   * Matched by `targetId === claim.id`.
   */
  corrections?: Correction[];
}

/**
 * Fold user corrections into a claim list as an override layer, returning a NEW
 * list (inputs are never mutated; the raw store is never touched). Rejected
 * claims are removed; edited/confirmed claims are strengthened. Exported so the
 * profile view and the evidence-coverage check apply exactly the same filter.
 */
export function applyCorrections(claims: Claim[], corrections: Correction[] = []): Claim[] {
  const humanCorrections = corrections.filter(isHumanCorrection);
  if (!humanCorrections.length) return claims;
  const rejected = new Set<string>();
  const edited = new Map<string, string>();
  const confirmed = new Set<string>();
  // Last verdict per target wins (corrections are time-ordered).
  for (const c of humanCorrections) {
    if (c.verdict === "rejected") {
      rejected.add(c.targetId);
      edited.delete(c.targetId);
      confirmed.delete(c.targetId);
    } else if (c.verdict === "edited" && c.correctedText) {
      edited.set(c.targetId, c.correctedText);
      rejected.delete(c.targetId);
      confirmed.delete(c.targetId);
    } else if (c.verdict === "confirmed") {
      confirmed.add(c.targetId);
      rejected.delete(c.targetId);
      edited.delete(c.targetId);
    }
  }
  const out: Claim[] = [];
  for (const claim of claims) {
    if (rejected.has(claim.id)) continue; // suppressed from the view
    const newText = edited.get(claim.id);
    if (newText) {
      out.push({
        ...claim,
        text: newText,
        confidence: Math.max(claim.confidence, 0.9),
        provenance: "human_reviewed",
      });
    } else if (confirmed.has(claim.id)) {
      out.push({
        ...claim,
        confidence: Math.max(claim.confidence, 0.9),
        provenance: "human_reviewed",
      });
    } else {
      out.push(claim);
    }
  }
  return out;
}

/**
 * Claims safe to use as agent guidance. Provisional one-episode inferences stay
 * visible in Memory for review, but cannot steer future work as established
 * behavior. Repeated evidence and explicit human corrections are trusted.
 */
export function trustedClaims(
  claims: Claim[],
  corrections: Correction[] = [],
): Claim[] {
  const claimCorrections = corrections.filter(
    (item) => item.targetKind === "claim" && isHumanCorrection(item),
  );
  const latest = new Map<string, Correction>();
  for (const correction of claimCorrections) latest.set(correction.targetId, correction);
  return applyCorrections(claims, claimCorrections).filter((claim) => {
    const reviewed = latest.get(claim.id);
    return (
      new Set(claim.evidenceEpisodes).size >= 2 ||
      claim.provenance === "explicit_user_rule" ||
      claim.provenance === "human_reviewed" ||
      reviewed?.verdict === "confirmed" ||
      reviewed?.verdict === "edited"
    );
  });
}

const STOP = new Set([
  "the", "a", "an", "to", "of", "and", "or", "for", "in", "on", "at", "by", "with",
  "is", "are", "be", "user", "this", "that", "their", "they", "them", "it", "its",
  "via", "than", "over", "rather", "into", "as", "but", "not", "no", "do", "does",
  "prefers", "prefer", "avoids", "avoid", "strongly", "appears", "chose", "choose",
  "using", "use", "uses", "when", "after", "before", "would", "should",
]);

/**
 * Normalize a claim's text to a set of short prefix-stems, so paraphrases align
 * ("logs"/"log", "inspecting"/"inspection" → "insp") without a full stemmer.
 * Distinct claims share ~no content words, so they stay apart regardless.
 */
function contentTerms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/^(prefers?|avoids?)\s*:?\s*/i, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.length <= 5 ? w.replace(/s$/, "") : w).slice(0, 4)); // crude stem
}

function contentWords(text: string): Set<string> {
  return new Set(contentTerms(text));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function orderedOverlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
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

/** Conservative lexical + ordered similarity for recurring memory claims. */
export function claimTextSimilarity(left: string, right: string): number {
  if (explicitDirectiveConflict(left, right)) return 0;
  const polarity = (value: string): -1 | 0 | 1 => {
    const withoutNotOnly = value.replace(/\bnot\s+only\b/gi, "");
    if (/\b(?:avoid(?:s|ed)?|never|not|cannot|can't)\b/i.test(withoutNotOnly)) return -1;
    if (/\b(?:prefer(?:s|red)?|always|require(?:s|d)?|use(?:s|d)?|choose(?:s|n)?)\b/i.test(value)) return 1;
    return 0;
  };
  const leftPolarity = polarity(left);
  const rightPolarity = polarity(right);
  if (leftPolarity !== 0 && rightPolarity !== 0 && leftPolarity !== rightPolarity) return 0;
  const directional = (value: string): [string, string] | undefined => {
    const match = value.toLowerCase().match(
      /\b(?:prefer(?:s|red)?|choose(?:s)?|use(?:s)?)\s+([a-z0-9._+-]+)[\s\S]{0,80}?\b(?:over|instead of|rather than)\s+([a-z0-9._+-]+)/i,
    );
    return match ? [match[1]!, match[2]!] : undefined;
  };
  const leftDirection = directional(left);
  const rightDirection = directional(right);
  if (
    leftDirection &&
    rightDirection &&
    leftDirection[0] === rightDirection[1] &&
    leftDirection[1] === rightDirection[0]
  ) return 0;
  const leftTerms = contentTerms(left);
  const rightTerms = contentTerms(right);
  return Math.min(
    jaccard(new Set(leftTerms), new Set(rightTerms)),
    orderedOverlap(leftTerms, rightTerms),
  );
}

function noisyOr(ps: number[]): number {
  return Math.round((1 - ps.reduce((acc, p) => acc * (1 - p), 1)) * 100) / 100;
}

interface Cluster {
  kind: string;
  words: Set<string>;
  members: Claim[];
}

export function consolidate(claims: Claim[], opts: ConsolidateOptions = {}): ProfileEntry[] {
  const threshold = opts.threshold ?? 0.6;
  const durableEpisodes = opts.durableEpisodes ?? 2;

  // Fold in the user's corrections (drop rejected, strengthen edited/confirmed)
  // before clustering — a non-destructive override layer on the derived view.
  const corrected = applyCorrections(claims, opts.corrections);

  // Highest-confidence claims seed clusters, so the canonical phrasing is the
  // strongest one and weaker rewordings attach to it.
  const sorted = [...corrected].sort((a, b) => b.confidence - a.confidence);
  const clusters: Cluster[] = [];

  for (const claim of sorted) {
    const words = contentWords(claim.text);
    // Only consider clusters of the SAME kind.
    let best: Cluster | undefined;
    let bestSim = 0;
    for (const c of clusters) {
      if (c.kind !== claim.kind) continue;
      const representative = c.members[0]?.text ?? "";
      const sim = claimTextSimilarity(claim.text, representative);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best && bestSim >= threshold) {
      best.members.push(claim);
      for (const w of words) best.words.add(w); // grow the cluster's vocabulary
    } else {
      clusters.push({ kind: claim.kind, words: new Set(words), members: [claim] });
    }
  }

  return clusters
    .map((c): ProfileEntry => {
      const members = c.members.sort((a, b) => b.confidence - a.confidence);
      const episodes = new Set<string>();
      for (const m of members) for (const e of m.evidenceEpisodes) episodes.add(e);
      const confidence = noisyOr(members.map((m) => m.confidence));
      const tier = episodes.size >= durableEpisodes ? "durable" : "provisional";
      return {
        kind: c.kind,
        canonical: members[0]!.text,
        variants: members.slice(1).map((m) => m.text),
        confidence,
        evidenceEpisodes: [...episodes],
        tier,
        priority: priorityOf(c.kind, tier, confidence),
        claimIds: members.map((m) => m.id),
      };
    })
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Signal-preservation check: the set of evidence episodes covered by the profile
 * must equal the set covered by the raw claims. Consolidation that drops an
 * episode would be losing signal — this returns the gap (empty = none lost).
 */
export function evidenceCoverage(
  claims: Claim[],
  profile: ProfileEntry[],
  corrections: Correction[] = [],
): { rawEpisodes: number; profileEpisodes: number; dropped: string[] } {
  // Compare against the corrected baseline: episodes the user explicitly
  // rejected are SUPPOSED to be absent, so they don't count as lost signal.
  const baseline = applyCorrections(claims, corrections);
  const raw = new Set<string>();
  for (const c of baseline) for (const e of c.evidenceEpisodes) raw.add(e);
  const kept = new Set<string>();
  for (const p of profile) for (const e of p.evidenceEpisodes) kept.add(e);
  const dropped = [...raw].filter((e) => !kept.has(e));
  return { rawEpisodes: raw.size, profileEpisodes: kept.size, dropped };
}
