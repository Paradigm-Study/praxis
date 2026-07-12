import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { ActionEvent, Episode, Observation } from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import { defaultDataDir } from "../storage/index.ts";
import type { DispatchRecord } from "../mesh/types.ts";
import type { Decision } from "./policy.ts";
import { newId as defaultNewId } from "../core/ids.ts";
import { nowIso, toIso, toMs } from "../core/time.ts";
import { sha256 } from "../core/hash.ts";
import { redactText } from "../mesh/redact.ts";
import { retrieveForTask } from "./retrieveForTask.ts";
import { logger } from "../core/log.ts";

const log = logger("dispatch");

/**
 * Dispatch execution (the action side of the policy's "dispatch" decision
 * kind), triggered by a high-confidence `encountered_error` reconstruction
 * (see src/reconstructor/rules/errors.ts).
 *
 * Guard rails, in order — every one exists to keep dispatch BORING:
 *   1. dedup    — the same error (fingerprinted on normalized text, so path /
 *                 line-number / address churn doesn't defeat it) dispatches once;
 *   2. budget   — max 3 dispatches per UTC day, however many distinct errors;
 *   3. stand-down — if the human recently edited a file the error mentions,
 *                 they are already on it; a dispatched agent would collide.
 *
 * DRY-RUN by default: the record carries the argv that WOULD have been
 * spawned; only PRAXIS_DISPATCH_SPAWN=1 permits a real detached `claude -p`.
 * BOARDROOM_URL delivers an advisory present_report (fire-and-forget, 2s
 * timeout, errors swallowed). Never throws; never blocks the tick.
 */

/** Confidence floor for an encountered_error action to trigger a dispatch. */
const MIN_ERROR_CONFIDENCE = 0.6;
/** Hard budget: dispatches per UTC day. */
const DAILY_BUDGET = 3;
/** An edited_file this recent counts as "the human is already on it". */
const RECENT_EDIT_MS = 15 * 60_000;
/** Cap on the redacted error text carried by the record. */
const ERROR_TEXT_MAX = 500;
/** How many trailing actions ship as repro breadcrumbs (id+action+app only). */
const REPRO_ACTIONS = 10;

export interface ReproAction {
  id: string;
  action: string;
  app: string;
}

/**
 * The persisted shape: a wire-contract DispatchRecord plus the error-dispatch
 * fields (local to data/dispatches.ndjson — never leaves the machine as-is).
 */
export interface ErrorDispatchRecord extends DispatchRecord {
  fingerprint: string;
  reproActions: ReproAction[];
  repoGuess?: string;
}

export interface DispatchContext {
  store: Store;
  /** The policy decision (kind === "dispatch"); decision.task is the task text. */
  decision: Decision;
  observation: Observation;
  /** Episode that was being observed when the decision fired. */
  episode?: Episode;
  /** The persisted StoredDecision id for this decision. */
  decisionId?: string;
  /** Id factory (seeded in tests). */
  newId?: (prefix: string) => string;
}

/**
 * Normalize error text so the SAME failure fingerprints identically across
 * runs: paths, hex addresses/hashes, and line/counter numbers all vary between
 * occurrences of one bug, so they collapse to placeholders.
 */
export function normalizeErrorText(text: string): string {
  return text
    .toLowerCase()
    .replace(/(?:[a-z]:)?(?:[\w.~-]+)?(?:[\\/][\w.~-]+)+/g, "<path>")
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable identity of an error occurrence. */
export function errorFingerprint(text: string): string {
  return sha256(normalizeErrorText(text));
}

/** Where dispatch records persist (PRAXIS_DATA_DIR-aware, read at use time). */
export function dispatchLogPath(): string {
  return join(defaultDataDir(), "dispatches.ndjson");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readDispatchLog(file: string): ErrorDispatchRecord[] {
  if (!existsSync(file)) return [];
  const out: ErrorDispatchRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ErrorDispatchRecord);
    } catch {
      // A torn/corrupt line must not take dispatch down — skip it.
    }
  }
  return out;
}

function secureDataDir(file: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort on filesystems that do not implement POSIX modes.
  }
}

function appendDispatchRecord(file: string, record: ErrorDispatchRecord): void {
  secureDataDir(file);
  appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort on filesystems that do not implement POSIX modes.
  }
}

