import type { BlobKind, EventSource, RawEvent } from "../core/types.ts";

/**
 * What a capture source hands to the ingest pipeline. The source describes
 * *what it observed*; ingest assigns the id, timestamp, hash, and offloads any
 * large inline data to the blob store. Sources never write to the DB directly —
 * everything funnels through one normalizing path.
 */
export interface RawEventInput {
  /** Defaults to now() if omitted. */
  ts?: string;
  source: EventSource;
  app: string;
  window: string;
  type: string;
  payload?: Record<string, unknown>;
  /** Already-stored blob hashes to reference. */
  blobRefs?: string[];
  /** Inline large data; ingest offloads each to the content-addressed store. */
  blobs?: Array<{ kind: BlobKind; data: Uint8Array | string }>;
}

/** The funnel every source emits into. Returns the normalized, stored event. */
export type EventSink = (input: RawEventInput) => RawEvent;

/**
 * A pluggable capture tap. The native Swift client, clipboard poller, file
 * watcher, git poller, etc. all implement this. `start` receives the sink and
 * runs until `stop`.
 */
export interface CaptureSource {
  readonly name: string;
  readonly source: EventSource;
  start(sink: EventSink): Promise<void> | void;
  stop(): Promise<void> | void;
}
