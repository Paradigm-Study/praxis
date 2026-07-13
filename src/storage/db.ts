import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const CURRENT_SCHEMA_VERSION = 4;

export interface OpenDbOptions {
  /** Test seam: simulate a migration failure after the named version. */
  failMigrationVersion?: number;
}

/**
 * Open (and initialize) the Praxis SQLite database.
 *
 * Uses WAL mode for concurrent readers while the capture client writes. Pass
 * ":memory:" for an ephemeral test database (WAL pragmas are skipped there).
 */
export function openDb(path: string, opts: OpenDbOptions = {}): DatabaseSync {
  const existedWithData =
    path !== ":memory:" && existsSync(path) && statSync(path).size > 0;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      chmodSync(dirname(path), 0o700);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
  }
  let db = new DatabaseSync(path);

  if (path !== ":memory:") {
    // WAL lets the Studio UI read while the capture client appends.
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    try {
      chmodSync(path, 0o600);
      chmodSync(`${path}-wal`, 0o600);
      chmodSync(`${path}-shm`, 0o600);
    } catch {
      // WAL/SHM may not exist until the first write.
    }
  }
  db.exec("PRAGMA foreign_keys = ON;");

  const schema = readFileSync(join(import.meta.dirname, "schema.sql"), "utf8");
  const current = userVersion(db);
  const snapshot =
    existedWithData && current < CURRENT_SCHEMA_VERSION
      ? createStartupSnapshot(db, path)
      : undefined;
  try {
    db.exec("BEGIN IMMEDIATE;");
    db.exec(schema);
    for (let version = current + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
      applyMigration(db, version);
      if (opts.failMigrationVersion === version) {
        throw new Error(`simulated migration failure at v${version}`);
      }
      db.exec(`PRAGMA user_version = ${version};`);
    }
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // The failing statement may already have ended the transaction.
    }
    db.close();
    if (snapshot && path !== ":memory:") restoreStartupSnapshot(snapshot, path);
    throw error;
  }
  return db;
}

function userVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

/** Ordered, transactional, exact migrations. Never swallows unrelated errors. */
function applyMigration(db: DatabaseSync, version: number): void {
  switch (version) {
    case 1:
      if (!hasColumn(db, "observations", "options")) {
        db.exec("ALTER TABLE observations ADD COLUMN options TEXT NOT NULL DEFAULT '[]';");
      }
      return;
    case 2:
      db.exec("CREATE TABLE IF NOT EXISTS praxis_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
      return;
    case 3:
      if (!hasColumn(db, "claims", "provenance")) {
        db.exec("ALTER TABLE claims ADD COLUMN provenance TEXT;");
      }
      return;
    case 4:
      if (!hasColumn(db, "corrections", "origin")) {
        // Historical rows cannot be proven human-authored because the old MCP
        // tool and Studio shared one shape for claims/observations. The old MCP
        // could not target actions, episodes, or decisions, so those receipts
        // are safely attributable to the authenticated human-facing Studio.
        db.exec(
          "ALTER TABLE corrections ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy';",
        );
        db.exec(
          "UPDATE corrections SET origin = 'human' " +
          "WHERE target_kind IN ('action', 'episode', 'decision');",
        );
      }
      return;
    default:
      throw new Error(`unknown Praxis schema migration v${version}`);
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function createStartupSnapshot(db: DatabaseSync, path: string): string {
  const dir = join(dirname(path), "backups", "startup");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const final = join(dir, `schema-v${userVersion(db)}-${stamp}.sqlite`);
  const tmp = `${final}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  db.exec("PRAGMA wal_checkpoint(FULL);");
  db.exec(`VACUUM INTO ${sqlString(tmp)};`);
  renameSync(tmp, final);
  chmodSync(final, 0o600);
  const snapshots = readdirSync(dir)
    .filter((name) => name.endsWith(".sqlite"))
    .sort()
    .reverse();
  for (const stale of snapshots.slice(5)) rmSync(join(dir, stale), { force: true });
  return final;
}

function restoreStartupSnapshot(snapshot: string, path: string): void {
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  const tmp = `${path}.rollback-${process.pid}`;
  copyFileSync(snapshot, tmp);
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
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
