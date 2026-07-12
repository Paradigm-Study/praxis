import { basename } from "node:path";
import type { Store } from "../storage/index.ts";
import type { Claim } from "../core/types.ts";
import type { BriefPayload } from "../mesh/types.ts";
import { retrieveForTask } from "../agent/retrieveForTask.ts";
import { redactText } from "../mesh/redact.ts";
import { logger } from "../core/log.ts";
import { EgressAuditor } from "../privacy/egress.ts";

const log = logger("brief");

/**
 * The studio's session brief, served at GET /api/brief (wired in
 * src/studio/server.ts). Two halves, both fail-open:
 *
 * LOCAL (always, from this machine's ledger):
 *   - episodeGoal    — what the latest episode says the user is doing
 *   - topClaims      — long-term claims relevant to the current task/cwd
 *   - openQuestions  — the agent's undelivered ask_expert questions (same
 *     "not yet answered by a correction" test the studio Questions view uses)
 *
 * MESH (only when PRAXIS_MESH_URL + PRAXIS_MESH_TOKEN + PRAXIS_PERSON are
 * set): the relay's GET /brief — teammates / lockedSpecs / recentDecisions in
 * the shared BriefPayload shape. Any relay problem (env unset, down, slow,
 * non-JSON) collapses to the empty payload; buildBrief itself NEVER rejects,
 * so the /api/brief route never 500s on a mesh hiccup.
 *
 * Every string that leaves this function passes redactText — the brief is
 * injected into agent context by hooks/praxis-brief.sh, and redaction is the
 * uniform fence for anything mesh-adjacent. (redactText is currently the
 * scaffold passthrough; this call site is where the real redactor engages.)
 */

