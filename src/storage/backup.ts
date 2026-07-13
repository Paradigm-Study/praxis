import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sha256 } from "../core/hash.ts";
import type { Store } from "./index.ts";
import { CURRENT_SCHEMA_VERSION } from "./db.ts";
import { keyringPath, loadStorageKeyring, type MasterKeyringFile } from "./crypto.ts";

export interface BackupFileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: 1;
  createdAt: string;
  schemaVersion: number;
  encryptionKeyVersions: number[];
  encryptionKeyFingerprints: Record<string, string>;
  activeEncryptionVersion: number;
  /** Keys are excluded: this is rollback for the same install/keyring only. */
  recoveryScope: "same_install";
  files: BackupFileRecord[];
}

export interface BackupVerification {
  ok: boolean;
  manifest?: BackupManifest;
  errors: string[];
}

const AUXILIARY_FILES = [
  "privacy.json",
  "retention.json",
  "egress.ndjson",
  "mesh-outbox-spool.ndjson",
  "dispatches.ndjson",
  "notifications.ndjson",
] as const;

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name !== "manifest.json") out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

function checksumFile(path: string): string {
  const hash = createHash("sha256");
  const handle = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(handle, chunk, 0, chunk.length, null);
      if (bytes === 0) break;
      hash.update(chunk.subarray(0, bytes));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

function makeManifest(
  root: string,
  schemaVersion: number,
  keyVersions: number[],
  activeVersion: number,
  keyFingerprints: Record<string, string>,
): BackupManifest {
  return {
    format: 1,
    createdAt: new Date().toISOString(),
    schemaVersion,
    encryptionKeyVersions: [...keyVersions].sort((a, b) => a - b),
    encryptionKeyFingerprints: { ...keyFingerprints },
    activeEncryptionVersion: activeVersion,
    recoveryScope: "same_install",
    files: filesUnder(root).map((path) => {
      const bytes = statSync(path).size;
      return {
        path: relative(root, path).split("\\").join("/"),
        bytes,
        sha256: checksumFile(path),
      };
    }),
  };
}

function writeManifest(root: string, manifest: BackupManifest): void {
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function copyAuxiliary(base: string, stage: string): void {
  for (const name of AUXILIARY_FILES) {
    const source = join(base, name);
    if (existsSync(source)) copyFileSync(source, join(stage, name));
  }
}

function finalize(stage: string, output: string, manifest: BackupManifest): string {
  writeManifest(stage, manifest);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  if (existsSync(output)) throw new Error(`backup destination already exists: ${output}`);
  renameSync(stage, output);
  return output;
}

/**
 * Consistent SQLite + encrypted-blob rollback snapshot. Master keys are
 * deliberately excluded, so it is recoverable only while the same install's
 * keyring is retained; this must not be presented as a portable export.
 */
export function createBackup(store: Store, output?: string): string {
  if (store.paths.db === ":memory:") throw new Error("cannot back up an in-memory Praxis store");
  const base = dirname(store.paths.db);
  const destination = output ?? join(base, "backups", `praxis-${stamp()}.praxisbackup`);
  const stage = `${destination}.tmp-${process.pid}`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    const dbOut = join(stage, "praxis.db");
    store.db.exec("PRAGMA wal_checkpoint(FULL);");
    store.db.exec(`VACUUM INTO ${sqlString(dbOut)};`);
    chmodSync(dbOut, 0o600);
    if (existsSync(store.paths.blobs)) cpSync(store.paths.blobs, join(stage, "blobs"), { recursive: true });
    copyAuxiliary(base, stage);
    const schemaVersion = Number(
      (store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
    return finalize(
      stage,
      destination,
      makeManifest(
        stage,
        schemaVersion,
        store.encryption.keyVersions,
        store.encryption.activeVersion,
        store.encryption.keyFingerprints,
      ),
    );
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

export function verifyBackup(path: string): BackupVerification {
  const errors: string[] = [];
  let manifest: BackupManifest | undefined;
  try {
    manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")) as BackupManifest;
    if (manifest.format !== 1 || !Array.isArray(manifest.files)) {
      throw new Error("unsupported backup manifest");
    }
    if (manifest.recoveryScope !== "same_install") {
      errors.push("unsupported or missing recovery scope");
    }
  } catch (error) {
    return { ok: false, errors: [`manifest: ${String(error)}`] };
  }
  for (const file of manifest.files) {
    if (
      isAbsolute(file.path) ||
      !resolve(join(path, file.path)).startsWith(`${resolve(path)}/`)
    ) {
      errors.push(`unsafe path ${file.path}`);
      continue;
    }
    const full = join(path, file.path);
    if (!existsSync(full)) {
      errors.push(`missing ${file.path}`);
      continue;
    }
    if (statSync(full).size !== file.bytes) errors.push(`size mismatch ${file.path}`);
    if (checksumFile(full) !== file.sha256) errors.push(`checksum mismatch ${file.path}`);
  }
  if (!manifest.files.some((file) => file.path === "praxis.db")) errors.push("missing database record");
  return { ok: errors.length === 0, manifest, errors };
}

function readKeyVersions(base: string): {
  versions: number[];
  active: number;
  fingerprints: Record<string, string>;
} {
  if (process.env.PRAXIS_DATA_KEY_FILE) {
    const keyring = loadStorageKeyring(base);
    return {
      versions: Object.keys(keyring.keys).map(Number),
      active: keyring.activeVersion,
      fingerprints: Object.fromEntries(
        Object.entries(keyring.keys).map(([version, encoded]) => [
          version,
          sha256(Buffer.from(encoded, "base64")),
        ]),
      ),
    };
  }
  const path = keyringPath(base);
  if (!existsSync(path)) return { versions: [], active: 0, fingerprints: {} };
  const keyring = JSON.parse(readFileSync(path, "utf8")) as MasterKeyringFile;
  return {
    versions: Object.keys(keyring.keys).map(Number),
    active: keyring.activeVersion,
    fingerprints: Object.fromEntries(
      Object.entries(keyring.keys).map(([version, encoded]) => [
        version,
        sha256(Buffer.from(encoded, "base64")),
      ]),
    ),
  };
}

function quickCheck(dbPath: string): void {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const result = db.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    if (result.length !== 1 || result[0]?.quick_check !== "ok") {
      throw new Error(`SQLite quick_check failed: ${JSON.stringify(result)}`);
    }
  } finally {
    db.close();
  }
}

function createPreRestoreBackup(base: string, output: string): string {
  const dbPath = join(base, "praxis.db");
  if (!existsSync(dbPath)) throw new Error("target Praxis database does not exist");
  const stage = `${output}.tmp-${process.pid}`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  let schemaVersion = 0;
  try {
    db.exec("PRAGMA wal_checkpoint(FULL);");
    db.exec(`VACUUM INTO ${sqlString(join(stage, "praxis.db"))};`);
    schemaVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  } finally {
    db.close();
  }
  const blobs = join(base, "blobs");
  if (existsSync(blobs)) cpSync(blobs, join(stage, "blobs"), { recursive: true });
  copyAuxiliary(base, stage);
  const keys = readKeyVersions(base);
  return finalize(
    stage,
    output,
    makeManifest(stage, schemaVersion, keys.versions, keys.active, keys.fingerprints),
  );
}

export interface RestoreResult {
  restoredFrom: string;
  preRestoreBackup: string;
  schemaVersion: number;
}

/** Verify, pre-backup, stage, and atomically swap a complete store directory. */
export function restoreBackup(
  backup: string,
  targetDir: string,
  opts: { failAfterSwap?: boolean } = {},
): RestoreResult {
  const verification = verifyBackup(backup);
  if (!verification.ok || !verification.manifest) {
    throw new Error(`backup verification failed: ${verification.errors.join("; ")}`);
  }
  const manifest = verification.manifest;
  if (manifest.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`backup schema v${manifest.schemaVersion} is newer than supported v${CURRENT_SCHEMA_VERSION}`);
  }
  const localKeys = readKeyVersions(targetDir);
  const available = new Set(localKeys.versions);
  const missing = manifest.encryptionKeyVersions.filter((version) => !available.has(version));
  if (missing.length > 0) throw new Error(`missing local master key version(s): ${missing.join(", ")}`);
  for (const version of manifest.encryptionKeyVersions) {
    const expected = manifest.encryptionKeyFingerprints?.[String(version)];
    if (expected && localKeys.fingerprints[String(version)] !== expected) {
      throw new Error(`local master key v${version} does not match this backup`);
    }
  }

  quickCheck(join(backup, "praxis.db"));
  const parent = dirname(targetDir);
  const baseName = basename(targetDir);
  const preRestore = join(parent, `${baseName}.pre-restore-${stamp()}.praxisbackup`);
  createPreRestoreBackup(targetDir, preRestore);

  const stage = join(parent, `.${baseName}.restore-stage-${process.pid}-${Date.now()}`);
  const rollback = join(parent, `.${baseName}.restore-rollback-${process.pid}-${Date.now()}`);
  rmSync(stage, { recursive: true, force: true });
  rmSync(rollback, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    for (const file of manifest.files) {
      const source = join(backup, file.path);
      const destination = join(stage, file.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(source, destination);
    }
    // Keys never travel in a backup. Preserve the target machine's keyring.
    const keys = join(targetDir, "keys");
    if (existsSync(keys)) cpSync(keys, join(stage, "keys"), { recursive: true });
    // Preserve prior backup history and logs without letting them affect restore content.
    for (const preserved of ["backups", "logs"] as const) {
      const source = join(targetDir, preserved);
      if (existsSync(source)) cpSync(source, join(stage, preserved), { recursive: true });
    }
    quickCheck(join(stage, "praxis.db"));
    renameSync(targetDir, rollback);
    try {
      renameSync(stage, targetDir);
      if (opts.failAfterSwap) throw new Error("simulated post-swap restore failure");
      quickCheck(join(targetDir, "praxis.db"));
    } catch (error) {
      rmSync(targetDir, { recursive: true, force: true });
      renameSync(rollback, targetDir);
      throw error;
    }
    rmSync(rollback, { recursive: true, force: true });
    return {
      restoredFrom: backup,
      preRestoreBackup: preRestore,
      schemaVersion: manifest.schemaVersion,
    };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (existsSync(rollback) && !existsSync(targetDir)) renameSync(rollback, targetDir);
    throw error;
  }
}
