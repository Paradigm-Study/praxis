import type { DatabaseSync } from "node:sqlite";
import type { BoundaryReason, Episode } from "../core/types.ts";
import { fromJsonArray, fromJsonObject, strOrUndef, toJson } from "./rows.ts";

export interface EpisodeStore {
  put(e: Episode): void;
  putMany(episodes: Episode[]): void;
  get(id: string): Episode | undefined;
  all(): Episode[];
  byIds(ids: string[]): Episode[];
  latest(n?: number): Episode[];
  count(): number;
}

function rowToEpisode(row: Record<string, unknown>): Episode {
  return {
    id: row.id as string,
    type: "context_episode",
    startTs: row.start_ts as string,
    endTs: row.end_ts as string,
    summary: row.summary as string,
    goal: strOrUndef(row.goal),
    actions: fromJsonArray(row.evidence_action_ids),
    artifacts: fromJsonArray(row.artifacts),
    decisionPoints: fromJsonArray(row.decision_points),
    rejectedPaths: fromJsonArray(row.rejected_paths),
    uncertainty: fromJsonArray(row.uncertainty),
    boundaryReason: strOrUndef(row.boundary_reason) as BoundaryReason | undefined,
    payload: fromJsonObject(row.payload_json),
  };
}

export function makeEpisodeStore(db: DatabaseSync): EpisodeStore {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO episodes
       (id, start_ts, end_ts, summary, goal, evidence_action_ids, artifacts,
        decision_points, rejected_paths, uncertainty, boundary_reason, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare(`SELECT * FROM episodes WHERE id = ?`);
  const counter = db.prepare(`SELECT COUNT(*) AS n FROM episodes`);

  function put(e: Episode): void {
    insert.run(
      e.id,
      e.startTs,
      e.endTs,
      e.summary,
      e.goal ?? null,
      toJson(e.actions),
      toJson(e.artifacts),
      toJson(e.decisionPoints),
      toJson(e.rejectedPaths),
      toJson(e.uncertainty),
      e.boundaryReason ?? null,
      e.payload ? toJson(e.payload) : null,
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
    get(id) {
      const row = byId.get(id) as Record<string, unknown> | undefined;
      return row ? rowToEpisode(row) : undefined;
    },
    all() {
      const rows = db
        .prepare(`SELECT * FROM episodes ORDER BY start_ts ASC`)
        .all() as Record<string, unknown>[];
      return rows.map(rowToEpisode);
    },
    byIds(ids) {
      if (ids.length === 0) return [];
      const rows = db
        .prepare(`SELECT * FROM episodes WHERE id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as Record<string, unknown>[];
      return rows.map(rowToEpisode);
    },
    latest(n = 10) {
      const rows = db
        .prepare(`SELECT * FROM episodes ORDER BY start_ts DESC LIMIT ?`)
        .all(Math.floor(n)) as Record<string, unknown>[];
      return rows.map(rowToEpisode).reverse();
    },
    count() {
      return (counter.get() as { n: number }).n;
    },
  };
}
