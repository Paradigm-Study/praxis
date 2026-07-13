import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sha256 } from "../core/hash.ts";
import type { Store } from "./index.ts";
import { SENSITIVE_COLUMNS, cleanupCrashArtifacts } from "./encryptionMigration.ts";
import { createBackup } from "./backup.ts";

export type DoctorSeverity = "info" | "warning" | "error";

export interface DoctorIssue {
  code: string;
  severity: DoctorSeverity;
  message: string;
  path?: string;
  repairable: boolean;
  repaired: boolean;
}

export interface DoctorReport {
  ok: boolean;
  checkedAt: string;
  repaired: boolean;
  backupPath?: string;
  issues: DoctorIssue[];
  counts: {
    referencedBlobs: number;
    missingBlobs: number;
    orphanBlobRows: number;
    orphanBlobFiles: number;
    corruptSpoolLines: number;
  };
}

const NDJSON_FILES = [
  "mesh-outbox-spool.ndjson",
  "dispatches.ndjson",
  "notifications.ndjson",
  "egress.ndjson",
] as const;

function ndjsonFileNames(base: string): string[] {
  const names = new Set<string>(NDJSON_FILES);
  if (base && existsSync(base)) {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isFile() && /^mesh-outbox-spool-[a-f0-9]{16}\.ndjson$/.test(entry.name)) names.add(entry.name);
    }
  }
  return [...names];
}

function issue(
  issues: DoctorIssue[],
  value: Omit<DoctorIssue, "repaired"> & { repaired?: boolean },
): void {
  issues.push({ ...value, repaired: value.repaired ?? false });
}

function mode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);
  return files;
}

function checkPermissions(base: string, repair: boolean, issues: DoctorIssue[]): void {
  const directories = [base, join(base, "blobs"), join(base, "keys")].filter(existsSync);
  for (const path of directories) {
    if (mode(path) === 0o700) continue;
    let repaired = false;
    if (repair) {
      try {
        chmodSync(path, 0o700);
        repaired = true;
      } catch {
        // Report below.
      }
    }
    issue(issues, {
      code: "permission_directory",
      severity: "error",
      message: "private data directory must be mode 0700",
      path,
      repairable: true,
      repaired,
    });
  }
  const protectedFiles = [
    join(base, "praxis.db"),
    join(base, "praxis.db-wal"),
    join(base, "praxis.db-shm"),
    join(base, "privacy.json"),
    join(base, "retention.json"),
    join(base, "egress.ndjson"),
    ...ndjsonFileNames(base).map((name) => join(base, name)),
    join(base, "keys", "master-keys.json"),
    ...(process.env.PRAXIS_DATA_KEY_FILE ? [process.env.PRAXIS_DATA_KEY_FILE] : []),
    ...walkFiles(join(base, "blobs")),
  ].filter(existsSync);
  for (const path of protectedFiles) {
    if (mode(path) === 0o600) continue;
    let repaired = false;
    if (repair) {
      try {
        chmodSync(path, 0o600);
        repaired = true;
      } catch {
        // Report below.
      }
    }
    issue(issues, {
      code: "permission_file",
      severity: "error",
      message: "private data file must be mode 0600",
      path,
      repairable: true,
      repaired,
    });
  }
}

function checkSpools(base: string, repair: boolean, issues: DoctorIssue[]): number {
  let corrupt = 0;
  for (const name of ndjsonFileNames(base)) {
    const path = join(base, name);
    if (!existsSync(path)) continue;
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) continue;
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    const valid: string[] = [];
    let fileCorrupt = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
        valid.push(line);
      } catch {
        fileCorrupt += 1;
      }
    }
    if (fileCorrupt === 0) continue;
    corrupt += fileCorrupt;
    let repaired = false;
    if (repair) {
      try {
        const copy = `${path}.corrupt-${Date.now()}`;
        copyFileSync(path, copy);
        chmodSync(copy, 0o600);
        writeFileSync(path, valid.length ? `${valid.join("\n")}\n` : "", { mode: 0o600 });
        repaired = true;
      } catch {
        // Report below.
      }
    }
    issue(issues, {
      code: "corrupt_ndjson",
      severity: "warning",
      message: `${fileCorrupt} malformed line(s)`,
      path,
      repairable: true,
      repaired,
    });
  }
  return corrupt;
}

