import type { DatabaseSync } from "node:sqlite";
import type { Observation } from "../core/types.ts";
import { fromJsonArray, sensitiveText, strOrUndef, toJson } from "./rows.ts";
import type { StorageCipher } from "./crypto.ts";

export interface ObservationStore {
  put(o: Observation): void;
  get(id: string): Observation | undefined;
  all(): Observation[];
  byEpisode(episodeId: string): Observation[];
}

function rowToObs(row: Record<string, unknown>, cipher?: StorageCipher): Observation {
  return {
    id: row.id as string,
    bundleId: row.bundle_id as string,
    episodeId: strOrUndef(row.episode_id),
    intent: strOrUndef(row.intent, cipher, "observations.intent"),
    task: strOrUndef(row.task, cipher, "observations.task"),
    decisionPoint: strOrUndef(row.decision_point, cipher, "observations.decision_point"),
    acceptedOptions: fromJsonArray(row.accepted_options, cipher, "observations.accepted_options"),
    rejectedOptions: fromJsonArray(row.rejected_options, cipher, "observations.rejected_options"),
    inferredPreference: strOrUndef(row.inferred_preference, cipher, "observations.inferred_preference"),
    uncertainty: fromJsonArray(row.uncertainty, cipher, "observations.uncertainty"),
    suggestedQuestion: strOrUndef(row.suggested_question, cipher, "observations.suggested_question"),
    options: fromJsonArray(row.options, cipher, "observations.options"),
    evidence: fromJsonArray(row.evidence),
    model: row.model as string,
    createdTs: row.created_ts as string,
  };
}

export function makeObservationStore(db: DatabaseSync, cipher?: StorageCipher): ObservationStore {
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
        sensitiveText(o.intent, cipher, "observations.intent"),
        sensitiveText(o.task, cipher, "observations.task"),
        sensitiveText(o.decisionPoint, cipher, "observations.decision_point"),
        toJson(o.acceptedOptions, cipher, "observations.accepted_options"),
        toJson(o.rejectedOptions, cipher, "observations.rejected_options"),
        sensitiveText(o.inferredPreference, cipher, "observations.inferred_preference"),
        toJson(o.uncertainty, cipher, "observations.uncertainty"),
        sensitiveText(o.suggestedQuestion, cipher, "observations.suggested_question"),
        toJson(o.options ?? [], cipher, "observations.options"),
        toJson(o.evidence),
        o.model,
        o.createdTs,
      );
    },
    get(id) {
      const row = byId.get(id) as Record<string, unknown> | undefined;
      return row ? rowToObs(row, cipher) : undefined;
    },
    all() {
      const rows = db
        .prepare(`SELECT * FROM observations ORDER BY created_ts ASC`)
        .all() as Record<string, unknown>[];
      return rows.map((row) => rowToObs(row, cipher));
    },
    byEpisode(episodeId) {
      const rows = byEp.all(episodeId) as Record<string, unknown>[];
      return rows.map((row) => rowToObs(row, cipher));
    },
  };
}