export interface BriefOptions {
  /** Requesting person. Defaults to PRAXIS_PERSON. */
  person?: string;
  /** Project filter (git remote url or dir name). */
  project?: string;
  /**
   * Optional cwd hint. Used LOCALLY (claim retrieval, project basename); the
   * absolute path itself is never forwarded to the relay.
   */
  cwd?: string;
  /** Injectable for tests. Defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
}

/** An undelivered agent question, in the Questions-view card shape. */
export interface BriefOpenQuestion {
  questionId: string;
  question: string;
  createdTs: string;
}

/** BriefPayload (mesh half) plus this machine's local half. */
export interface StudioBrief extends BriefPayload {
  episodeGoal: string;
  topClaims: Claim[];
  openQuestions: BriefOpenQuestion[];
}

const EMPTY_MESH: BriefPayload = { teammates: [], lockedSpecs: [], recentDecisions: [] };

/** Cap on undelivered questions in the brief — same bound the Questions view uses. */
const MAX_OPEN_QUESTIONS = 8;

/** How far back to look for undelivered questions. */
const RECENT_DECISIONS = 50;

export async function buildBrief(
  store: Store,
  opts: BriefOptions = {},
): Promise<StudioBrief> {
  const episodeGoal = latestEpisodeGoal(store);
  return {
    ...(await fetchMeshBrief(opts, EgressAuditor.forStore(store))),
    episodeGoal,
    topClaims: relevantClaims(store, episodeGoal, opts.cwd),
    openQuestions: undeliveredQuestions(store),
  };
}

/**
 * The goal (falling back to the summary) of the most recent episode. Episodes
 * are closed after the fact, so "latest" — not "still open" — is the right
 * read of "what is the user doing right now".
 */
function latestEpisodeGoal(store: Store): string {
  const latest = store.episodes.latest(1).at(-1);
  if (!latest) return "";
  return redactText(latest.goal ?? latest.summary ?? "");
}

/**
 * Long-term claims that bear on the current work. The query text is the
 * episode goal (best signal) plus the cwd's basename (project hint); when
 * neither exists the generic "current work" keeps retrieveForTask's contract
 * of a non-empty task text.
 */
function relevantClaims(store: Store, episodeGoal: string, cwd?: string): Claim[] {
  const taskText =
    [episodeGoal, cwd ? basename(cwd) : ""].filter(Boolean).join(" ") || "current work";
  return retrieveForTask(store, taskText, { cwd, limit: 5 }).map((c) => ({
    ...c,
    text: redactText(c.text),
  }));
}

/**
 * The agent's proactive ask_expert questions that no correction has answered
 * yet — the same "answered = a correction targets the decision id" test the
 * studio Questions view applies (src/studio/server.ts questions()), narrowed
 * to ask_expert: those are the ones waiting on the human.
 */
function undeliveredQuestions(store: Store): BriefOpenQuestion[] {
  const answered = new Set(store.corrections.all().map((c) => c.targetId));
  return store.decisions
    .recent(RECENT_DECISIONS)
    .filter((d) => d.kind === "ask_expert" && d.question && !answered.has(d.id))
    .slice(0, MAX_OPEN_QUESTIONS)
    .map((d) => ({
      questionId: d.id,
      question: redactText(d.question!),
      createdTs: d.createdTs,
    }));
}

/**
 * The mesh half: relay GET /brief with the requester's bearer token. Empty
 * payload unless PRAXIS_MESH_URL + PRAXIS_MESH_TOKEN + a person are all
 * present, and on ANY failure — this must never surface an error.
 */
async function fetchMeshBrief(
  opts: BriefOptions,
  auditor: EgressAuditor,
): Promise<BriefPayload> {
  const url = process.env.PRAXIS_MESH_URL;
  const token = process.env.PRAXIS_MESH_TOKEN;
  const person = opts.person ?? process.env.PRAXIS_PERSON;
  if (!url || !token || !person) return EMPTY_MESH;

  const params = new URLSearchParams({ person });
  const project = opts.project ?? (opts.cwd ? basename(opts.cwd) : basename(process.cwd()));
  if (project) params.set("project", project);
  // The cwd hint stays LOCAL: an absolute path leaks the username/home layout
  // to the relay (which ignores the param anyway) — only the basename-derived
  // project identity crosses the mesh boundary.

  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const endpoint = `${url.replace(/\/+$/, "")}/brief?${params}`;
    const res = await fetchFn(endpoint, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(process.env.PRAXIS_MESH_TEAM_ID && {
          "x-mesh-team-id": process.env.PRAXIS_MESH_TEAM_ID,
        }),
        ...(process.env.PRAXIS_MESH_DEVICE_ID && {
          "x-mesh-device-id": process.env.PRAXIS_MESH_DEVICE_ID,
        }),
      },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      auditor.record({
        destination: url,
        purpose: "mesh_brief",
        categories: ["person", "project"],
        bytes: Buffer.byteLength(params.toString()),
        outcome: "failed",
        status: res.status,
      });
      log.debug(`relay /brief ${res.status} — serving local-only brief`);
      return EMPTY_MESH;
    }
    auditor.record({
      destination: url,
      purpose: "mesh_brief",
      categories: ["person", "project"],
      bytes: Buffer.byteLength(params.toString()),
      outcome: "succeeded",
      status: res.status,
    });
    const body = (await res.json()) as Partial<BriefPayload> | null;
    return {
      teammates: Array.isArray(body?.teammates) ? body.teammates : [],
      lockedSpecs: Array.isArray(body?.lockedSpecs) ? body.lockedSpecs : [],
      recentDecisions: Array.isArray(body?.recentDecisions) ? body.recentDecisions : [],
    };
  } catch (err) {
    auditor.record({
      destination: url,
      purpose: "mesh_brief",
      categories: ["person", "project"],
      bytes: Buffer.byteLength(params.toString()),
      outcome: "failed",
      error: String(err),
    });
    log.debug(`relay /brief unreachable (${String(err)}) — serving local-only brief`);
    return EMPTY_MESH;
  }
}
