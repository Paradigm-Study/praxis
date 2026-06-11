import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
}

export function defaultDataDir(): string {
  return process.env.PRAXIS_DATA_DIR ?? join(process.cwd(), "data");
}

export function openStore(opts: OpenStoreOptions = {}): Store {
  const base = opts.dir ?? defaultDataDir();
  const dbPath = opts.memory ? ":memory:" : (opts.dbPath ?? join(base, "praxis.db"));
  const blobDir = opts.memory
    ? mkdtempSync(join(tmpdir(), "praxis-blobs-"))
    : (opts.blobDir ?? join(base, "blobs"));

  const db = openDb(dbPath);

  const store: Store = {
    db,
    events: makeEventStore(db),
    blobs: makeBlobStore(db, blobDir),
    actions: makeActionStore(db),
    episodes: makeEpisodeStore(db),
    claims: makeClaimStore(db),
    graph: makeGraphStore(db),
    observations: makeObservationStore(db),
    corrections: makeCorrectionStore(db),
    decisions: makeDecisionStore(db),
    analytics: makeAnalytics(db, opts.duckdb ?? false),
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
