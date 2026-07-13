import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
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

const AUXILIARY_FILE_SET = new Set<string>(AUXILIARY_FILES);
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_BACKUP_ENTRIES = 100_000;
const MAX_BACKUP_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_BACKUP_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_BACKUP_PATH_BYTES = 1024;

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
      else if (entry.isFile() && entry.name !== "manifest.json") out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

function isAuxiliaryFileName(name: string): boolean {
  return AUXILIARY_FILE_SET.has(name) || /^mesh-outbox-spool-[a-f0-9]{16}\.ndjson$/.test(name);
}

function inspectRegularFile(path: string, expectedBytes?: number): { bytes: number; sha256: string } {
  const hash = createHash("sha256");
  const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    const stats = fstatSync(handle);
    if (!stats.isFile()) throw new Error(`not a regular file: ${path}`);
    if (stats.size > MAX_BACKUP_FILE_BYTES) throw new Error(`file exceeds backup size limit: ${path}`);
    if (expectedBytes !== undefined && stats.size !== expectedBytes) {
      throw new Error(`file size changed: ${path}`);
    }
    bytes = stats.size;
    let remaining = stats.size;
    while (remaining > 0) {
      const bytes = readSync(handle, chunk, 0, Math.min(chunk.length, remaining), null);
      if (bytes === 0) throw new Error(`file truncated while reading: ${path}`);
      hash.update(chunk.subarray(0, bytes));
      remaining -= bytes;
    }
    if (fstatSync(handle).size !== stats.size) throw new Error(`file size changed: ${path}`);
  } finally {
    closeSync(handle);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function copyRegularFileNoFollow(source: string, destination: string, expectedBytes?: number): void {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    const stats = fstatSync(input);
    if (!stats.isFile()) throw new Error(`not a regular file: ${source}`);
    if (stats.size > MAX_BACKUP_FILE_BYTES || (expectedBytes !== undefined && stats.size !== expectedBytes)) {
      throw new Error(`source file has an unsafe or changed size: ${source}`);
    }
    output = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let remaining = stats.size;
    while (remaining > 0) {
      const bytes = readSync(input, chunk, 0, Math.min(chunk.length, remaining), null);
      if (bytes === 0) throw new Error(`source file truncated while copying: ${source}`);
      let written = 0;
      while (written < bytes) {
        written += writeSync(output, chunk, written, bytes - written);
      }
      remaining -= bytes;
    }
    if (fstatSync(input).size < stats.size) throw new Error(`source file truncated while copying: ${source}`);
    fsyncSync(output);
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(input);
  }
}

function makeManifest(
  root: string,
  schemaVersion: number,
  keyVersions: number[],
  activeVersion: number,
  keyFingerprints: Record<string, string>,
): BackupManifest {
  const paths = filesUnder(root);
  if (paths.length > MAX_BACKUP_ENTRIES) throw new Error("backup contains too many files");
  let totalBytes = 0;
  const files = paths.map((path) => {
    const inspected = inspectRegularFile(path);
    if (inspected.bytes > MAX_BACKUP_FILE_BYTES) {
      throw new Error(`backup file exceeds size limit: ${path}`);
    }
    totalBytes += inspected.bytes;
    if (totalBytes > MAX_BACKUP_TOTAL_BYTES) throw new Error("backup exceeds total size limit");
    return {
      path: relative(root, path).split("\\").join("/"),
      bytes: inspected.bytes,
      sha256: inspected.sha256,
    };
  });
  return {
    format: 1,
    createdAt: new Date().toISOString(),
    schemaVersion,
    encryptionKeyVersions: [...keyVersions].sort((a, b) => a - b),
    encryptionKeyFingerprints: { ...keyFingerprints },
    activeEncryptionVersion: activeVersion,
    recoveryScope: "same_install",
    files,
  };
}

function writeManifest(root: string, manifest: BackupManifest): void {
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES) throw new Error("backup manifest exceeds size limit");
  const handle = openSync(
    join(root, "manifest.json"),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(handle, serialized, { encoding: "utf8" });
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function copyAuxiliary(base: string, stage: string): void {
  for (const name of readdirSync(base).filter(isAuxiliaryFileName)) {
    const source = join(base, name);
    if (!existsSync(source)) continue;
    const stats = lstatSync(source);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`unsupported auxiliary backup entry: ${source}`);
    }
    copyRegularFileNoFollow(source, join(stage, name), stats.size);
  }
}

function copyBlobTree(source: string, destination: string): void {
  const stats = lstatSync(source);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`blob store entry must be a real directory: ${source}`);
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyBlobTree(from, to);
    else if (entry.isFile()) copyRegularFileNoFollow(from, to);
    else throw new Error(`unsupported live blob entry: ${from}`);
  }
}

