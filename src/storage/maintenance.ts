import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Store } from "./index.ts";
import { buildGraph } from "../memory/graph.ts";

export interface RetentionPolicy {
  version: 1;
  rawDays: number;
  mediaDays: number;
  derivedDays: number;
  maxBytes: number;
  updatedAt: string;
}

export interface StorageUsage {
  databaseBytes: number;
  walBytes: number;
  blobBytes: number;
  totalBytes: number;
  blobs: number;
}

export interface MaintenanceResult {
  before: StorageUsage;
  after: StorageUsage;
  eventsDeleted: number;
  actionsDeleted: number;
  episodesDeleted: number;
  blobsDeleted: number;
  bytesFreed: number;
}

export function defaultRetentionPolicy(now = new Date().toISOString()): RetentionPolicy {
  return {
    version: 1,
    rawDays: 30,
    mediaDays: 7,
    derivedDays: 90,
    maxBytes: 10 * 1024 * 1024 * 1024,
    updatedAt: now,
  };
}

function finiteInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : fallback;
}

export function normalizeRetentionPolicy(value: unknown): RetentionPolicy {
  const fallback = defaultRetentionPolicy();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const input = value as Record<string, unknown>;
  return {
    version: 1,
    rawDays: finiteInt(input.rawDays, fallback.rawDays, 1, 3650),
    mediaDays: finiteInt(input.mediaDays, fallback.mediaDays, 1, 3650),
    derivedDays: finiteInt(input.derivedDays, fallback.derivedDays, 1, 3650),
    maxBytes: finiteInt(input.maxBytes, fallback.maxBytes, 1, Number.MAX_SAFE_INTEGER),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date().toISOString(),
  };
}

export function retentionPathForStore(store: Store): string | undefined {
  return store.paths.db === ":memory:" ? undefined : join(dirname(store.paths.db), "retention.json");
}

export class RetentionPolicyStore {
  readonly path: string | undefined;
  #memory = defaultRetentionPolicy();

  constructor(path?: string) {
    this.path = path;
  }

  static forStore(store: Store): RetentionPolicyStore {
    const existing = RETENTION_STORES.get(store);
    if (existing) return existing;
    const created = new RetentionPolicyStore(retentionPathForStore(store));
    RETENTION_STORES.set(store, created);
    return created;
  }

  read(): RetentionPolicy {
    if (!this.path || !existsSync(this.path)) return this.#memory;
    try {
      this.#memory = normalizeRetentionPolicy(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      // Invalid files preserve safe defaults rather than disabling retention.
    }
    return this.#memory;
  }

  write(value: unknown): RetentionPolicy {
    const next = normalizeRetentionPolicy({
      ...(typeof value === "object" && value !== null ? value : {}),
      updatedAt: new Date().toISOString(),
    });
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.path);
      try {
        chmodSync(dirname(this.path), 0o700);
        chmodSync(this.path, 0o600);
      } catch {
        // Best effort.
      }
    }
    this.#memory = next;
    return next;
  }

  update(patch: Partial<RetentionPolicy>): RetentionPolicy {
    return this.write({ ...this.read(), ...patch });
  }
}

const RETENTION_STORES = new WeakMap<Store, RetentionPolicyStore>();

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? directoryBytes(child) : fileSize(child);
  }
  return total;
}

export function storageUsage(store: Store): StorageUsage {
  const databaseBytes = store.paths.db === ":memory:" ? 0 : fileSize(store.paths.db);
  const walBytes = store.paths.db === ":memory:"
    ? 0
    : fileSize(`${store.paths.db}-wal`) + fileSize(`${store.paths.db}-shm`);
  const blobBytes = directoryBytes(store.paths.blobs);
  const row = store.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number };
  return {
    databaseBytes,
    walBytes,
    blobBytes,
    totalBytes: databaseBytes + walBytes + blobBytes,
    blobs: Number(row.n),
  };
}

function isoBefore(nowMs: number, days: number): string {
  return new Date(nowMs - days * 86_400_000).toISOString();
}

