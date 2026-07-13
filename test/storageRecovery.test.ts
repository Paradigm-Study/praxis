import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  chmodSync,
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeIngest } from "../src/capture/ingest.ts";
import { createBackup, restoreBackup, verifyBackup } from "../src/storage/backup.ts";
import { rotateMasterKey } from "../src/storage/crypto.ts";
import { doctorStore } from "../src/storage/doctor.ts";
import { openStore } from "../src/storage/index.ts";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("sensitive rows and blobs are encrypted at rest while typed stores remain transparent", () => {
  const dir = tempDir("praxis-encrypted-");
  try {
    const store = openStore({ dir });
    const event = makeIngest(store).ingest({
      source: "clipboard",
      app: "Secret Editor",
      window: "customer-passwords.txt",
      type: "clipboard_changed",
      payload: { text: "ultra-private-value" },
      blobs: [{ kind: "text", data: "private-blob-value" }],
    });
    const row = store.db.prepare(
      "SELECT app, window, payload_json FROM raw_events WHERE id = ?",
    ).get(event.id) as { app: string; window: string; payload_json: string };
    assert.match(row.app, /^enc:v1:/);
    assert.match(row.window, /^enc:v1:/);
    assert.match(row.payload_json, /^enc:v1:/);
    assert.ok(!JSON.stringify(row).includes("ultra-private-value"));
    const record = store.blobs.record(event.blobRefs[0]!)!;
    const rawBlob = readFileSync(record.path);
    assert.equal(rawBlob.subarray(0, 4).toString("ascii"), "PXE1");
    assert.ok(!rawBlob.includes(Buffer.from("private-blob-value")));
    assert.equal(store.blobs.getText(record.hash), "private-blob-value");
    assert.equal(store.events.get(event.id)?.payload.text, "ultra-private-value");
    assert.equal(store.events.range({ apps: ["Secret Editor"] }).length, 1);
    assert.equal(store.analytics.timePerApp()[0]?.app, "Secret Editor");
    store.close();

    const reopened = openStore({ dir });
    assert.equal(reopened.events.get(event.id)?.window, "customer-passwords.txt");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packaged external data key file is used without copying key material into the store", () => {
  const root = tempDir("praxis-external-key-");
  const dir = join(root, "data");
  const keyFile = join(root, "runtime-data-key");
  const previousFile = process.env.PRAXIS_DATA_KEY_FILE;
  const previousVersion = process.env.PRAXIS_DATA_KEY_VERSION;
  try {
    writeFileSync(keyFile, Buffer.alloc(32, 7).toString("base64url"), { mode: 0o600 });
    process.env.PRAXIS_DATA_KEY_FILE = keyFile;
    process.env.PRAXIS_DATA_KEY_VERSION = "4";
    const store = openStore({ dir });
    const event = makeIngest(store).ingest({
      source: "synthetic", app: "External", window: "key", type: "event", payload: { secret: true },
    });
    assert.equal(store.encryption.activeVersion, 4);
    assert.equal(existsSync(join(dir, "keys", "master-keys.json")), false);
    store.close();
    const reopened = openStore({ dir });
    assert.equal(reopened.events.get(event.id)?.payload.secret, true);
    reopened.close();
  } finally {
    if (previousFile === undefined) delete process.env.PRAXIS_DATA_KEY_FILE;
    else process.env.PRAXIS_DATA_KEY_FILE = previousFile;
    if (previousVersion === undefined) delete process.env.PRAXIS_DATA_KEY_VERSION;
    else process.env.PRAXIS_DATA_KEY_VERSION = previousVersion;
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy encryption migration rolls back both blobs and DB rows on failure", () => {
  const dir = tempDir("praxis-encryption-rollback-");
  try {
    const legacy = openStore({ dir, encryption: false });
    const event = makeIngest(legacy).ingest({
      source: "synthetic",
      app: "Legacy",
      window: "plaintext",
      type: "legacy",
      payload: { secret: "legacy-secret" },
      blobs: [{ kind: "text", data: "legacy-blob" }],
    });
    const blobPath = legacy.blobs.record(event.blobRefs[0]!)!.path;
    legacy.close();

    assert.throws(
      () => openStore({ dir, encryptionFailureAfterBlobs: 1 }),
      /simulated encryption blob failure/,
    );
    const afterBlobFailure = openStore({ dir, encryption: false });
    assert.equal(afterBlobFailure.events.get(event.id)?.payload.secret, "legacy-secret");
    assert.equal(readFileSync(blobPath, "utf8"), "legacy-blob");
    afterBlobFailure.close();

    assert.throws(
      () => openStore({ dir, encryptionFailureAfterRows: 1 }),
      /simulated encryption row failure/,
    );
    const afterRowFailure = openStore({ dir, encryption: false });
    const raw = afterRowFailure.db.prepare("SELECT payload_json FROM raw_events WHERE id = ?").get(event.id) as {
      payload_json: string;
    };
    assert.equal(raw.payload_json, JSON.stringify({ secret: "legacy-secret" }));
    assert.equal(readFileSync(blobPath, "utf8"), "legacy-blob");
    afterRowFailure.close();

    const migrated = openStore({ dir });
    assert.equal(migrated.events.get(event.id)?.payload.secret, "legacy-secret");
    assert.match(
      (migrated.db.prepare("SELECT payload_json FROM raw_events WHERE id = ?").get(event.id) as { payload_json: string }).payload_json,
      /^enc:v1:/,
    );
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema migration failure restores the startup snapshot atomically", () => {
  const dir = tempDir("praxis-schema-rollback-");
  try {
    const store = openStore({ dir, encryption: false });
    const event = makeIngest(store).ingest({
      source: "synthetic", app: "Test", window: "schema", type: "event", payload: { value: 1 },
    });
    store.db.exec("PRAGMA user_version = 1");
    store.close();
    assert.throws(
      () => openStore({ dir, encryption: false, migrationFailureVersion: 2 }),
      /simulated migration failure/,
    );
    const db = new DatabaseSync(join(dir, "praxis.db"));
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM raw_events WHERE id = ?").get(event.id) as { n: number }).n,
      1,
    );
    db.close();
    assert.ok(readdirSync(join(dir, "backups", "startup")).some((name) => name.endsWith(".sqlite")));
    const recovered = openStore({ dir, encryption: false });
    assert.equal(recovered.events.get(event.id)?.id, event.id);
    recovered.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("key rotation re-encrypts rows and blobs under the new active version", () => {
  const dir = tempDir("praxis-key-rotation-");
  try {
    const first = openStore({ dir });
    const event = makeIngest(first).ingest({
      source: "synthetic",
      app: "Rotation",
      window: "v1",
      type: "secret",
      payload: { value: "rotate-me" },
      blobs: [{ kind: "text", data: "rotate-blob" }],
    });
    const blobPath = first.blobs.record(event.blobRefs[0]!)!.path;
    first.close();

    const keys = rotateMasterKey(dir);
    assert.equal(keys.activeVersion, 2);
    const rotated = openStore({ dir });
    const row = rotated.db.prepare("SELECT payload_json FROM raw_events WHERE id = ?").get(event.id) as {
      payload_json: string;
    };
    assert.match(row.payload_json, /^enc:v2:/);
    assert.equal(readFileSync(blobPath).readUInt32BE(4), 2);
    assert.equal(rotated.events.get(event.id)?.payload.value, "rotate-me");
    assert.equal(rotated.blobs.getText(event.blobRefs[0]!), "rotate-blob");
    assert.deepEqual(rotated.encryption.keyVersions, [1, 2]);
    rotated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verified backup restores atomically and preserves a pre-restore backup", () => {
  const root = tempDir("praxis-backup-restore-");
  const dir = join(root, "data");
  const backup = join(root, "snapshot.praxisbackup");
  try {
    const original = openStore({ dir });
    const scopedSpool = join(dir, "mesh-outbox-spool-deadbeefdeadbeef.ndjson");
    writeFileSync(scopedSpool, `${JSON.stringify({ queued: true })}\n`, { mode: 0o600 });
    const before = makeIngest(original).ingest({
      source: "synthetic", app: "Test", window: "before", type: "before", payload: { secret: "before" },
    });
    createBackup(original, backup);
    assert.equal(verifyBackup(backup).ok, true);
    assert.ok(verifyBackup(backup).manifest?.files.some((file) =>
      file.path === "mesh-outbox-spool-deadbeefdeadbeef.ndjson"));
    const after = makeIngest(original).ingest({
      source: "synthetic", app: "Test", window: "after", type: "after", payload: { secret: "after" },
    });
    original.close();
    writeFileSync(join(dir, "post-snapshot.tmp"), "must disappear", { mode: 0o600 });

    const result = restoreBackup(backup, dir);
    assert.equal(verifyBackup(result.preRestoreBackup).ok, true);
    const restored = openStore({ dir });
    assert.ok(restored.events.get(before.id));
    assert.equal(restored.events.get(after.id), undefined);
    assert.equal(readFileSync(scopedSpool, "utf8"), `${JSON.stringify({ queued: true })}\n`);
    assert.equal(existsSync(join(dir, "post-snapshot.tmp")), false);
    restored.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup rejects destinations and unsupported live entries inside the blob boundary", () => {
  const root = tempDir("praxis-backup-boundary-");
  const dir = join(root, "data");
  const external = join(root, "external");
  try {
    const store = openStore({ dir });
    writeFileSync(external, "outside");
    assert.throws(
      () => createBackup(store, join(store.paths.blobs, "nested", "snapshot.praxisbackup")),
      /must not be inside the live blob store/,
    );

    const nestedLink = join(store.paths.blobs, "unsafe-link");
    symlinkSync(external, nestedLink);
    assert.throws(() => createBackup(store, join(root, "nested-link.praxisbackup")), /unsupported live blob entry/);
    rmSync(nestedLink);

    const auxiliaryLink = join(dir, "mesh-outbox-spool-deadbeefdeadbeef.ndjson");
    symlinkSync(external, auxiliaryLink);
    assert.throws(() => createBackup(store, join(root, "aux-link.praxisbackup")), /unsupported auxiliary/);
    rmSync(auxiliaryLink);

    const realBlobs = join(root, "real-blobs");
    renameSync(store.paths.blobs, realBlobs);
    symlinkSync(realBlobs, store.paths.blobs, "dir");
    assert.throws(() => createBackup(store, join(root, "root-link.praxisbackup")), /real directory/);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore rejects key-fingerprint and database-schema manifest mismatches", () => {
  const root = tempDir("praxis-backup-contract-");
  const dir = join(root, "data");
  const backup = join(root, "snapshot.praxisbackup");
  try {
    const store = openStore({ dir });
    createBackup(store, backup);
    store.close();
    const manifestPath = join(backup, "manifest.json");
    const original = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      schemaVersion: number;
      encryptionKeyVersions: number[];
      encryptionKeyFingerprints: Record<string, string>;
    };
    const fingerprintVersion = String(original.encryptionKeyVersions[0]);
    const wrongFingerprint = structuredClone(original);
    wrongFingerprint.encryptionKeyFingerprints[fingerprintVersion] = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(wrongFingerprint));
    assert.throws(() => restoreBackup(backup, dir), /does not match this backup/);

    const wrongSchema = structuredClone(original);
    wrongSchema.schemaVersion += 1;
    writeFileSync(manifestPath, JSON.stringify(wrongSchema));
    assert.match(verifyBackup(backup).errors.join("; "), /database schema .* does not match manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-swap restore failure rolls the target directory back", () => {
  const root = tempDir("praxis-restore-rollback-");
  const dir = join(root, "data");
  const backup = join(root, "snapshot.praxisbackup");
  try {
    const store = openStore({ dir });
    makeIngest(store).ingest({ source: "synthetic", app: "Test", window: "old", type: "old" });
    createBackup(store, backup);
    const current = makeIngest(store).ingest({ source: "synthetic", app: "Test", window: "current", type: "current" });
    store.close();
    assert.throws(() => restoreBackup(backup, dir, { failAfterSwap: true }), /simulated post-swap/);
    const recovered = openStore({ dir });
    assert.ok(recovered.events.get(current.id), "pre-restore target must be restored after swap failure");
    recovered.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tampered backup is rejected before target mutation", () => {
  const root = tempDir("praxis-backup-tamper-");
  const dir = join(root, "data");
  const backup = join(root, "snapshot.praxisbackup");
  try {
    const store = openStore({ dir });
    const current = makeIngest(store).ingest({
      source: "synthetic", app: "Test", window: "current", type: "current",
    });
    createBackup(store, backup);
    store.close();
    appendFileSync(join(backup, "praxis.db"), "tampered");
    assert.equal(verifyBackup(backup).ok, false);
    assert.throws(() => restoreBackup(backup, dir), /backup verification failed/);
    const untouched = openStore({ dir });
    assert.ok(untouched.events.get(current.id));
    untouched.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup verification rejects symlinked content and manifest files", () => {
  const root = tempDir("praxis-backup-symlink-");
  const dir = join(root, "data");
  const backup = join(root, "snapshot.praxisbackup");
  try {
    const store = openStore({ dir });
    createBackup(store, backup);
    store.close();

    const database = join(backup, "praxis.db");
    rmSync(database);
    symlinkSync(join(dir, "praxis.db"), database);
    assert.equal(verifyBackup(backup).ok, false, "database symlinks must never be followed");

    rmSync(database);
    copyFileSync(join(dir, "praxis.db"), database);
    const manifest = join(backup, "manifest.json");
    const realManifest = join(root, "manifest-real.json");
    renameSync(manifest, realManifest);
    symlinkSync(realManifest, manifest);
    assert.match(verifyBackup(backup).errors.join("; "), /manifest must be a regular file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup manifest paths are unique, normalized, allowlisted, and size bounded", () => {
  const root = tempDir("praxis-backup-manifest-policy-");
  const dir = join(root, "data");
  const backup = join(root, "snapshot.praxisbackup");
  try {
    const store = openStore({ dir });
    createBackup(store, backup);
    store.close();
    const manifestPath = join(backup, "manifest.json");
    const original = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: Array<{ path: string; bytes: number; sha256: string }>;
    };
    const database = original.files.find((file) => file.path === "praxis.db")!;

    original.files.push({ ...database });
    writeFileSync(manifestPath, JSON.stringify(original));
    assert.match(verifyBackup(backup).errors.join("; "), /duplicate path praxis\.db/);

    original.files.pop();
    database.path = "blobs/../praxis.db";
    writeFileSync(manifestPath, JSON.stringify(original));
    assert.match(verifyBackup(backup).errors.join("; "), /unsafe or unsupported path/);

    database.path = "keys/master-keys.json";
    writeFileSync(manifestPath, JSON.stringify(original));
    assert.match(verifyBackup(backup).errors.join("; "), /unsafe or unsupported path/);

    database.path = "praxis.db";
    database.bytes = 9 * 1024 * 1024 * 1024;
    writeFileSync(manifestPath, JSON.stringify(original));
    assert.match(verifyBackup(backup).errors.join("; "), /invalid size praxis\.db/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor detects and safely repairs permissions, orphan files/rows, and torn spools", () => {
  const dir = tempDir("praxis-doctor-");
  try {
    const store = openStore({ dir });
    makeIngest(store).ingest({ source: "synthetic", app: "Test", window: "doctor", type: "event" });
    const orphanFile = join(store.paths.blobs, "orphan-file");
    writeFileSync(orphanFile, "orphan", { mode: 0o600 });
    const indexedOrphan = join(store.paths.blobs, "indexed-orphan");
    writeFileSync(indexedOrphan, "orphan", { mode: 0o600 });
    store.db.prepare(
      "INSERT INTO blobs(hash, kind, path, bytes, created_at) VALUES(?, 'text', ?, 6, ?)",
    ).run("deadbeef", indexedOrphan, new Date().toISOString());
    writeFileSync(join(dir, "egress.ndjson"), `${JSON.stringify({ ok: true })}\n{torn`, { mode: 0o600 });
    const scopedSpool = join(dir, "mesh-outbox-spool-deadbeefdeadbeef.ndjson");
    writeFileSync(scopedSpool, `${JSON.stringify({ ok: true })}\n{also-torn`, { mode: 0o600 });
    chmodSync(store.paths.db, 0o644);

    const before = doctorStore(store);
    assert.equal(before.ok, false);
    assert.equal(before.counts.orphanBlobFiles, 1);
    assert.equal(before.counts.orphanBlobRows, 1);
    assert.equal(before.counts.corruptSpoolLines, 2);

    const repaired = doctorStore(store, { repair: true });
    assert.equal(repaired.ok, true);
    assert.ok(repaired.backupPath && verifyBackup(repaired.backupPath).ok);
    assert.equal(existsSync(orphanFile), false);
    assert.equal(existsSync(indexedOrphan), false);
    assert.equal((readFileSync(join(dir, "egress.ndjson"), "utf8").match(/\n/g) ?? []).length, 1);
    assert.equal((readFileSync(scopedSpool, "utf8").match(/\n/g) ?? []).length, 1);
    assert.equal(chmodMode(store.paths.db), 0o600);
    assert.equal(doctorStore(store).ok, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup removes abandoned atomic-write artifacts after a crash", () => {
  const dir = tempDir("praxis-crash-cleanup-");
  try {
    const blobDir = join(dir, "blobs", "aa");
    mkdirSync(blobDir, { recursive: true });
    const abandoned = join(blobDir, "value.tmp-dead-process");
    writeFileSync(abandoned, "partial");
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(abandoned, old, old);
    const store = openStore({ dir });
    assert.equal(existsSync(abandoned), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reports a missing referenced blob as non-repairable", () => {
  const dir = tempDir("praxis-doctor-missing-");
  try {
    const store = openStore({ dir });
    const event = makeIngest(store).ingest({
      source: "synthetic", app: "Test", window: "missing", type: "blob",
      blobs: [{ kind: "text", data: "referenced" }],
    });
    rmSync(store.blobs.record(event.blobRefs[0]!)!.path);
    const report = doctorStore(store, { repair: true });
    assert.equal(report.ok, false);
    assert.equal(report.counts.missingBlobs, 1);
    assert.ok(report.issues.some((item) => item.code === "missing_referenced_blob" && !item.repairable));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function chmodMode(path: string): number {
  return statSync(path).mode & 0o777;
}
