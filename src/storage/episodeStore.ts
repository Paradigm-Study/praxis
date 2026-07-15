import type { DatabaseSync } from "node:sqlite";
import type { BoundaryReason, Episode } from "../core/types.ts";
import { fromJsonArray, fromJsonObject, sensitiveText, strOrUndef, toJson } from "./rows.ts";
import type { StorageCipher } from "./crypto.ts";

export interface EpisodeStore {
  put(e: Episode): void;
  putMany(episodes: Episode[]): void;
  /** Atomically replace the complete derived episode projection. */
  reconcileAll(episodes: Episode[]): void;
  get(id: string): Episode | undefined;
  all(): Episode[];
  byIds(ids: string[]): Episode[];
  latest(n?: number): Episode[];
  /** Recent episode summaries for UI projection; payload_json is never read. */
  recentProjection(n: number): Episode[];
  /** Newest-first stable keyset page; payload_json is never read. */
  pageAfter(limit: number, cursor?: EpisodeCursor): Episode[];
  count(): number;
}

export interface EpisodeCursor {
  startTs: string;
  id: string;
}

const PROJECTION_COLUMNS = `id, start_ts, end_ts, summary, goal,
  evidence_action_ids, artifacts, decision_points, rejected_paths,
  uncertainty, boundary_reason`;

function rowToEpisode(row: Record<string, unknown>, cipher?: StorageCipher): Episode {
  return {
    id: row.id as string,
    type: "context_episode",
    startTs: row.start_ts as string,
    endTs: row.end_ts as string,
    summary: cipher?.decryptText(row.summary, "episodes.summary") ?? (row.summary as string),
    goal: strOrUndef(row.goal, cipher, "episodes.goal"),
    actions: fromJsonArray(row.evidence_action_ids),
    artifacts: fromJsonArray(row.artifacts, cipher, "episodes.artifacts"),
    decisionPoints: fromJsonArray(row.decision_points, cipher, "episodes.decision_points"),
    rejectedPaths: fromJsonArray(row.rejected_paths, cipher, "episodes.rejected_paths"),
    uncertainty: fromJsonArray(row.uncertainty, cipher, "episodes.uncertainty"),
    boundaryReason: strOrUndef(row.boundary_reason) as BoundaryReason | undefined,
    payload: fromJsonObject(row.payload_json, cipher, "episodes.payload_json"),
  };
}

export function makeEpisodeStore(db: DatabaseSync, cipher?: StorageCipher): EpisodeStore {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO episodes
       (id, start_ts, end_ts, summary, goal, evidence_action_ids, artifacts,
        decision_points, rejected_paths, uncertainty, boundary_reason, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare(`SELECT * FROM episodes WHERE id = ?`);
  const counter = db.prepare(`SELECT COUNT(*) AS n FROM episodes`);
  const remove = db.prepare(`DELETE FROM episodes WHERE id = ?`);
  const firstPage = db.prepare(
    `SELECT ${PROJECTION_COLUMNS}
       FROM episodes
      ORDER BY start_ts DESC, id DESC
      LIMIT ?`,
  );
  const pageAfter = db.prepare(
    `SELECT ${PROJECTION_COLUMNS}
       FROM episodes
      WHERE start_ts < ? OR (start_ts = ? AND id < ?)
      ORDER BY start_ts DESC, id DESC
      LIMIT ?`,
  );

  function put(e: Episode): void {
    insert.run(
      e.id,
      e.startTs,
      e.endTs,
      sensitiveText(e.summary, cipher, "episodes.summary"),
      sensitiveText(e.goal, cipher, "episodes.goal"),
      toJson(e.actions),
      toJson(e.artifacts, cipher, "episodes.artifacts"),
      toJson(e.decisionPoints, cipher, "episodes.decision_points"),
      toJson(e.rejectedPaths, cipher, "episodes.rejected_paths"),
      toJson(e.uncertainty, cipher, "episodes.uncertainty"),
      e.boundaryReason ?? null,
      e.payload ? toJson(e.payload, cipher, "episodes.payload_json") : null,
    );
  }

  return {
    put,
    putMany(episodes) {
      db.exec("BEGIN");
      try {
        for (const e of episodes) put(e);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    reconcileAll(episodes) {
      const desired = new Set(episodes.map((episode) => episode.id));
      db.exec("SAVEPOINT praxis_episode_reconcile");
      try {
        const existing = db.prepare(`SELECT id FROM episodes`).all() as Array<{ id: string }>;
        for (const episode of episodes) put(episode);
        for (const row of existing) if (!desired.has(row.id)) remove.run(row.id);
        db.exec("RELEASE praxis_episode_reconcile");
      } catch (error) {
        try {
          db.exec("ROLLBACK TO praxis_episode_reconcile; RELEASE praxis_episode_reconcile");
        } catch {
          // Preserve the materialization error if SQLite already aborted.
        }
        throw error;
      }
    },
    get(id) {
      const row = byId.get(id) as Record<string, unknown> | undefined;
      return row ? rowToEpisode(row, cipher) : undefined;
    },
    all() {
      const rows = db
        .prepare(`SELECT * FROM episodes ORDER BY start_ts ASC`)
        .all() as Record<string, unknown>[];
      return rows.map((row) => rowToEpisode(row, cipher));
    },
    byIds(ids) {
      if (ids.length === 0) return [];
      const rows = db
        .prepare(`SELECT * FROM episodes WHERE id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as Record<string, unknown>[];
      return rows.map((row) => rowToEpisode(row, cipher));
    },
    latest(n = 10) {
      const rows = db
        .prepare(`SELECT * FROM episodes ORDER BY start_ts DESC LIMIT ?`)
        .all(Math.floor(n)) as Record<string, unknown>[];
      return rows.map((row) => rowToEpisode(row, cipher)).reverse();
    },
    recentProjection(n) {
      const rows = db
        .prepare(`SELECT ${PROJECTION_COLUMNS} FROM episodes ORDER BY start_ts DESC, id DESC LIMIT ?`)
        .all(Math.max(0, Math.floor(n))) as Record<string, unknown>[];
      return rows.map((row) => rowToEpisode(row, cipher)).reverse();
    },
    pageAfter(limit, cursor) {
      const bounded = Math.max(0, Math.floor(limit));
      const rows = (cursor
        ? pageAfter.all(cursor.startTs, cursor.startTs, cursor.id, bounded)
        : firstPage.all(bounded)) as Record<string, unknown>[];
      return rows.map((row) => rowToEpisode(row, cipher));
    },
    count() {
      return (counter.get() as { n: number }).n;
    },
  };
}
