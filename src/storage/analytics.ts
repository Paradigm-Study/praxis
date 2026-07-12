import type { DatabaseSync } from "node:sqlite";
import { logger } from "../core/log.ts";
import type { StorageCipher } from "./crypto.ts";

const log = logger("analytics");

/**
 * Layer 2 analytical rollups over days/weeks.
 *
 * The design calls for DuckDB here. DuckDB is an optional accelerator: if the
 * `duckdb` package is installed we can attach it over the same data for fast
 * columnar scans, but the rollups below are implemented against SQLite so they
 * run today with zero dependencies. {@link attachDuckDB} reports whether the
 * accelerator is available.
 */
export interface Analytics {
  eventsPerDay(): Array<{ day: string; count: number }>;
  timePerApp(): Array<{ app: string; events: number }>;
  actionTypeDistribution(): Array<{ action: string; count: number }>;
  episodesPerDay(): Array<{ day: string; count: number }>;
  /** True if a DuckDB accelerator is attached (else SQLite is used directly). */
  duckdbAvailable: boolean;
}

export async function attachDuckDB(): Promise<boolean> {
  try {
    // Dynamic, optional. Absent in the zero-dep default install. The specifier
    // is held in a variable so the typechecker doesn't require the module.
    const mod = "duckdb";
    await import(mod);
    log.info("DuckDB available — analytical queries can be accelerated");
    return true;
  } catch {
    log.debug("DuckDB not installed; using SQLite for analytics");
    return false;
  }
}

export function makeAnalytics(
  db: DatabaseSync,
  duckdbAvailable = false,
  cipher?: StorageCipher,
): Analytics {
  return {
    duckdbAvailable,
    eventsPerDay() {
      return db
        .prepare(
          `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS count
             FROM raw_events GROUP BY day ORDER BY day`,
        )
        .all() as Array<{ day: string; count: number }>;
    },
    timePerApp() {
      const rows = db
        .prepare(
          `SELECT app, COUNT(*) AS events
             FROM raw_events GROUP BY app ORDER BY events DESC`,
        )
        .all() as Array<{ app: string; events: number }>;
      return rows.map((row) => ({
        ...row,
        app: cipher?.decryptText(row.app, "raw_events.app") ?? row.app,
      }));
    },
    actionTypeDistribution() {
      return db
        .prepare(
          `SELECT action_type AS action, COUNT(*) AS count
             FROM action_events GROUP BY action_type ORDER BY count DESC`,
        )
        .all() as Array<{ action: string; count: number }>;
    },
    episodesPerDay() {
      return db
        .prepare(
          `SELECT substr(start_ts, 1, 10) AS day, COUNT(*) AS count
             FROM episodes GROUP BY day ORDER BY day`,
        )
        .all() as Array<{ day: string; count: number }>;
    },
  };
}
