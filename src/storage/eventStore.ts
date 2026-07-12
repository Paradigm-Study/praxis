import type { DatabaseSync } from "node:sqlite";
import type { EventSource, RawEvent } from "../core/types.ts";
import { fromJsonArray, fromJsonObject, toJson } from "./rows.ts";
import { sensitiveText } from "./rows.ts";
import type { StorageCipher } from "./crypto.ts";

export interface EventRange {
  startTs?: string;
  endTs?: string;
  sources?: EventSource[];
  apps?: string[];
  limit?: number;
}

export interface EventStore {
  append(e: RawEvent): void;
  appendMany(events: RawEvent[]): void;
  get(id: string): RawEvent | undefined;
  getByHash(hash: string): RawEvent | undefined;
  range(range?: EventRange): RawEvent[];
  count(): number;
  /** Highest implicit rowid — a monotonic cursor for live tailing. */
  maxRowid(): number;
  /** Events appended after `rowid` (for SSE live streaming across processes). */
  sinceRowid(rowid: number, limit?: number): { maxRowid: number; events: RawEvent[] };
}

function rowToEvent(row: Record<string, unknown>, cipher?: StorageCipher): RawEvent {
  return {
    id: row.id as string,
    ts: row.ts as string,
    source: row.source as EventSource,
    app: cipher?.decryptText(row.app, "raw_events.app") ?? (row.app as string),
    window: cipher?.decryptText(row.window, "raw_events.window") ?? (row.window as string),
    type: row.type as string,
    payload: fromJsonObject(row.payload_json, cipher, "raw_events.payload_json") ?? {},
    blobRefs: fromJsonArray(row.blob_refs),
    hash: row.hash as string,
  };
}

export function makeEventStore(db: DatabaseSync, cipher?: StorageCipher): EventStore {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO raw_events
       (id, ts, source, app, window, type, payload_json, blob_refs, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare(`SELECT * FROM raw_events WHERE id = ?`);
  const byHash = db.prepare(`SELECT * FROM raw_events WHERE hash = ? LIMIT 1`);
  const counter = db.prepare(`SELECT COUNT(*) AS n FROM raw_events`);

  function append(e: RawEvent): void {
    insert.run(
      e.id,
      e.ts,
      e.source,
      sensitiveText(e.app, cipher, "raw_events.app"),
      sensitiveText(e.window, cipher, "raw_events.window"),
      e.type,
      toJson(e.payload, cipher, "raw_events.payload_json"),
      toJson(e.blobRefs),
      e.hash,
    );
  }

  return {
    append,
    appendMany(events) {
      db.exec("BEGIN");
      try {
        for (const e of events) append(e);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    get(id) {
      const row = byId.get(id) as Record<string, unknown> | undefined;
      return row ? rowToEvent(row, cipher) : undefined;
    },
    getByHash(hash) {
      const row = byHash.get(hash) as Record<string, unknown> | undefined;
      return row ? rowToEvent(row, cipher) : undefined;
    },
    range(range = {}) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (range.startTs) {
        where.push("ts >= ?");
        params.push(range.startTs);
      }
      if (range.endTs) {
        where.push("ts < ?");
        params.push(range.endTs);
      }
      if (range.sources?.length) {
        where.push(`source IN (${range.sources.map(() => "?").join(",")})`);
        params.push(...range.sources);
      }
      if (range.apps?.length) {
        where.push(`app IN (${range.apps.map(() => "?").join(",")})`);
        params.push(...range.apps.map((app) => sensitiveText(app, cipher, "raw_events.app")!));
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const limit = range.limit ? `LIMIT ${Math.floor(range.limit)}` : "";
      const rows = db
        .prepare(`SELECT * FROM raw_events ${clause} ORDER BY ts ASC ${limit}`)
        .all(...params) as Record<string, unknown>[];
      return rows.map((row) => rowToEvent(row, cipher));
    },
    count() {
      const row = counter.get() as { n: number };
      return row.n;
    },
    maxRowid() {
      const row = db.prepare(`SELECT MAX(rowid) AS m FROM raw_events`).get() as {
        m: number | null;
      };
      return row.m ?? 0;
    },
    sinceRowid(rowid, limit = 200) {
      const rows = db
        .prepare(
          `SELECT rowid AS _rid, * FROM raw_events WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`,
        )
        .all(rowid, Math.floor(limit)) as Array<Record<string, unknown>>;
      let max = rowid;
      const events = rows.map((r) => {
        max = Math.max(max, Number(r._rid));
        return rowToEvent(r, cipher);
      });
      return { maxRowid: max, events };
    },
  };
}
