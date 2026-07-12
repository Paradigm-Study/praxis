import type { Claim, Episode } from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import { defaultProvider } from "../core/similarity.ts";

/**
 * Task-scoped long-term retrieval: "what do we already know that bears on this
 * TASK TEXT (optionally scoped to a repo/path/cwd)". The sibling of
 * retrieveLongTermContext (which scores against an Observation) — this one is
 * for dispatch, proxy injection, and the MCP retrieval tool, where the query
 * is a free-text task rather than a live observation.
 *
 * Ranking = textual relevance (defaultProvider, char-trigram cosine) plus a
 * scope boost for claims whose evidence episodes touched the artifacts the
 * task concerns (opts.repo / opts.path / opts.cwd). The boost means "we
 * learned this while working on the same files", which is often a stronger
 * relevance signal than wording overlap — a claim about flaky tests in
 * src/api/ should surface for ANY task on src/api/, however it is phrased.
 * Bounded like retrieve.ts: confidence floor, relevance floor, hard limit,
 * most relevant first.
 */

export interface RetrieveForTaskOptions {
  /** Normalized repo url the task concerns, for artifact-scoped boosting. */
  repo?: string;
  /** Repo-relative path the task concerns. */
  path?: string;
  /** Working directory the task runs in (used to infer repo when unset). */
  cwd?: string;
  /** Max claims to return. Default 5 (same as retrieve.ts). */
  limit?: number;
}

/** Drop claims below this confidence (weak long-term signal). Same as retrieve.ts. */
const MIN_CONFIDENCE = 0.5;
/**
 * Textual relevance floor. Function-word trigrams (" th", "the", " to") give
 * unrelated sentences a noise floor of ~0.05-0.18 under trigram cosine, so the
 * cutoff sits above that; genuinely on-topic pairs score 0.35+.
 */
const MIN_RELEVANCE = 0.2;
/** Additive boost per matched scope facet (repo / path / cwd), capped. */
const BOOST_PER_FACET = 0.25;
const BOOST_CAP = 0.5;

/**
 * Canonical repo form (mesh-wide convention): lowercase host, strip trailing
 * `.git` and trailing slash, ssh → https (git@github.com:a/b.git → https://github.com/a/b).
 */
function normalizeRepo(url: string): string {
  let u = url.trim();
  const ssh = /^git@([^:]+):(.+)$/.exec(u);
  if (ssh) u = `https://${ssh[1]}/${ssh[2]}`;
  u = u.replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = /^([a-z][a-z0-9+.-]*:\/\/)([^/]+)(.*)$/i.exec(u);
  if (parts) u = parts[1]!.toLowerCase() + parts[2]!.toLowerCase() + parts[3]!;
  return u;
}

/** Forward slashes, no trailing slash — so prefix/suffix checks are uniform. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Do two path-ish strings refer to the same file or nest one under the other?
 * Handles the absolute-vs-repo-relative mismatch (an episode artifact may be
 * "/Users/x/proj/src/api/server.ts" while opts.path is "src/api/server.ts")
 * by accepting segment-aligned suffix and prefix relations.
 */
function pathsRelate(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na.length === 0 || nb.length === 0) return false;
  return (
    na === nb ||
    na.endsWith(`/${nb}`) ||
    nb.endsWith(`/${na}`) ||
    na.startsWith(`${nb}/`) ||
    nb.startsWith(`${na}/`)
  );
}

/** Does any of the episode's artifacts match this scope facet? */
function artifactsMatch(
  artifacts: string[],
  facet: { repo?: string; path?: string; cwd?: string },
): { repo: boolean; path: boolean; cwd: boolean } {
  const repo = facet.repo ? normalizeRepo(facet.repo) : undefined;
  const hit = { repo: false, path: false, cwd: false };
  for (const raw of artifacts) {
    if (repo && normalizeRepo(raw).startsWith(repo)) hit.repo = true;
    if (facet.path && pathsRelate(raw, facet.path)) hit.path = true;
    if (facet.cwd) {
      const a = normalizePath(raw);
      const c = normalizePath(facet.cwd);
      if (a === c || a.startsWith(`${c}/`)) hit.cwd = true;
    }
  }
  return hit;
}

/** Scope boost in [0, BOOST_CAP] for a claim, via its evidence episodes' artifacts. */
function scopeBoost(
  claim: Claim,
  opts: RetrieveForTaskOptions,
  episodeCache: Map<string, Episode | undefined>,
  store: Store,
): number {
  if (!opts.repo && !opts.path && !opts.cwd) return 0;
  const hit = { repo: false, path: false, cwd: false };
  for (const epId of claim.evidenceEpisodes) {
    if (!episodeCache.has(epId)) episodeCache.set(epId, store.episodes.get(epId));
    const ep = episodeCache.get(epId);
    if (!ep) continue;
    const h = artifactsMatch(ep.artifacts, opts);
    hit.repo ||= h.repo;
    hit.path ||= h.path;
    hit.cwd ||= h.cwd;
  }
  const facets = (hit.repo ? 1 : 0) + (hit.path ? 1 : 0) + (hit.cwd ? 1 : 0);
  return Math.min(facets * BOOST_PER_FACET, BOOST_CAP);
}

/** Same claim shape retrieve.ts returns: bounded Claim[], most relevant first. */
export function retrieveForTask(
  store: Store,
  taskText: string,
  opts: RetrieveForTaskOptions = {},
): Claim[] {
  const limit = opts.limit ?? 5;
  if (limit <= 0 || taskText.trim().length === 0) return [];

  // Episodes are shared across claims; resolve each id at most once.
  const episodeCache = new Map<string, Episode | undefined>();

  return store.claims
    .all()
    .filter((c) => c.confidence >= MIN_CONFIDENCE)
    .map((c) => {
      const relevance = defaultProvider.similarity(taskText, c.text);
      const boost = scopeBoost(c, opts, episodeCache, store);
      return { claim: c, relevance, boost, score: relevance + boost };
    })
    // Keep textually relevant claims, plus any claim anchored to the task's
    // artifacts even when its wording shares nothing with the task text.
    .filter((s) => s.relevance >= MIN_RELEVANCE || s.boost > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.claim.confidence - a.claim.confidence ||
        b.claim.updatedTs.localeCompare(a.claim.updatedTs),
    )
    .slice(0, limit)
    .map((s) => s.claim);
}
