import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { openDb } from "./db.ts";
import { makeEventStore, type EventStore } from "./eventStore.ts";
import { makeBlobStore, type BlobStore } from "./blobStore.ts";
import { makeActionStore, type ActionStore } from "./actionStore.ts";
import { makeEpisodeStore, type EpisodeStore } from "./episodeStore.ts";
import { makeClaimStore, type ClaimStore } from "./claimStore.ts";
import { makeGraphStore, type GraphStore } from "./graphStore.ts";
import {
  makeObservationStore,
  type ObservationStore,
} from "./observationStore.ts";
import {
  makeCorrectionStore,
  type CorrectionStore,
} from "./correctionStore.ts";
import { makeDecisionStore, type DecisionStore } from "./decisionStore.ts";
import { makeAnalytics, type Analytics } from "./analytics.ts";
import { loadStorageKeyring, StorageCipher } from "./crypto.ts";
import { cleanupCrashArtifacts, migrateEncryptedContent } from "./encryptionMigration.ts";

/**
 * The unified storage facade. One handle exposes every typed store plus the
 * underlying connection. This is the boundary the rest of Praxis depends on.
 */
export interface Store {
  db: DatabaseSync;
  events: EventStore;
  blobs: BlobStore;
  actions: ActionStore;
  episodes: EpisodeStore;
  claims: ClaimStore;
  graph: GraphStore;
  observations: ObservationStore;
  corrections: CorrectionStore;
  decisions: DecisionStore;
  analytics: Analytics;
  cipher?: StorageCipher;
  encryption: {
    enabled: boolean;
    activeVersion: number;
    keyVersions: number[];
    keyFingerprints: Record<string, string>;
  };
  paths: { db: string; blobs: string };
  close(): void;
}

export interface OpenStoreOptions {
  /** Base data directory. Default: $PRAXIS_DATA_DIR or ./data */
  dir?: string;
  dbPath?: string;
  blobDir?: string;
  /** In-memory DB (tests). Blobs go to a temp dir. */
  memory?: boolean;
  duckdb?: boolean;
  /** Default true. False exists for legacy migration tests/import tools only. */
  encryption?: boolean;
  /** Failure-injection seams used by migration rollback tests. */
  migrationFailureVersion?: number;
  encryptionFailureAfterRows?: number;
  encryptionFailureAfterBlobs?: number;
}

export function defaultDataDir(): string {
  return process.env.PRAXIS_DATA_DIR ?? join(process.cwd(), "data");
}

export function openStore(opts: OpenStoreOptions = {}): Store {
  const base = opts.dir ?? (opts.dbPath ? dirname(opts.dbPath) : defaultDataDir());
  const dbPath = opts.memory ? ":memory:" : (opts.dbPath ?? join(base, "praxis.db"));
  const blobDir = opts.memory
    ? mkdtempSync(join(tmpdir(), "praxis-blobs-"))
    : (opts.blobDir ?? join(base, "blobs"));

  if (!opts.memory) cleanupCrashArtifacts(base);
  const db = openDb(dbPath, { failMigrationVersion: opts.migrationFailureVersion });
  const encryptionEnabled = opts.encryption !== false;
  const cipher = encryptionEnabled
    ? opts.memory
      ? StorageCipher.ephemeral()
      : new StorageCipher(loadStorageKeyring(base))
    : undefined;
  try {
    if (cipher) {
      migrateEncryptedContent(db, blobDir, base, cipher, {
        failAfterRows: opts.encryptionFailureAfterRows,
        failAfterBlobs: opts.encryptionFailureAfterBlobs,
      });
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const store: Store = {
    db,
    events: makeEventStore(db, cipher),
    blobs: makeBlobStore(db, blobDir, cipher),
    actions: makeActionStore(db, cipher),
    episodes: makeEpisodeStore(db, cipher),
    claims: makeClaimStore(db, cipher),
    graph: makeGraphStore(db, cipher),
    observations: makeObservationStore(db, cipher),
    corrections: makeCorrectionStore(db, cipher),
    decisions: makeDecisionStore(db, cipher),
    analytics: makeAnalytics(db, opts.duckdb ?? false, cipher),
    ...(cipher ? { cipher } : {}),
    encryption: {
      enabled: cipher !== undefined,
      activeVersion: cipher?.activeVersion ?? 0,
      keyVersions: cipher?.keyVersions ?? [],
      keyFingerprints: cipher?.keyFingerprints ?? {},
    },
    paths: { db: dbPath, blobs: blobDir },
    close: () => db.close(),
  };
  return store;
}

export type {
  EventStore,
  BlobStore,
  ActionStore,
  EpisodeStore,
  ClaimStore,
  GraphStore,
  ObservationStore,
  CorrectionStore,
  DecisionStore,
  Analytics,
};
