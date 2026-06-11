import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Open (and initialize) the Praxis SQLite database.
 *
 * Uses WAL mode for concurrent readers while the capture client writes. Pass
 * ":memory:" for an ephemeral test database (WAL pragmas are skipped there).
 */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);

  if (path !== ":memory:") {
    // WAL lets the Studio UI read while the capture client appends.
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec("PRAGMA foreign_keys = ON;");

  const schema = readFileSync(join(import.meta.dirname, "schema.sql"), "utf8");
  db.exec(schema);
  migrate(db);
  return db;
}

/** Additive, idempotent migrations for databases created before a column existed. */
function migrate(db: DatabaseSync): void {
  const add: Array<[string, string, string]> = [
    ["observations", "options", "TEXT NOT NULL DEFAULT '[]'"],
  ];
  for (const [table, col, def] of add) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    } catch {
      /* column already exists — fine */
    }
  }
}

/** Coerce a JS value into something node:sqlite can bind. */
export function bindable(
  v: unknown,
): string | number | bigint | Uint8Array | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "bigint" ||
    v instanceof Uint8Array
  ) {
    return v;
  }
  // Objects/arrays are stored as JSON text by the calling store.
  return JSON.stringify(v);
}
