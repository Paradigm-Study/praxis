import type { DatabaseSync } from "node:sqlite";
import type {
  Correction,
  CorrectionTarget,
  CorrectionVerdict,
} from "../core/types.ts";
import { strOrUndef } from "./rows.ts";

export interface CorrectionStore {
  put(c: Correction): void;
  get(id: string): Correction | undefined;
  all(): Correction[];
  byTarget(targetId: string): Correction[];
}

function rowToCorrection(row: Record<string, unknown>): Correction {
  return {
    id: row.id as string,
    targetKind: row.target_kind as CorrectionTarget,
    targetId: row.target_id as string,
    verdict: row.verdict as CorrectionVerdict,
    correctedText: strOrUndef(row.corrected_text),
    note: strOrUndef(row.note),
    createdTs: row.created_ts as string,
  };
}

export function makeCorrectionStore(db: DatabaseSync): CorrectionStore {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO corrections
       (id, target_kind, target_id, verdict, corrected_text, note, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare(`SELECT * FROM corrections WHERE id = ?`);
  const byTarget = db.prepare(
    `SELECT * FROM corrections WHERE target_id = ? ORDER BY created_ts ASC`,
  );

  return {
    put(c) {
      insert.run(
        c.id,
        c.targetKind,
        c.targetId,
        c.verdict,
        c.correctedText ?? null,
        c.note ?? null,
        c.createdTs,
      );
    },
    get(id) {
      const row = byId.get(id) as Record<string, unknown> | undefined;
      return row ? rowToCorrection(row) : undefined;
    },
    all() {
      const rows = db
        .prepare(`SELECT * FROM corrections ORDER BY created_ts ASC`)
        .all() as Record<string, unknown>[];
      return rows.map(rowToCorrection);
    },
    byTarget(targetId) {
      const rows = byTarget.all(targetId) as Record<string, unknown>[];
      return rows.map(rowToCorrection);
    },
  };
}
