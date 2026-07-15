import type { DatabaseSync } from "node:sqlite";
import type {
  Correction,
  CorrectionOrigin,
  CorrectionTarget,
  CorrectionVerdict,
} from "../core/types.ts";
import { sensitiveText, strOrUndef } from "./rows.ts";
import type { StorageCipher } from "./crypto.ts";

export interface CorrectionStore {
  put(c: Correction): void;
  get(id: string): Correction | undefined;
  all(): Correction[];
  recent(limit: number): Correction[];
  byTarget(targetId: string): Correction[];
}

function rowToCorrection(row: Record<string, unknown>, cipher?: StorageCipher): Correction {
  const origin: CorrectionOrigin = row.origin === "human" || row.origin === "agent"
    ? row.origin
    : "legacy";
  return {
    id: row.id as string,
    targetKind: row.target_kind as CorrectionTarget,
    targetId: row.target_id as string,
    verdict: row.verdict as CorrectionVerdict,
    origin,
    correctedText: strOrUndef(row.corrected_text, cipher, "corrections.corrected_text"),
    note: strOrUndef(row.note, cipher, "corrections.note"),
    createdTs: row.created_ts as string,
  };
}

export function makeCorrectionStore(db: DatabaseSync, cipher?: StorageCipher): CorrectionStore {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO corrections
       (id, target_kind, target_id, verdict, origin, corrected_text, note, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare(`SELECT * FROM corrections WHERE id = ?`);
  const byTarget = db.prepare(
    `SELECT * FROM corrections WHERE target_id = ? ORDER BY created_ts ASC, rowid ASC`,
  );

  return {
    put(c) {
      insert.run(
        c.id,
        c.targetKind,
        c.targetId,
        c.verdict,
        c.origin ?? "legacy",
        sensitiveText(c.correctedText, cipher, "corrections.corrected_text"),
        sensitiveText(c.note, cipher, "corrections.note"),
        c.createdTs,
      );
    },
    get(id) {
      const row = byId.get(id) as Record<string, unknown> | undefined;
      return row ? rowToCorrection(row, cipher) : undefined;
    },
    all() {
      const rows = db
        .prepare(`SELECT * FROM corrections ORDER BY created_ts ASC, rowid ASC`)
        .all() as Record<string, unknown>[];
      return rows.map((row) => rowToCorrection(row, cipher));
    },
    recent(limit) {
      const rows = db
        .prepare(`SELECT * FROM corrections ORDER BY created_ts DESC, rowid DESC LIMIT ?`)
        .all(Math.max(0, Math.floor(limit))) as Record<string, unknown>[];
      return rows.map((row) => rowToCorrection(row, cipher)).reverse();
    },
    byTarget(targetId) {
      const rows = byTarget.all(targetId) as Record<string, unknown>[];
      return rows.map((row) => rowToCorrection(row, cipher));
    },
  };
}