function replaceDispatchRecord(file: string, record: ErrorDispatchRecord): void {
  secureDataDir(file);
  const records = readDispatchLog(file).map((existing) =>
    existing.id === record.id ? record : existing,
  );
  writeFileSync(file, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** The triggering high-confidence encountered_error action, if any. */
function findTrigger(ctx: DispatchContext): ActionEvent | undefined {
  const isTrigger = (a: ActionEvent) =>
    a.action === "encountered_error" && a.confidence >= MIN_ERROR_CONFIDENCE;
  const evidenceIds = ctx.decision.evidence ?? [];
  if (evidenceIds.length > 0) {
    const fromEvidence = ctx.store.actions
      .byIds(evidenceIds)
      .filter(isTrigger)
      .sort((a, b) => toMs(b.startTs) - toMs(a.startTs))[0];
    if (fromEvidence) return fromEvidence;
  }
  // Fall back to the most recent qualifying action in the store.
  const all = ctx.store.actions.range();
  for (let i = all.length - 1; i >= 0; i--) {
    if (isTrigger(all[i]!)) return all[i];
  }
  return undefined;
}

/** Most recent git/filesystem event that names a repo/workdir. */
function guessRepo(store: Store): string | undefined {
  const events = store.events.range({ sources: ["git", "filesystem"] });
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i]!.payload as Record<string, unknown>;
    const cand =
      str(p.repo) ?? str(p.remote) ?? str(p.repoUrl) ?? str(p.root) ?? str(p.cwd);
    if (cand) return cand;
  }
  return undefined;
}

/**
 * Stand-down check: is the human already editing a file the error mentions?
 * Matches on full path or basename (basenames shorter than 3 chars are too
 * ambiguous to count).
 */
function humanAlreadyOnIt(store: Store, errorText: string): boolean {
  const cutoff = toIso(Date.now() - RECENT_EDIT_MS);
  const recent = store.actions
    .range({ startTs: cutoff })
    .filter((a) => a.action === "edited_file");
  for (const a of recent) {
    const path = str(a.payload?.path) ?? str(a.text);
    if (!path) continue;
    const base = basename(path);
    if (errorText.includes(path) || (base.length >= 3 && errorText.includes(base))) {
      return true;
    }
  }
  return false;
}

/** Compose the argv that a real dispatch would spawn. Exported for tests. */
export function composeDispatchCommand(brief: string): string[] {
  return ["claude", "-p", brief];
}

function buildBrief(
  task: string,
  claims: string[],
  repro: ReproAction[],
  repoGuess: string | undefined,
): string {
  const lines = [
    "You are a dispatched investigation agent (sent by praxis).",
    "A recurring error was observed on this machine. Reproduce it, diagnose the root cause, and propose a minimal fix. Do not commit or push.",
    "",
    "Error (redacted):",
    task,
  ];
  if (repoGuess) lines.push("", `Likely repo/workdir: ${repoGuess}`);
  if (claims.length > 0) {
    lines.push("", "Relevant prior knowledge:", ...claims.map((c) => `- ${c}`));
  }
  if (repro.length > 0) {
    lines.push(
      "",
      "Recent reconstructed actions (oldest first):",
      ...repro.map((r) => `- ${r.action} in ${r.app} (${r.id})`),
    );
  }
  return lines.join("\n");
}

/**
 * Advisory delivery to boardroom's MCP endpoint: raw JSON-RPC 2.0 over
 * Streamable HTTP (initialize, then tools/call present_report). Fire and
 * forget — 2s timeout per request, every error swallowed by the caller.
 */
async function deliverReport(baseUrl: string, record: ErrorDispatchRecord): Promise<void> {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const endpoint = trimmed.endsWith("/mcp") ? trimmed : `${trimmed}/mcp`;
  const post = (body: unknown, sessionId?: string) =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "praxis-dispatch", version: "0.1.0" },
    },
  });
  const sessionId = init.headers.get("mcp-session-id") ?? undefined;
  await post(
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    sessionId,
  );
  await post(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "present_report",
        arguments: {
          // Shape verified against boardroom's PresentReportInput
          // (src/shared/inputs.ts): `project` is required; every block needs a
          // unique `id`; markdown blocks carry their body under `text`.
          project: record.repoGuess ?? basename(process.cwd()),
          headline: "Praxis dispatched an error investigation",
          blocks: [
            {
              id: "error",
              type: "markdown",
              text: `**Error (redacted):**\n\n\`\`\`\n${record.task}\n\`\`\``,
            },
            {
              id: "facts",
              type: "key_facts",
              facts: [
                { label: "Fingerprint", value: record.fingerprint.slice(0, 12) },
                { label: "Mode", value: record.mode },
                { label: "Dispatch id", value: record.id },
                ...(record.repoGuess
                  ? [{ label: "Repo", value: record.repoGuess }]
                  : []),
              ],
            },
          ],
        },
      },
    },
    sessionId,
  );
}

/** Execute (or dry-run) a dispatch. Undefined = nothing was dispatched. */
export async function maybeDispatch(
  ctx: DispatchContext,
): Promise<DispatchRecord | undefined> {
  try {
    return runDispatch(ctx);
  } catch (err) {
    // Dispatch is strictly advisory — it must never throw into the tick.
    log.warn("dispatch failed open", String(err));
    return undefined;
  }
}

