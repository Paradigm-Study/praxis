import type { ActionEvent, BoundaryReason, Episode } from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import { newId as defaultNewId } from "../core/ids.ts";
import { hashObject } from "../core/hash.ts";
import { toMs } from "../core/time.ts";
import {
  boundaryBetween,
  DEFAULT_BOUNDARY,
  type BoundaryConfig,
} from "./boundaries.ts";

export interface FuseOptions {
  newId?: (prefix: string) => string;
  boundary?: BoundaryConfig;
}

/** Group time-sorted actions into episodes using boundary detection. */
export function fuseActions(
  actions: ActionEvent[],
  opts: FuseOptions = {},
): Episode[] {
  const newId = opts.newId ?? defaultNewId;
  const cfg = opts.boundary ?? DEFAULT_BOUNDARY;
  const sorted = [...actions].sort((a, b) => toMs(a.startTs) - toMs(b.startTs));

  const episodes: Episode[] = [];
  let group: ActionEvent[] = [];
  let openReason: BoundaryReason = "session_start";

  const close = (next?: BoundaryReason) => {
    if (group.length === 0) return;
    episodes.push(buildEpisode(group, openReason, newId));
    if (next) openReason = next;
    group = [];
  };

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (group.length > 0) {
      const reason = boundaryBetween(group[group.length - 1]!, cur, cfg);
      if (reason) close(reason);
    }
    group.push(cur);
  }
  close();
  return episodes;
}

/** Read actions from the ledger, fuse, and (by default) persist episodes. */
export function fuse(
  store: Store,
  opts: FuseOptions & { persist?: boolean } = {},
): Episode[] {
  const actions = store.actions.range();
  const episodes = fuseActions(actions, opts);
  if (opts.persist !== false) store.episodes.putMany(episodes);
  return episodes;
}

// --------------------------------------------------------------------------
// Deterministic episode synthesis.
//
// The fuser's summary is FACTUAL (counts + notable actions). The interpretive
// "why it mattered" summary is the Observer's job (Layer 5) — kept separate so
// the model never overwrites the ledger-derived facts.
// --------------------------------------------------------------------------

function buildEpisode(
  actions: ActionEvent[],
  boundaryReason: BoundaryReason,
  newId: (prefix: string) => string,
): Episode {
  const start = actions[0]!.startTs;
  const end = actions[actions.length - 1]!.endTs;
  // Content-addressed id (start + the action-id set) → fusing the same actions
  // yields the same episode id, keeping the live loop idempotent. `newId` is
  // kept for signature compatibility but no longer used here.
  void newId;
  // Keyed on start + first action — stable as the open episode grows (the tail
  // gaining actions doesn't change its id), so re-fusing REPLACEs in place.
  const stableId = `episode_${hashObject({
    s: start,
    first: actions[0]!.id,
  }).slice(0, 16)}`;
  return {
    id: stableId,
    type: "context_episode",
    startTs: start,
    endTs: end,
    summary: summarize(actions),
    goal: inferGoal(actions),
    actions: actions.map((a) => a.id),
    artifacts: artifactsOf(actions),
    decisionPoints: decisionPointsOf(actions),
    rejectedPaths: rejectedPathsOf(actions),
    uncertainty: uncertaintyOf(actions),
    boundaryReason,
    payload: { actionCount: actions.length, apps: [...new Set(actions.map((a) => a.app))] },
  };
}

function countBy(actions: ActionEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of actions) m.set(a.action, (m.get(a.action) ?? 0) + 1);
  return m;
}

function summarize(actions: ActionEvent[]): string {
  const c = countBy(actions);
  const parts: string[] = [];
  const n = (k: string) => c.get(k) ?? 0;

  if (n("submitted_message"))
    parts.push(`submitted ${n("submitted_message")} message(s)`);
  if (n("corrected_agent")) parts.push("corrected the agent");

  const files = fileSet(actions);
  if (n("edited_file"))
    parts.push(`edited ${files.size} file(s) (${n("edited_file")} edit(s))`);

  const cmds = actions.filter((a) => a.action === "ran_command");
  if (cmds.length) {
    const failed = cmds.filter((a) => (a.payload?.exitCode ?? 0) !== 0).length;
    parts.push(
      `ran ${cmds.length} command(s)` +
        (failed ? ` (${failed} failed, ${cmds.length - failed} passed)` : ""),
    );
  }
  if (n("retried")) parts.push("retried after a failure");

  const commit = actions.find((a) => a.action === "committed");
  if (commit) parts.push(`committed "${commit.text ?? ""}"`);

  if (parts.length === 0) parts.push(`${actions.length} action(s)`);
  const apps = [...new Set(actions.map((a) => a.app))];
  return `In ${apps.join(", ")}: ${parts.join("; ")}.`;
}

function inferGoal(actions: ActionEvent[]): string | undefined {
  const commit = actions.find((a) => a.action === "committed");
  if (commit?.text) return commit.text;
  const firstSubmit = actions.find((a) => a.action === "submitted_message");
  if (firstSubmit?.text) return firstSubmit.text.split("\n")[0]!.slice(0, 100);
  return undefined;
}

function fileSet(actions: ActionEvent[]): Set<string> {
  const files = new Set<string>();
  for (const a of actions) {
    const p = a.payload?.path;
    if (typeof p === "string") files.add(p);
    const fs = a.payload?.files;
    if (Array.isArray(fs)) for (const f of fs) if (typeof f === "string") files.add(f);
  }
  return files;
}

function artifactsOf(actions: ActionEvent[]): string[] {
  const set = fileSet(actions);
  for (const a of actions) {
    const url = a.payload?.url;
    if (typeof url === "string") set.add(url);
  }
  return [...set];
}

function decisionPointsOf(actions: ActionEvent[]): string[] {
  const points: string[] = [];
  for (const a of actions) {
    if (a.action === "corrected_agent" && a.text) {
      points.push(a.text.replace(/\s+/g, " ").trim());
    }
    if (a.action === "retried") {
      points.push(`retried \`${a.text ?? "command"}\` after a failing run`);
    }
  }
  return [...new Set(points)];
}

function rejectedPathsOf(actions: ActionEvent[]): string[] {
  const out: string[] = [];
  for (const a of actions) {
    const rejects = a.payload?.rejects;
    if (typeof rejects === "string" && rejects) out.push(rejects);
    if (a.action === "rejected_suggestion" && a.text) out.push(a.text);
  }
  return [...new Set(out)];
}

function uncertaintyOf(actions: ActionEvent[]): string[] {
  const out: string[] = [];
  for (const a of actions) {
    if (a.confidence < 0.6 && a.uncertainty?.length) {
      out.push(`${a.action} (${a.confidence.toFixed(2)}): ${a.uncertainty[0]}`);
    }
  }
  return out;
}
