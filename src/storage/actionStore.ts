import type { DatabaseSync } from "node:sqlite";
import type { ActionEvent, ActionType } from "../core/types.ts";
import { fromJsonArray, fromJsonObject, strOrUndef, toJson } from "./rows.ts";

export interface ActionRange {
  startTs?: string;
  endTs?: string;
  limit?: number;
}

export interface ActionStore {
  put(a: ActionEvent): void;
  putMany(actions: ActionEvent[]): void;
  get(id: string): ActionEvent | undefined;
  range(range?: ActionRange): ActionEvent[];
  byIds(ids: string[]): ActionEvent[];
  count(): number;
}

function rowToAction(row: Record<string, unknown>): ActionEvent {
  const uncertainty = fromJsonArray(row.uncertainty);
  const reconstructedBy = fromJsonArray(row.reconstructed_by);
  return {
    id: row.id as string,
    type: "user_action",
    action: row.action_type as ActionType,
    app: row.app as string,
    window: strOrUndef(row.window),
    startTs: row.start_ts as string,
    endTs: row.end_ts as string,
    text: strOrUndef(row.text),
    confidence: Number(row.confidence),
    evidence: fromJsonArray(row.evidence_ids),
    uncertainty: uncertainty.length ? uncertainty : undefined,
    payload: fromJsonObject(row.payload_json),
    reconstructedBy: reconstructedBy.length ? reconstructedBy : undefined,
  };
}

export function makeActionStore(db: DatabaseSync): ActionStore {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO action_events
       (id, start_ts, end_ts, action_type, app, window, text, confidence,
        evidence_ids, uncertainty, payload_json, reconstructed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare(`SELECT * FROM action_events WHERE id = ?`);
  const counter = db.prepare(`SELECT COUNT(*) AS n FROM action_events`);

  function put(a: ActionEvent): void {
    insert.run(
      a.id,
      a.startTs,
      a.endTs,
      a.action,
      a.app,
      a.window ?? null,
      a.text ?? null,
      a.confidence,
      toJson(a.evidence),
      a.uncertainty ? toJson(a.uncertainty) : null,
      a.payload ? toJson(a.payload) : null,
      a.reconstructedBy ? toJson(a.reconstructedBy) : null,
    );
  }

  return {
    put,
    putMany(actions) {
      db.exec("BEGIN");
      try {
        for (const a of actions) put(a);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    get(id) {
      const row = byId.get(id) as Record<string, unknown> | undefined;
      return row ? rowToAction(row) : undefined;
    },
    range(range = {}) {
      const where: string[] = [];
      const params: string[] = [];
      if (range.startTs) {
        where.push("start_ts >= ?");
        params.push(range.startTs);
      }
      if (range.endTs) {
        where.push("start_ts < ?");
        params.push(range.endTs);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const limit = range.limit ? `LIMIT ${Math.floor(range.limit)}` : "";
      const rows = db
        .prepare(`SELECT * FROM action_events ${clause} ORDER BY start_ts ASC ${limit}`)
        .all(...params) as Record<string, unknown>[];
      return rows.map(rowToAction);
    },
    byIds(ids) {
      if (ids.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT * FROM action_events WHERE id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(...ids) as Record<string, unknown>[];
      const order = new Map(ids.map((id, i) => [id, i]));
      return rows
        .map(rowToAction)
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    },
    count() {
      return (counter.get() as { n: number }).n;
    },
  };
}
