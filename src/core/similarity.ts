/**
 * Pluggable text-similarity provider (shared by retrieval, dedupe, and the
 * proxy-injection relevance filter). Kept in core so agent/, mesh/, and
 * capture/ can all depend on it without cycles.
 *
 * The default implementation is character-trigram cosine similarity:
 * lowercase the text, strip everything but alphanumerics (word gaps collapse
 * to single spaces so cross-word trigrams still mark boundaries), slide a
 * 3-char window to build a frequency vector, and take the cosine of the two
 * vectors. Character n-grams are deliberately forgiving about morphology
 * ("migration" vs "migrations" share almost all trigrams) without needing a
 * stemmer or a stopword list, which keeps this pure and dependency-free.
 */

export interface SimilarityProvider {
  /** Short identifier, e.g. "jaccard", for logs and A/B tests. */
  readonly name: string;
  /** Similarity of two texts in [0, 1]. Symmetric, deterministic. */
  similarity(a: string, b: string): number;
}

const NGRAM = 3;

/**
 * Normalize for gram extraction: lowercase, alnum-only, single spaces, and a
 * one-space pad on each side so word-boundary trigrams (" th", "se ") exist
 * and short words still contribute distinctive grams.
 */
function normalize(text: string): string {
  const collapsed = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return collapsed.length === 0 ? "" : ` ${collapsed} `;
}

/** Frequency map of character trigrams (whole string when shorter than one gram). */
function gramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const norm = normalize(text);
  if (norm.length === 0) return counts;
  if (norm.length <= NGRAM) {
    counts.set(norm, 1);
    return counts;
  }
  for (let i = 0; i <= norm.length - NGRAM; i++) {
    const gram = norm.slice(i, i + NGRAM);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Cosine of two sparse frequency vectors, 0 when either is empty. */
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  // Iterate the smaller map for the dot product.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [gram, n] of small) {
    const m = large.get(gram);
    if (m !== undefined) dot += n * m;
  }
  if (dot === 0) return 0;
  let magA = 0;
  for (const n of a.values()) magA += n * n;
  let magB = 0;
  for (const n of b.values()) magB += n * n;
  const sim = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  // Guard against float drift past 1 so callers can trust the [0,1] contract.
  return sim > 1 ? 1 : sim;
}

/** Character-trigram cosine similarity — deterministic, symmetric, [0,1]. */
export const NgramCosineProvider: SimilarityProvider = {
  name: "ngram_cosine",
  similarity(a: string, b: string): number {
    return cosine(gramCounts(a), gramCounts(b));
  },
};

export const defaultProvider: SimilarityProvider = NgramCosineProvider;
