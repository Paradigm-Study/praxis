import type { DatabaseSync } from "node:sqlite";
import type { Claim, ClaimKind } from "../core/types.ts";
import { fromJsonArray, sensitiveText, toJson } from "./rows.ts";
import type { StorageCipher } from "./crypto.ts";

export interface ClaimStore {
  put(c: Claim): void;
  get(id: string): Claim | undefined;
  all(): Claim[];
  top(limit: number): Claim[];
  byKind(kind: ClaimKind): Claim[];
  /** Exact-text match within a kind — used to dedupe/merge claims. */
  findByText(kind: string, text: string): Claim | undefined;
  remove(id: string): void;
  count(): number;
}

function rowToClaim(row: Record<string, unknown>, cipher?: StorageCipher): Claim {
  return {
    id: row.id as string,
    kind: row.kind as ClaimKind,
    text: cipher?.decryptText(row.text, "claims.text") ?? (row.text as string),
    confidence: Number(row.confidence),
    evidenceEpisodes: fromJsonArray(row.evidence_episode_ids),
    createdTs: row.created_ts as string,
    updatedTs: row.updated_ts as string,
  };
}

export function makeClaimStore(db: DatabaseSync, cipher?: StorageCipher): ClaimStore {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO claims
       (id, kind, text, confidence, evidence_episode_ids, created_ts, updated_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare(`SELECT * FROM claims WHERE id = ?`);
  const byText = db.prepare(
    `SELECT * FROM claims WHERE kind = ? AND text = ? LIMIT 1`,
  );
  const counter = db.prepare(`SELECT COUNT(*) AS n FROM claims`);
  const remove = db.prepare(`DELETE FROM claims WHERE id = ?`);

  return {
    put(c) {
      insert.run(
        c.id,
        c.kind,
        sensitiveText(c.text, cipher, "claims.text"),
        c.confidence,
        toJson(c.evidenceEpisodes),
        c.createdTs,
        c.updatedTs,
      );
    },
    get(id) {
      const row = byId.get(id) as Record<string, unknown> | undefined;
      return row ? rowToClaim(row, cipher) : undefined;
    },
    all() {
      const rows = db
        .prepare(`SELECT * FROM claims ORDER BY confidence DESC`)
        .all() as Record<string, unknown>[];
      return rows.map((row) => rowToClaim(row, cipher));
    },
    top(limit) {
      const rows = db
        .prepare(`SELECT * FROM claims ORDER BY confidence DESC, updated_ts DESC, id DESC LIMIT ?`)
        .all(Math.max(0, Math.floor(limit))) as Record<string, unknown>[];
      return rows.map((row) => rowToClaim(row, cipher));
    },
    byKind(kind) {
      const rows = db
        .prepare(`SELECT * FROM claims WHERE kind = ? ORDER BY confidence DESC`)
        .all(kind) as Record<string, unknown>[];
      return rows.map((row) => rowToClaim(row, cipher));
    },
    findByText(kind, text) {
      const row = byText.get(kind, sensitiveText(text, cipher, "claims.text")) as Record<string, unknown> | undefined;
      return row ? rowToClaim(row, cipher) : undefined;
    },
    remove(id) {
      remove.run(id);
    },
    count() {
      return (counter.get() as { n: number }).n;
    },
  };
}
