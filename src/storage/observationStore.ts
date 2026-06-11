import type { DatabaseSync } from "node:sqlite";
import type { Observation } from "../core/types.ts";
import { fromJsonArray, strOrUndef, toJson } from "./rows.ts";

export interface ObservationStore {
  put(o: Observation): void;
  get(id: string): Observation | undefined;
  all(): Observation[];
  byEpisode(episodeId: string): Observation[];
}

function rowToObs(row: Record<string, unknown>): Observation {
  return {
    id: row.id as string,
    bundleId: row.bundle_id as string,
    episodeId: strOrUndef(row.episode_id),
    intent: strOrUndef(row.intent),
    task: strOrUndef(row.task),
    decisionPoint: strOrUndef(row.decision_point),
    acceptedOptions: fromJsonArray(row.accepted_options),
    rejectedOptions: fromJsonArray(row.rejected_options),
    inferredPreference: strOrUndef(row.inferred_preference),
    uncertainty: fromJsonArray(row.uncertainty),
    suggestedQuestion: strOrUndef(row.suggested_question),
    options: fromJsonArray(row.options),
    evidence: fromJsonArray(row.evidence),
    model: row.model as string,
    createdTs: row.created_ts as string,
  };
}

export function makeObservationStore(db: DatabaseSync): ObservationStore {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO observations
       (id, bundle_id, episode_id, intent, task, decision_point,
        accepted_options, rejected_options, inferred_preference, uncertainty,
        suggested_question, options, evidence, model, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare(`SELECT * FROM observations WHERE id = ?`);
  const byEp = db.prepare(
    `SELECT * FROM observations WHERE episode_id = ? ORDER BY created_ts ASC`,
  );

  return {
    put(o) {
      insert.run(
        o.id,
        o.bundleId,
        o.episodeId ?? null,
        o.intent ?? null,
        o.task ?? null,
        o.decisionPoint ?? null,
        toJson(o.acceptedOptions),
        toJson(o.rejectedOptions),
        o.inferredPreference ?? null,
        toJson(o.uncertainty),
        o.suggestedQuestion ?? null,
        toJson(o.options ?? []),
        toJson(o.evidence),
        o.model,
        o.createdTs,
      );
    },
    get(id) {
      const row = byId.get(id) as Record<string, unknown> | undefined;
      return row ? rowToObs(row) : undefined;
    },
    all() {
      const rows = db
        .prepare(`SELECT * FROM observations ORDER BY created_ts ASC`)
        .all() as Record<string, unknown>[];
      return rows.map(rowToObs);
    },
    byEpisode(episodeId) {
      const rows = byEp.all(episodeId) as Record<string, unknown>[];
      return rows.map(rowToObs);
    },
  };
}