function runDispatch(ctx: DispatchContext): DispatchRecord | undefined {
  const trigger = findTrigger(ctx);
  const rawError =
    str(trigger?.payload?.errorText) ?? trigger?.text ?? ctx.decision.task;
  if (!rawError || !rawError.trim()) return undefined;

  const fingerprint = errorFingerprint(rawError);
  const file = dispatchLogPath();
  const prior = readDispatchLog(file);

  // 1. Dedup: this exact failure (modulo paths/lines/addresses) already went out.
  if (prior.some((r) => r.fingerprint === fingerprint)) {
    log.debug("dispatch suppressed: duplicate fingerprint", fingerprint.slice(0, 12));
    return undefined;
  }

  // 2. Budget: max 3 dispatches per UTC day.
  const ts = nowIso();
  const today = ts.slice(0, 10);
  const spentToday = prior.filter((r) => (r.ts ?? "").slice(0, 10) === today).length;
  if (spentToday >= DAILY_BUDGET) {
    log.debug("dispatch suppressed: daily budget exhausted");
    return undefined;
  }

  // 3. Stand-down: the human recently edited a file this error names.
  if (humanAlreadyOnIt(ctx.store, rawError)) {
    log.debug("dispatch suppressed: human already editing an implicated file");
    return undefined;
  }

  const task = redactText(rawError, { maxChars: ERROR_TEXT_MAX }).slice(
    0,
    ERROR_TEXT_MAX,
  );
  const reproActions: ReproAction[] = ctx.store.actions
    .range()
    .slice(-REPRO_ACTIONS)
    .map((a) => ({ id: a.id, action: String(a.action), app: a.app }));
  const repoGuess = guessRepo(ctx.store);

  let claims: string[] = [];
  try {
    claims = retrieveForTask(ctx.store, rawError, { limit: 3 }).map((c) =>
      redactText(c.text, { maxChars: 200 }),
    );
  } catch (err) {
    log.debug("retrieveForTask failed open", String(err));
  }

  const brief = buildBrief(task, claims, reproActions, repoGuess);
  const command = composeDispatchCommand(brief);
  const spawnAllowed = process.env.PRAXIS_DISPATCH_SPAWN === "1";

  const record: ErrorDispatchRecord = {
    v: 0,
    id: (ctx.newId ?? defaultNewId)("dispatch"),
    ts,
    task,
    reason: ctx.decision.reason,
    episodeId: ctx.episode?.id,
    decisionId: ctx.decisionId,
    evidence: trigger ? [trigger.id] : [...(ctx.decision.evidence ?? [])],
    mode: spawnAllowed ? "spawned" : "dry_run",
    command,
    status: spawnAllowed ? "running" : "planned",
    fingerprint,
    reproActions,
    repoGuess,
  };

  // Persist the dedup/budget record before a real spawn. If spawning fails or
  // the process exits immediately, the same error must not create an unbounded
  // respawn loop on the next tick.
  let dispatchPersisted = false;
  try {
    appendDispatchRecord(file, record);
    dispatchPersisted = true;
  } catch (err) {
    log.warn("dispatch log write failed open", String(err));
    if (spawnAllowed) {
      record.mode = "dry_run";
      record.status = "failed";
      record.resultSummary = "not spawned: dispatch log unavailable";
    }
  }

  // Real spawn only behind the flag: detached, output discarded, unref'd so it
  // never holds the loop process open. Tests never set the flag.
  if (spawnAllowed && dispatchPersisted) {
    try {
      const cwd =
        repoGuess && repoGuess.startsWith("/") && existsSync(repoGuess)
          ? repoGuess
          : process.cwd();
      const child = spawn(command[0]!, command.slice(1), {
        cwd,
        detached: true,
        stdio: "ignore",
      });
      // spawn() reports missing executables and some OS failures
      // asynchronously. Without this listener ENOENT is an uncaught exception
      // that terminates the entire praxis agent process.
      child.once("error", (err) => {
        log.warn("dispatch spawn failed", String(err));
        record.status = "failed";
        record.resultSummary = "spawn failed";
        try {
          replaceDispatchRecord(file, record);
        } catch (writeErr) {
          log.warn("dispatch failure status write failed open", String(writeErr));
        }
      });
      child.unref();
    } catch (err) {
      log.warn("dispatch spawn failed", String(err));
      record.status = "failed";
      record.resultSummary = "spawn failed";
      try {
        replaceDispatchRecord(file, record);
      } catch (writeErr) {
        log.warn("dispatch failure status write failed open", String(writeErr));
      }
    }
  }

  const boardroomUrl = process.env.BOARDROOM_URL;
  if (boardroomUrl) {
    deliverReport(boardroomUrl, record).catch((err) => {
      log.debug("boardroom report failed open", String(err));
    });
  }

  log.info(`dispatch ${record.mode}: ${record.id} (${fingerprint.slice(0, 12)})`);
  return record;
}
