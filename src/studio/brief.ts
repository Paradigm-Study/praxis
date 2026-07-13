import { basename } from "node:path";
import type { Store } from "../storage/index.ts";
import type { Claim } from "../core/types.ts";
import type { BriefPayload, LifecycleStage } from "../mesh/types.ts";
import { retrieveForTask } from "../agent/retrieveForTask.ts";
import { redactText } from "../mesh/redact.ts";
import { logger } from "../core/log.ts";
import { EgressAuditor } from "../privacy/egress.ts";
import { PrivacyControlStore } from "../privacy/control.ts";
import {
  isMeshProjectConsented,
  normalizeMeshProjectIdentity,
  resolveConsentedWorkspaceProject,
  safeMeshRelayBaseUrl,
  safeMeshWireIdentity,
  safeRepoRelativePath,
} from "../mesh/projectConsent.ts";
import { normalizeRepoUrl } from "../mesh/workframe.ts";

const log = logger("brief");
const MAX_MESH_BRIEF_BYTES = 256 * 1024;

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
   * Optional cwd hint. Used LOCALLY for claim retrieval and active project
   * consent resolution; the absolute path itself is never forwarded.
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
    ...(await fetchMeshBrief(
      opts,
      EgressAuditor.forStore(store),
      resolveBriefProject(store, opts),
    )),
    episodeGoal,
    topClaims: relevantClaims(store, episodeGoal, opts.cwd),
    openQuestions: undeliveredQuestions(store),
  };
}

/** Resolve a hook/API hint to exactly one currently consented mesh project. */
export function resolveBriefProject(
  store: Store,
  opts: Pick<BriefOptions, "cwd" | "project">,
): string | undefined {
  const consents = PrivacyControlStore.forStore(store).read().meshProjectConsents;
  const requested = opts.project ? normalizeRepoUrl(opts.project) : undefined;
  const workspace = opts.cwd ?? (opts.project ? undefined : process.cwd());

  if (workspace) {
    const resolved = resolveConsentedWorkspaceProject(consents, workspace);
    if (!resolved || (requested !== undefined && requested !== resolved.project)) {
      return undefined;
    }
    return resolved.project;
  }

  return requested && isMeshProjectConsented(consents, requested)
    ? requested
    : undefined;
}

/**
 * The goal (falling back to the summary) of the most recent episode. Episodes
 * are closed after the fact, so "latest" — not "still open" — is the right
 * read of "what is the user doing right now".
 */
function latestEpisodeGoal(store: Store): string {
  const latest = store.episodes.latest(1).at(-1);
  if (!latest) return "";
  return redactText(latest.goal ?? latest.summary ?? "", { maxChars: 320 });
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
    text: redactText(c.text, { maxChars: 320 }),
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
      question: redactText(d.question!, { maxChars: 320 }),
      createdTs: d.createdTs,
    }));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function safeSharedText(value: unknown, maxChars = 240): string {
  return typeof value === "string"
    ? redactText(value.slice(0, Math.max(1_024, maxChars * 4)).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim(), {
        maxChars,
      })
    : "";
}

function meshRoster(): Map<string, string> {
  const raw = process.env.PRAXIS_MESH_ROSTER_JSON;
  if (!raw || Buffer.byteLength(raw) > 128 * 1024) return new Map();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length > 500) return new Map();
    return new Map(entries.flatMap(([person, value]) => {
      if (!/^member-[a-f0-9]{24}$/.test(person) || typeof value !== "string" || value.length > 100) return [];
      const displayName = safeSharedText(value, 100);
      return displayName ? [[person, displayName] as const] : [];
    }));
  } catch {
    return new Map();
  }
}

function localDisplayName(person: string, roster: Map<string, string>): string {
  return roster.get(person) ?? "Team member";
}

/** Resolve a relay principal to locally provisioned roster text, never its opaque wire id. */
export function meshDisplayName(person: string): string {
  return localDisplayName(person, meshRoster());
}

/** Read a relay JSON response without allowing an unbounded body into memory. */
export async function boundedMeshJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_MESH_BRIEF_BYTES) throw new Error("mesh brief response too large");
  if (!response.body) return JSON.parse("");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MESH_BRIEF_BYTES) {
      await reader.cancel();
      throw new Error("mesh brief response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function sharedArtifacts(value: unknown): Array<{ repo: string; path: string; branch?: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((item) => {
    const artifact = record(item);
    const rawRepo = typeof artifact?.repo === "string" ? artifact.repo.slice(0, 500) : "";
    const rawPath = typeof artifact?.path === "string" ? artifact.path.slice(0, 1_025) : "";
    const repo = normalizeMeshProjectIdentity(rawRepo);
    const path = safeRepoRelativePath(rawPath);
    const branch = typeof artifact?.branch === "string" ? artifact.branch : "";
    return repo && path
      ? [{
          repo,
          path,
          ...(branch.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(branch)
            ? { branch }
            : {}),
        }]
      : [];
  });
}

