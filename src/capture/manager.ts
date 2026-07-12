import type { Store } from "../storage/index.ts";
import type { RawEvent } from "../core/types.ts";
import type { CaptureSource } from "./source.ts";
import { makeIngest, type Ingest } from "./ingest.ts";
import { AgentSessionsSource } from "./sources/agentSessions.ts";
import { logger } from "../core/log.ts";

const log = logger("capture");

/**
 * Runs a set of capture sources, funneling everything through one normalizing
 * ingest path into the store. Tracks the current foreground app from the focus
 * stream so sources like the clipboard tap can label their events correctly.
 */
export class CaptureManager {
  #ingest: Ingest;
  #sources: CaptureSource[];
  #front = { app: "unknown", window: "" };

  constructor(store: Store, sources: CaptureSource[]) {
    this.#ingest = makeIngest(store);
    // Agent-transcript ingestion (default OFF): opt in with PRAXIS_AGENT_SESSIONS=1.
    this.#sources =
      process.env.PRAXIS_AGENT_SESSIONS === "1"
        ? [...sources, new AgentSessionsSource()]
        : sources;
    this.#ingest.subscribe((e: RawEvent) => {
      if (e.source === "focus_timeline" && e.type === "app_focused") {
        this.#front = { app: e.app, window: e.window };
      }
    });
  }

  /** Current foreground app (for sources that need it). */
  frontApp(): { app: string; window: string } {
    return this.#front;
  }

  /** Subscribe to the live normalized event stream. */
  subscribe(fn: (e: RawEvent) => void): () => void {
    return this.#ingest.subscribe(fn);
  }

  async start(): Promise<void> {
    for (const s of this.#sources) {
      log.info(`starting source: ${s.name}`);
      await s.start(this.#ingest.ingest);
    }
  }

  async stop(): Promise<void> {
    for (const s of this.#sources) {
      try {
        await s.stop();
      } catch (err) {
        log.warn(`error stopping ${s.name}`, String(err));
      }
    }
  }
}
