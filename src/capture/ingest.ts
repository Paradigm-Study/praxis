import type { RawEvent } from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import type { RawEventInput } from "./source.ts";
import { newId } from "../core/ids.ts";
import { hashEventContent } from "../core/hash.ts";
import { nowIso } from "../core/time.ts";

/**
 * The single normalizing entry point for the ledger. Every capture source goes
 * through here, which guarantees:
 *   - large data is offloaded to content-addressed blobs (only hashes inline)
 *   - every event gets a stable content hash for dedupe + integrity
 *   - downstream consumers (agent loop, studio) can subscribe to the live stream
 */
export interface Ingest {
  /** Normalize, offload blobs, store, notify subscribers; return the event. */
  ingest: (input: RawEventInput) => RawEvent;
  /** Subscribe to the live event stream. Returns an unsubscribe fn. */
  subscribe: (fn: (e: RawEvent) => void) => () => void;
}

export function makeIngest(store: Store): Ingest {
  const subscribers = new Set<(e: RawEvent) => void>();

  function ingest(input: RawEventInput): RawEvent {
    const ts = input.ts ?? nowIso();
    const blobRefs = [...(input.blobRefs ?? [])];

    // Offload inline large data to the content-addressed blob store.
    if (input.blobs) {
      for (const b of input.blobs) {
        const rec = store.blobs.put(b.kind, b.data);
        blobRefs.push(rec.hash);
      }
    }

    const payload = input.payload ?? {};
    const hash = hashEventContent({
      ts,
      source: input.source,
      app: input.app,
      window: input.window,
      type: input.type,
      payload,
      blobRefs,
    });

    const event: RawEvent = {
      id: newId("event"),
      ts,
      source: input.source,
      app: input.app,
      window: input.window,
      type: input.type,
      payload,
      blobRefs,
      hash,
    };

    store.events.append(event);
    for (const fn of subscribers) {
      try {
        fn(event);
      } catch {
        // a misbehaving subscriber must not break ingest
      }
    }
    return event;
  }

  return {
    ingest,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
