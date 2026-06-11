import type { DatabaseSync } from "node:sqlite";
import type { StoredDecision } from "../core/types.ts";
import { fromJsonArray, strOrUndef, toJson } from "./rows.ts";

export interface DecisionStore {
  put(d: StoredDecision): void;
  recent(n?: number): StoredDecision[];
  maxRowid(): number;
  sinceRowid(rowid: number, limit?: number): { maxRowid: number; decisions: StoredDecision[] };
}

function rowToDecision(row: Record<string, unknown>): StoredDecision {
  return {
    id: row.id as string,
    kind: row.kind as string,
    reason: row.reason as string,
    question: strOrUndef(row.question),
    evidence: fromJsonArray(row.evidence),
    observationId: strOrUndef(row.observation_id),
    claimId: strOrUndef(row.claim_id),
    createdTs: row.created_ts as string,
  };
}

export function makeDecisionStore(db: DatabaseSync): DecisionStore {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO decisions
       (id, kind, reason, question, evidence, observation_id, claim_id, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    put(d) {
      insert.run(
        d.id,
        d.kind,
        d.reason,
        d.question ?? null,
        toJson(d.evidence),
        d.observationId ?? null,
        d.claimId ?? null,
        d.createdTs,
      );
    },
    recent(n = 50) {
      const rows = db
        .prepare(`SELECT * FROM decisions ORDER BY created_ts DESC LIMIT ?`)
        .all(Math.floor(n)) as Record<string, unknown>[];
      return rows.map(rowToDecision);
    },
    maxRowid() {
      const row = db.prepare(`SELECT MAX(rowid) AS m FROM decisions`).get() as {
        m: number | null;
      };
      return row.m ?? 0;
    },
    sinceRowid(rowid, limit = 100) {
      const rows = db
        .prepare(
          `SELECT rowid AS _rid, * FROM decisions WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`,
        )
        .all(rowid, Math.floor(limit)) as Array<Record<string, unknown>>;
      let max = rowid;
      const decisions = rows.map((r) => {
        max = Math.max(max, Number(r._rid));
        return rowToDecision(r);
      });
      return { maxRowid: max, decisions };
    },
  };
}