function countBefore(store: Store, table: string, column: string, cutoff: string): number {
  const row = store.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} < ?`)
    .get(cutoff) as { n: number };
  return Number(row.n);
}

function deleteOrphanBlobs(store: Store): { blobs: number; bytes: number } {
  const referenced = new Set(store.events.range().flatMap((event) => event.blobRefs));
  const rows = store.db.prepare("SELECT hash, path, bytes FROM blobs").all() as Array<{
    hash: string;
    path: string;
    bytes: number;
  }>;
  let blobs = 0;
  let bytes = 0;
  const root = `${resolve(store.paths.blobs)}/`;
  for (const row of rows) {
    if (referenced.has(row.hash)) continue;
    if (resolve(row.path).startsWith(root)) {
      try {
        unlinkSync(row.path);
      } catch {
        // Missing bytes are already reclaimed.
      }
    }
    store.db.prepare("DELETE FROM blobs WHERE hash = ?").run(row.hash);
    blobs += 1;
    bytes += Number(row.bytes);
  }
  return { blobs, bytes };
}

/** Reference-aware retention and quota enforcement. Safe to rerun. */
export function runMaintenance(
  store: Store,
  policy = RetentionPolicyStore.forStore(store).read(),
  nowMs = Date.now(),
): MaintenanceResult {
  const normalized = normalizeRetentionPolicy(policy);
  const before = storageUsage(store);
  const rawCutoff = isoBefore(nowMs, normalized.rawDays);
  const mediaCutoff = isoBefore(nowMs, normalized.mediaDays);
  const derivedCutoff = isoBefore(nowMs, normalized.derivedDays);
  let eventsDeleted = countBefore(store, "raw_events", "ts", rawCutoff);
  const oldMedia = Number((store.db.prepare(
    "SELECT COUNT(*) AS n FROM raw_events WHERE source IN ('screen_video', 'audio') AND ts < ? AND ts >= ?",
  ).get(mediaCutoff, rawCutoff) as { n: number }).n);
  eventsDeleted += oldMedia;
  let actionsDeleted = countBefore(store, "action_events", "end_ts", derivedCutoff);
  let episodesDeleted = countBefore(store, "episodes", "end_ts", derivedCutoff);

  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare(
      "DELETE FROM raw_events WHERE source IN ('screen_video', 'audio') AND ts < ?",
    ).run(mediaCutoff);
    store.db.prepare("DELETE FROM raw_events WHERE ts < ?").run(rawCutoff);
    store.db.prepare("DELETE FROM action_events WHERE end_ts < ?").run(derivedCutoff);
    store.db.prepare("DELETE FROM episodes WHERE end_ts < ?").run(derivedCutoff);
    store.db.prepare("DELETE FROM observations WHERE created_ts < ?").run(derivedCutoff);
    store.db.prepare("DELETE FROM decisions WHERE created_ts < ?").run(derivedCutoff);
    store.db.prepare("DELETE FROM corrections WHERE created_ts < ?").run(derivedCutoff);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }

  let orphaned = deleteOrphanBlobs(store);
  let usage = storageUsage(store);
  // Quota pressure deletes oldest coherent time slices, never newest-first.
  while (usage.totalBytes > normalized.maxBytes) {
    const row = store.db.prepare(
      "SELECT ts FROM raw_events ORDER BY ts ASC LIMIT 1 OFFSET 249",
    ).get() as { ts: string } | undefined;
    const fallback = store.db.prepare(
      "SELECT ts FROM raw_events ORDER BY ts DESC LIMIT 1",
    ).get() as { ts: string } | undefined;
    const cutoff = row?.ts ?? fallback?.ts;
    if (!cutoff) break;
    const inclusiveCutoff = new Date(Date.parse(cutoff) + 1).toISOString();
    const batchEvents = countBefore(store, "raw_events", "ts", inclusiveCutoff);
    const batchActions = countBefore(store, "action_events", "end_ts", inclusiveCutoff);
    const batchEpisodes = countBefore(store, "episodes", "end_ts", inclusiveCutoff);
    store.db.exec("BEGIN IMMEDIATE");
    try {
      store.db.prepare("DELETE FROM raw_events WHERE ts < ?").run(inclusiveCutoff);
      store.db.prepare("DELETE FROM action_events WHERE end_ts < ?").run(inclusiveCutoff);
      store.db.prepare("DELETE FROM episodes WHERE end_ts < ?").run(inclusiveCutoff);
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    eventsDeleted += batchEvents;
    actionsDeleted += batchActions;
    episodesDeleted += batchEpisodes;
    const more = deleteOrphanBlobs(store);
    orphaned = { blobs: orphaned.blobs + more.blobs, bytes: orphaned.bytes + more.bytes };
    const next = storageUsage(store);
    if (next.totalBytes >= usage.totalBytes && batchEvents === 0) break;
    usage = next;
  }

  // Claims/graph are derived from episodes. Never retain a memory edge whose
  // evidence episode was removed by retention or quota pressure.
  if (episodesDeleted > 0) {
    store.db.exec("DELETE FROM graph_edges; DELETE FROM graph_nodes; DELETE FROM claims;");
    buildGraph(store);
  }

  if (store.paths.db !== ":memory:") {
    try {
      store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // Another reader may temporarily hold the WAL; maintenance is still valid.
    }
  }
  const after = storageUsage(store);
  return {
    before,
    after,
    eventsDeleted,
    actionsDeleted,
    episodesDeleted,
    blobsDeleted: orphaned.blobs,
    bytesFreed: Math.max(0, before.totalBytes - after.totalBytes),
  };
}