function fsyncDirectory(path: string): void {
  try {
    const handle = openSync(path, constants.O_RDONLY);
    try { fsyncSync(handle); } finally { closeSync(handle); }
  } catch {
    // Best effort for filesystems that do not expose directory fsync.
  }
}

function fsyncTree(root: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      fsyncTree(path);
    } else if (entry.isFile()) {
      const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(handle); } finally { closeSync(handle); }
    } else {
      throw new Error(`unsupported staged restore entry: ${path}`);
    }
  }
  fsyncDirectory(root);
}

function canonicalPathAllowMissing(value: string): string {
  const suffix: string[] = [];
  let cursor = resolve(value);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync.native(cursor), ...suffix);
}

function pathIsAtOrInside(candidate: string, root: string): boolean {
  const within = relative(root, candidate);
  return within === ""
    || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within));
}

function finalize(stage: string, output: string, manifest: BackupManifest): string {
  writeManifest(stage, manifest);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  if (existsSync(output)) throw new Error(`backup destination already exists: ${output}`);
  fsyncTree(stage);
  renameSync(stage, output);
  fsyncDirectory(dirname(output));
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
  const blobRoot = canonicalPathAllowMissing(store.paths.blobs);
  if (
    pathIsAtOrInside(canonicalPathAllowMissing(destination), blobRoot)
    || pathIsAtOrInside(canonicalPathAllowMissing(stage), blobRoot)
  ) {
    throw new Error("backup destination must not be inside the live blob store");
  }
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    const dbOut = join(stage, "praxis.db");
    store.db.exec("PRAGMA wal_checkpoint(FULL);");
    store.db.exec(`VACUUM INTO ${sqlString(dbOut)};`);
    chmodSync(dbOut, 0o600);
    if (existsSync(store.paths.blobs)) copyBlobTree(store.paths.blobs, join(stage, "blobs"));
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

function normalizedBackupPath(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || value === ""
    || value.includes("\0")
    || value.includes("\\")
    || Buffer.byteLength(value) > MAX_BACKUP_PATH_BYTES
    || posix.isAbsolute(value)
  ) {
    return undefined;
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || value.endsWith("/")) return undefined;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return value;
}

function backupPathIsAllowed(path: string): boolean {
  return path === "praxis.db"
    || isAuxiliaryFileName(path)
    || (path.startsWith("blobs/") && path.length > "blobs/".length);
}

function regularFileWithin(root: string, relativePath: string): string | undefined {
  let current = root;
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      return undefined;
    }
    if (stats.isSymbolicLink()) return undefined;
    if (index === parts.length - 1) {
      if (!stats.isFile()) return undefined;
    } else if (!stats.isDirectory()) {
      return undefined;
    }
  }
  return current;
}

function readManifest(path: string): BackupManifest {
  const rootStats = lstatSync(path);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("backup root must be a real directory");
  }
  const manifestPath = regularFileWithin(path, "manifest.json");
  if (!manifestPath) throw new Error("manifest must be a regular file");
  const stats = lstatSync(manifestPath);
  if (stats.size > MAX_MANIFEST_BYTES) throw new Error("manifest is too large");
  const handle = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(handle);
    if (!opened.isFile() || opened.size > MAX_MANIFEST_BYTES) {
      throw new Error("manifest is not a bounded regular file");
    }
    return JSON.parse(readFileSync(handle, "utf8")) as BackupManifest;
  } finally {
    closeSync(handle);
  }
}

