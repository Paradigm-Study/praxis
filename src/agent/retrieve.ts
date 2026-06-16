import type { Claim, Observation } from "../core/types.ts";
import type { Store } from "../storage/index.ts";

/**
 * Long-term context retrieval (Layer 7 input).
 *
 * Before the policy asks a question or takes an action, it should draw on what
 * the system has ALREADY learned about the user — not just the recent slice of
 * activity in the current episode. The durable store of that knowledge is the
 * expert memory graph's claims (`store.claims`): cross-episode, confidence-
 * weighted facts that persist across sessions.
 *
 * The hard part is staying BOUNDED: the policy must not be handed the whole
 * graph. {@link retrieveLongTermContext} scores every persisted claim against
 * the CURRENT situation (the observation's intent / task / question / inferred
 * preference) by topical overlap, drops weak or irrelevant ones, and returns
 * only the top few. The result is "what we already know that bears on right
 * now", which the policy uses to avoid re-asking established things and to
 * ground its reasoning.
 */

export interface RetrieveOptions {
  /** Max claims to return — keeps it bounded, not a dump. Default 5. */
  limit?: number;
  /** Drop claims below this confidence (weak long-term signal). Default 0.5. */
  minConfidence?: number;
  /** Drop claims whose topical overlap with the situation is below this. Default 0.34. */
  minRelevance?: number;
}

const STOP = new Set([
  "the", "a", "an", "to", "of", "and", "or", "for", "in", "on", "at", "by", "with",
  "is", "are", "be", "this", "that", "their", "they", "them", "it", "its", "you",
  "your", "yours", "i", "me", "my", "we", "us", "our", "via", "than", "over",
  "rather", "into", "as", "but", "not", "no", "do", "does", "did", "when", "after",
  "before", "would", "should", "could", "prefers", "prefer", "avoids", "avoid",
  "strongly", "appears", "chose", "choose", "using", "use", "uses", "think",
  "thinks", "thought", "correct", "right", "because", "about", "from", "was",
  "were", "had", "has", "have",
]);

/** Lowercase → strip punctuation → drop stopwords/short words → 4-char stems. */
function contentWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.slice(0, 4)); // crude stem so paraphrases align
  return new Set(words);
}

/** Number of content words shared between two word sets. */
function sharedWordCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/**
 * Topical overlap of two texts in [0,1], as the overlap coefficient
 * (shared content words / size of the smaller set). This is forgiving by design:
 * a short, on-topic claim ("Prefer Postgres for the database") should still
 * register as relevant to a longer question that mentions the same subject.
 */
export function topicalOverlap(a: string, b: string): number {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  return sharedWordCount(wa, wb) / Math.min(wa.size, wb.size);
}

/**
 * Directional coverage in [0,1]: the fraction of `query`'s content words that
 * also appear in `text`. Unlike the symmetric {@link topicalOverlap}, this does
 * NOT fire just because a short `text` happens to be fully contained in a long
 * `query` — it asks "how much of the QUESTION does this claim actually cover",
 * which is the right test for "has this claim already answered the question".
 */
export function termCoverage(query: string, text: string): number {
  const q = contentWords(query);
  if (q.size === 0) return 0;
  return sharedWordCount(q, contentWords(text)) / q.size;
}

/** The text that describes the current situation, for relevance scoring. */
function situationText(obs: Observation): string {
  return [
    obs.intent,
    obs.task,
    obs.decisionPoint,
    obs.inferredPreference,
    obs.suggestedQuestion,
    ...obs.uncertainty,
    ...obs.acceptedOptions,
    ...obs.rejectedOptions,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ");
}

/**
 * Retrieve the long-term knowledge relevant to the current observation, most
 * relevant first. Bounded by relevance, confidence, and a hard count limit so
 * the policy gets a focused brief, not the whole graph.
 */
export function retrieveLongTermContext(
  store: Store,
  observation: Observation,
  opts: RetrieveOptions = {},
): Claim[] {
  const limit = opts.limit ?? 5;
  const minConfidence = opts.minConfidence ?? 0.5;
  const minRelevance = opts.minRelevance ?? 0.34;

  const query = situationText(observation);
  if (!query) return [];

  return store.claims
    .all()
    .filter((c) => c.confidence >= minConfidence)
    .map((c) => ({ claim: c, relevance: topicalOverlap(query, c.text) }))
    .filter((s) => s.relevance >= minRelevance)
    // Rank by relevance first, breaking ties on confidence (then recency).
    .sort(
      (a, b) =>
        b.relevance - a.relevance ||
        b.claim.confidence - a.claim.confidence ||
        b.claim.updatedTs.localeCompare(a.claim.updatedTs),
    )
    .slice(0, limit)
    .map((s) => s.claim);
}