/** Bound and whitelist relay-controlled data before it enters agent context. */
function normalizeMeshBrief(value: unknown): BriefPayload {
  const body = record(value);
  const roster = meshRoster();
  const teammates = Array.isArray(body?.teammates)
    ? body.teammates.slice(0, 20).flatMap((item) => {
        const teammate = record(item);
        const personId = safeSharedText(teammate?.person, 120);
        const intent = safeSharedText(teammate?.intent, 320);
        const ts = safeSharedText(teammate?.ts, 64);
        return personId && intent && ts
          ? [{ person: localDisplayName(personId, roster), intent, artifacts: sharedArtifacts(teammate?.artifacts), ts }]
          : [];
      })
    : [];
  const lockedSpecs = Array.isArray(body?.lockedSpecs)
    ? body.lockedSpecs.slice(0, 20).flatMap((item) => {
        const spec = record(item);
        const personId = safeSharedText(spec?.person, 120);
        const cardId = safeSharedText(spec?.cardId, 160);
        const ts = safeSharedText(spec?.ts, 64);
        const criteria = Array.isArray(spec?.specCriteria)
          ? spec.specCriteria.slice(0, 16).flatMap((raw) => {
              const criterion = record(raw);
              const id = safeSharedText(criterion?.id, 120);
              const behavior = safeSharedText(criterion?.behavior, 320);
              return id && behavior ? [{ id, behavior }] : [];
            })
          : [];
        return personId && cardId && ts
          ? [{ person: localDisplayName(personId, roster), cardId, specCriteria: criteria, artifacts: sharedArtifacts(spec?.artifacts), ts }]
          : [];
      })
    : [];
  const recentDecisions = Array.isArray(body?.recentDecisions)
    ? body.recentDecisions.slice(0, 20).flatMap((item) => {
        const decision = record(item);
        const personId = safeSharedText(decision?.person, 120);
        const project = typeof decision?.project === "string"
          ? normalizeMeshProjectIdentity(decision.project)
          : undefined;
        const cardId = safeSharedText(decision?.cardId, 160);
        const stage = decision?.stage;
        const ts = safeSharedText(decision?.ts, 64);
        const verdict = safeSharedText(decision?.verdict, 320);
        return personId && cardId && ts
          && (stage === "clarify" || stage === "plan" || stage === "spec" || stage === "results")
          ? [{
              person: localDisplayName(personId, roster),
              ...(project ? { project } : {}),
              cardId,
              stage: stage as LifecycleStage,
              ...(verdict ? { verdict } : {}),
              ts,
            }]
          : [];
      })
    : [];
  return { teammates, lockedSpecs, recentDecisions };
}

/**
 * The mesh half: relay GET /brief with the requester's bearer token. Empty
 * payload unless PRAXIS_MESH_URL + PRAXIS_MESH_TOKEN + a person are all
 * present, and on ANY failure — this must never surface an error.
 */
async function fetchMeshBrief(
  opts: BriefOptions,
  auditor: EgressAuditor,
  project: string | undefined,
): Promise<BriefPayload> {
  const rawUrl = process.env.PRAXIS_MESH_URL;
  const token = process.env.PRAXIS_MESH_TOKEN;
  const person = safeMeshWireIdentity(process.env.PRAXIS_PERSON);
  const teamId = process.env.PRAXIS_MESH_TEAM_ID;
  const deviceId = process.env.PRAXIS_MESH_DEVICE_ID;
  const safeTeamId = teamId === undefined ? undefined : safeMeshWireIdentity(teamId);
  const safeDeviceId = deviceId === undefined ? undefined : safeMeshWireIdentity(deviceId);
  if (
    !rawUrl || !token || !person || !project
    || (teamId === undefined) !== (deviceId === undefined)
    || (teamId !== undefined && (!safeTeamId || !safeDeviceId))
  ) return EMPTY_MESH;
  const url = safeMeshRelayBaseUrl(rawUrl);
  if (!url) return EMPTY_MESH;

  const params = new URLSearchParams({ person, project });
  // The cwd hint stays LOCAL: an absolute path leaks the username/home layout.
  // Only the canonical project from the live privacy mapping crosses the mesh.

  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const endpoint = `${url.replace(/\/+$/, "")}/brief?${params}`;
    const res = await fetchFn(endpoint, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(safeTeamId && {
          "x-mesh-team-id": safeTeamId,
        }),
        ...(safeDeviceId && {
          "x-mesh-device-id": safeDeviceId,
        }),
      },
      signal: AbortSignal.timeout(2000),
      redirect: "error",
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
    const normalized = normalizeMeshBrief(await boundedMeshJson(res));
    auditor.record({
      destination: url,
      purpose: "mesh_brief",
      categories: ["person", "project"],
      bytes: Buffer.byteLength(params.toString()),
      outcome: "succeeded",
      status: res.status,
    });
    return normalized;
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
