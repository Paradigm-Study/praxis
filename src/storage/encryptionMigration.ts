import type { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { StorageCipher } from "./crypto.ts";
import { keyringPath } from "./crypto.ts";

export const SENSITIVE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["raw_events", "app"],
  ["raw_events", "window"],
  ["raw_events", "payload_json"],
  ["action_events", "app"],
  ["action_events", "window"],
  ["action_events", "text"],
  ["action_events", "uncertainty"],
  ["action_events", "payload_json"],
  ["episodes", "summary"],
  ["episodes", "goal"],
  ["episodes", "artifacts"],
  ["episodes", "decision_points"],
  ["episodes", "rejected_paths"],
  ["episodes", "uncertainty"],
  ["episodes", "payload_json"],
  ["claims", "text"],
  ["graph_nodes", "label"],
  ["graph_nodes", "data_json"],
  ["graph_edges", "data_json"],
  ["observations", "intent"],
  ["observations", "task"],
  ["observations", "decision_point"],
  ["observations", "accepted_options"],
  ["observations", "rejected_options"],
  ["observations", "inferred_preference"],
  ["observations", "uncertainty"],
  ["observations", "suggested_question"],
  ["observations", "options"],
  ["decisions", "reason"],
  ["decisions", "question"],
  ["corrections", "corrected_text"],
  ["corrections", "note"],
] as const;

export interface EncryptionMigrationOptions {
  /** Test seams for atomic rollback. */
  failAfterBlobs?: number;
  failAfterRows?: number;
}

export interface EncryptionMigrationResult {
  fromVersion: number;
  toVersion: number;
  rows: number;
  blobs: number;
  backupPath?: string;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM praxis_meta WHERE key = 'encryption_version'").get() as
    | { value: string }
    | undefined;
  return Number(row?.value ?? 0);
}

function needsMigration(db: DatabaseSync, cipher: StorageCipher): boolean {
  if (currentVersion(db) !== cipher.activeVersion) return true;
  for (const [table, column] of SENSITIVE_COLUMNS) {
    const row = db.prepare(
      `SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL ` +
        `AND ${column} NOT LIKE 'enc:v${cipher.activeVersion}:%' LIMIT 1`,
    ).get() as
      | { value: string }
      | undefined;
    if (row) return true;
  }
  const blobs = db.prepare("SELECT hash, path FROM blobs").all() as Array<{ hash: string; path: string }>;
  return blobs.some((row) => {
    try {
      return cipher.bytesVersion(readFileSync(row.path)) !== cipher.activeVersion;
    } catch {
      return false; // Doctor reports missing/unreadable referenced bytes.
    }
  });
}

function hasPersistedContent(db: DatabaseSync): boolean {
  for (const table of ["raw_events", "action_events", "episodes", "claims", "blobs"]) {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    if (Number(count.n) > 0) return true;
  }
  return false;
}

function createRecoverySnapshot(
  db: DatabaseSync,
  baseDir: string,
  blobDir: string,
  fromVersion: number,
  toVersion: number,
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const final = join(baseDir, "backups", "migrations", `encryption-v${fromVersion}-to-v${toVersion}-${stamp}`);
  const stage = `${final}.tmp-${process.pid}`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const dbPath = join(stage, "praxis.db");
  db.exec("PRAGMA wal_checkpoint(FULL);");
  db.exec(`VACUUM INTO ${sqlString(dbPath)};`);
  chmodSync(dbPath, 0o600);
  if (existsSync(blobDir)) cpSync(blobDir, join(stage, "blobs"), { recursive: true });
  const keys = keyringPath(baseDir);
  if (existsSync(keys)) copyFileSync(keys, join(stage, "master-keys.json"));
  renameSync(stage, final);
  return final;
}

function restoreBlobSnapshot(backup: string | undefined, blobDir: string): void {
  if (!backup) return;
  const snapshot = join(backup, "blobs");
  rmSync(blobDir, { recursive: true, force: true });
  if (existsSync(snapshot)) cpSync(snapshot, blobDir, { recursive: true });
  else mkdirSync(blobDir, { recursive: true, mode: 0o700 });
}

/** Encrypt legacy plaintext or rotate older envelopes, with DB/blob rollback. */
export function migrateEncryptedContent(
  db: DatabaseSync,
  blobDir: string,
  baseDir: string,
  cipher: StorageCipher,
  opts: EncryptionMigrationOptions = {},
): EncryptionMigrationResult {
  const fromVersion = currentVersion(db);
  if (!needsMigration(db, cipher)) {
    return { fromVersion, toVersion: cipher.activeVersion, rows: 0, blobs: 0 };
  }
  const backupPath = hasPersistedContent(db)
    ? createRecoverySnapshot(db, baseDir, blobDir, fromVersion, cipher.activeVersion)
    : undefined;
  let rowsMigrated = 0;
  let blobsMigrated = 0;
  try {
    const blobRows = db.prepare("SELECT hash, path FROM blobs").all() as Array<{
      hash: string;
      path: string;
    }>;
    const root = `${resolve(blobDir)}/`;
    for (const row of blobRows) {
      const path = resolve(row.path);
      if (!path.startsWith(root)) throw new Error(`blob path escapes store: ${row.path}`);
      if (!existsSync(path)) continue; // Doctor reports the missing referenced bytes.
      const persisted = readFileSync(path);
      if (cipher.bytesVersion(persisted) === cipher.activeVersion) continue;
      const plaintext = cipher.decryptBytes(persisted, `blob:${row.hash}`);
      const next = cipher.encryptBytes(plaintext, `blob:${row.hash}`);
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, next, { mode: 0o600 });
      renameSync(tmp, path);
      blobsMigrated += 1;
      if (opts.failAfterBlobs === blobsMigrated) throw new Error("simulated encryption blob failure");
    }

    db.exec("BEGIN IMMEDIATE;");
    for (const [table, column] of SENSITIVE_COLUMNS) {
      const context = `${table}.${column}`;
      const selected = db
        .prepare(`SELECT rowid AS rid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`)
        .all() as Array<{ rid: number; value: string }>;
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const row of selected) {
        if (cipher.textVersion(row.value) === cipher.activeVersion) continue;
        const plaintext = cipher.decryptText(row.value, context);
        if (plaintext === undefined) continue;
        update.run(cipher.encryptText(plaintext, context), row.rid);
        rowsMigrated += 1;
        if (opts.failAfterRows === rowsMigrated) throw new Error("simulated encryption row failure");
      }
    }
    db.prepare(
      "INSERT INTO praxis_meta(key, value) VALUES('encryption_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(cipher.activeVersion));
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // No active transaction if a blob failed before BEGIN.
    }
    restoreBlobSnapshot(backupPath, blobDir);
    throw error;
  }
  return {
    fromVersion,
    toVersion: cipher.activeVersion,
    rows: rowsMigrated,
    blobs: blobsMigrated,
    ...(backupPath ? { backupPath } : {}),
  };
}

/** Delete abandoned atomic-write artifacts after a crash; never touches live files. */
export function cleanupCrashArtifacts(baseDir: string, olderThanMs = 60 * 60_000): number {
  let removed = 0;
  const cutoff = Date.now() - olderThanMs;
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "backups") continue;
        walk(path);
      } else if ((entry.name.includes(".tmp-") || entry.name.includes(".rollback-"))) {
        try {
          const { mtimeMs } = statSync(path);
          if (mtimeMs < cutoff) {
            rmSync(path, { force: true });
            removed += 1;
          }
        } catch {
          // Raced with another cleanup.
        }
      }
    }
  };
  walk(baseDir);
  return removed;
}