export function doctorStore(store: Store, opts: { repair?: boolean } = {}): DoctorReport {
  const repair = opts.repair === true;
  const issues: DoctorIssue[] = [];
  const base = store.paths.db === ":memory:" ? "" : dirname(store.paths.db);
  const backupPath = repair && base ? createBackup(store) : undefined;

  for (const pragma of ["quick_check", "integrity_check", "foreign_key_check"] as const) {
    try {
      const rows = store.db.prepare(`PRAGMA ${pragma}`).all() as Array<Record<string, unknown>>;
      const ok = pragma === "foreign_key_check"
        ? rows.length === 0
        : rows.length === 1 && Object.values(rows[0] ?? {})[0] === "ok";
      if (!ok) {
        issue(issues, {
          code: `sqlite_${pragma}`,
          severity: "error",
          message: JSON.stringify(rows).slice(0, 1000),
          repairable: false,
        });
      }
    } catch (error) {
      issue(issues, {
        code: `sqlite_${pragma}`,
        severity: "error",
        message: String(error),
        repairable: false,
      });
    }
  }

  if (store.paths.db !== ":memory:") {
    try {
      const row = store.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as {
        busy: number;
        log: number;
        checkpointed: number;
      };
      if (Number(row.busy) > 0) {
        issue(issues, {
          code: "wal_busy",
          severity: "warning",
          message: "WAL has a busy reader/writer and could not fully checkpoint",
          repairable: false,
        });
      }
    } catch (error) {
      issue(issues, {
        code: "wal_check",
        severity: "warning",
        message: String(error),
        repairable: false,
      });
    }
    checkPermissions(base, repair, issues);
  }

  const refs = new Set(store.events.range().flatMap((event) => event.blobRefs));
  const rows = store.db.prepare("SELECT hash, path FROM blobs").all() as Array<{
    hash: string;
    path: string;
  }>;
  const byHash = new Map(rows.map((row) => [row.hash, row]));
  const blobRoot = `${resolve(store.paths.blobs)}/`;
  let missing = 0;
  for (const hash of refs) {
    const row = byHash.get(hash);
    if (row && !resolve(row.path).startsWith(blobRoot)) {
      missing += 1;
      issue(issues, {
        code: "blob_path_escape",
        severity: "error",
        message: `blob ${hash} points outside the blob store`,
        path: row.path,
        repairable: false,
      });
      continue;
    }
    if (!row || !existsSync(row.path)) {
      missing += 1;
      issue(issues, {
        code: "missing_referenced_blob",
        severity: "error",
        message: `referenced blob ${hash} is missing`,
        path: row?.path,
        repairable: false,
      });
      continue;
    }
    try {
      const bytes = store.blobs.get(hash);
      if (!bytes || sha256(bytes) !== hash) throw new Error("plaintext hash mismatch");
    } catch (error) {
      issue(issues, {
        code: "corrupt_encrypted_blob",
        severity: "error",
        message: `${hash}: ${String(error)}`,
        path: row.path,
        repairable: false,
      });
    }
  }

  let orphanRows = 0;
  for (const row of rows) {
    if (refs.has(row.hash)) continue;
    orphanRows += 1;
    let repaired = false;
    if (repair) {
      if (resolve(row.path).startsWith(blobRoot)) {
        try {
          unlinkSync(row.path);
        } catch {
          // Missing orphan bytes need no action.
        }
      }
      store.db.prepare("DELETE FROM blobs WHERE hash = ?").run(row.hash);
      repaired = true;
    }
    issue(issues, {
      code: "orphan_blob_row",
      severity: "warning",
      message: `unreferenced blob row ${row.hash}`,
      path: row.path,
      repairable: true,
      repaired,
    });
  }

  const knownPaths = new Set(rows.map((row) => resolve(row.path)));
  let orphanFiles = 0;
  for (const path of walkFiles(store.paths.blobs)) {
    if (knownPaths.has(resolve(path))) continue;
    orphanFiles += 1;
    let repaired = false;
    if (repair) {
      rmSync(path, { force: true });
      repaired = true;
    }
    issue(issues, {
      code: "orphan_blob_file",
      severity: "warning",
      message: "blob file has no index row",
      path,
      repairable: true,
      repaired,
    });
  }

  if (store.cipher) {
    for (const [table, column] of SENSITIVE_COLUMNS) {
      const row = store.db
        .prepare(
          `SELECT ${column} AS value FROM ${table} ` +
            `WHERE ${column} IS NOT NULL AND ${column} NOT LIKE 'enc:v%' LIMIT 1`,
        )
        .get() as { value: string } | undefined;
      if (row && store.cipher.textVersion(row.value) === undefined) {
        issue(issues, {
          code: "plaintext_sensitive_column",
          severity: "error",
          message: `${table}.${column} contains plaintext`,
          repairable: false,
        });
      }
    }
  }

  const corruptSpoolLines = base ? checkSpools(base, repair, issues) : 0;
  if (base) {
    const removed = repair ? cleanupCrashArtifacts(base, 0) : 0;
    if (removed > 0) {
      issue(issues, {
        code: "crash_artifacts",
        severity: "warning",
        message: `removed ${removed} abandoned temporary file(s)`,
        repairable: true,
        repaired: true,
      });
    }
  }

  const unresolvedErrors = issues.some(
    (item) => item.severity === "error" && !(item.repairable && item.repaired),
  );
  return {
    ok: !unresolvedErrors,
    checkedAt: new Date().toISOString(),
    repaired: repair,
    ...(backupPath ? { backupPath } : {}),
    issues,
    counts: {
      referencedBlobs: refs.size,
      missingBlobs: missing,
      orphanBlobRows: orphanRows,
      orphanBlobFiles: orphanFiles,
      corruptSpoolLines,
    },
  };
}