export function verifyBackup(path: string): BackupVerification {
  const errors: string[] = [];
  let manifest: BackupManifest | undefined;
  try {
    manifest = readManifest(path);
    if (manifest.format !== 1 || !Array.isArray(manifest.files)) {
      throw new Error("unsupported backup manifest");
    }
    if (!Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 0) {
      errors.push("invalid schema version");
    }
    const versions = Array.isArray(manifest.encryptionKeyVersions)
      ? manifest.encryptionKeyVersions
      : [];
    if (
      !Array.isArray(manifest.encryptionKeyVersions)
      || !versions.every((version) => Number.isSafeInteger(version) && version >= 1)
      || versions.length > 128
      || new Set(versions).size !== versions.length
    ) {
      errors.push("invalid encryption key versions");
    }
    if (
      typeof manifest.encryptionKeyFingerprints !== "object"
      || manifest.encryptionKeyFingerprints === null
      || Array.isArray(manifest.encryptionKeyFingerprints)
    ) {
      errors.push("invalid encryption key fingerprints");
    }
    if (
      !Number.isSafeInteger(manifest.activeEncryptionVersion)
      || (versions.length === 0
        ? manifest.activeEncryptionVersion !== 0
        : !versions.includes(manifest.activeEncryptionVersion))
    ) {
      errors.push("invalid active encryption version");
    }
    if (typeof manifest.encryptionKeyFingerprints === "object" && manifest.encryptionKeyFingerprints !== null) {
      const fingerprints = manifest.encryptionKeyFingerprints as Record<string, unknown>;
      const expectedKeys = versions.map(String).sort();
      const actualKeys = Object.keys(fingerprints).sort();
      if (
        JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
        || expectedKeys.some((version) => !/^[a-f0-9]{64}$/.test(String(fingerprints[version] ?? "")))
      ) errors.push("invalid encryption key fingerprints");
    }
    if (manifest.recoveryScope !== "same_install") {
      errors.push("unsupported or missing recovery scope");
    }
  } catch (error) {
    return { ok: false, errors: [`manifest: ${String(error)}`] };
  }
  if (manifest.files.length > MAX_BACKUP_ENTRIES) {
    errors.push(`too many backup entries (${manifest.files.length})`);
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  for (const rawFile of manifest.files.slice(0, MAX_BACKUP_ENTRIES)) {
    if (typeof rawFile !== "object" || rawFile === null || Array.isArray(rawFile)) {
      errors.push("invalid file record");
      continue;
    }
    const file = rawFile as BackupFileRecord;
    const safePath = normalizedBackupPath(file.path);
    if (!safePath || !backupPathIsAllowed(safePath)) {
      errors.push(`unsafe or unsupported path ${String(file.path)}`);
      continue;
    }
    if (seen.has(safePath)) {
      errors.push(`duplicate path ${safePath}`);
      continue;
    }
    seen.add(safePath);
    if (
      !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || file.bytes > MAX_BACKUP_FILE_BYTES
    ) {
      errors.push(`invalid size ${safePath}`);
      continue;
    }
    totalBytes += file.bytes;
    if (totalBytes > MAX_BACKUP_TOTAL_BYTES) {
      errors.push("backup exceeds total size limit");
      break;
    }
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      errors.push(`invalid checksum ${safePath}`);
      continue;
    }
    const full = regularFileWithin(path, safePath);
    if (!full) {
      errors.push(`missing ${file.path}`);
      continue;
    }
    try {
      const inspected = inspectRegularFile(full, file.bytes);
      if (inspected.sha256 !== file.sha256) errors.push(`checksum mismatch ${safePath}`);
    } catch (error) {
      errors.push(`unreadable ${safePath}: ${String(error)}`);
    }
  }
  if (!seen.has("praxis.db")) errors.push("missing database record");
  const database = regularFileWithin(path, "praxis.db");
  if (database) {
    try {
      const actualSchemaVersion = quickCheck(database);
      if (actualSchemaVersion !== manifest.schemaVersion) {
        errors.push(
          `database schema v${actualSchemaVersion} does not match manifest v${manifest.schemaVersion}`,
        );
      }
    } catch (error) {
      errors.push(`database integrity check failed: ${String(error)}`);
    }
  }
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

function quickCheck(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const result = db.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    if (result.length !== 1 || result[0]?.quick_check !== "ok") {
      throw new Error(`SQLite quick_check failed: ${JSON.stringify(result)}`);
    }
    return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
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
  if (existsSync(blobs)) copyBlobTree(blobs, join(stage, "blobs"));
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
      const source = regularFileWithin(backup, file.path);
      if (!source) throw new Error(`backup file changed after verification: ${file.path}`);
      const destination = join(stage, file.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyRegularFileNoFollow(source, destination, file.bytes);
      const copied = inspectRegularFile(destination);
      if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) {
        throw new Error(`backup file changed during restore: ${file.path}`);
      }
    }
    // Keys never travel in a backup. Preserve the target machine's keyring.
    const keys = join(targetDir, "keys");
    if (existsSync(keys)) cpSync(keys, join(stage, "keys"), { recursive: true });
    // Preserve prior backup history and logs without letting them affect restore content.
    for (const preserved of ["backups", "logs"] as const) {
      const source = join(targetDir, preserved);
      if (existsSync(source)) cpSync(source, join(stage, preserved), { recursive: true });
    }
    const stagedSchemaVersion = quickCheck(join(stage, "praxis.db"));
    if (stagedSchemaVersion !== manifest.schemaVersion || stagedSchemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `backup database schema v${stagedSchemaVersion} does not match manifest v${manifest.schemaVersion}`,
      );
    }
    fsyncTree(stage);
    renameSync(targetDir, rollback);
    fsyncDirectory(parent);
    try {
      renameSync(stage, targetDir);
      fsyncDirectory(parent);
      if (opts.failAfterSwap) throw new Error("simulated post-swap restore failure");
      quickCheck(join(targetDir, "praxis.db"));
    } catch (error) {
      rmSync(targetDir, { recursive: true, force: true });
      renameSync(rollback, targetDir);
      fsyncDirectory(parent);
      throw error;
    }
    rmSync(rollback, { recursive: true, force: true });
    fsyncDirectory(parent);
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
