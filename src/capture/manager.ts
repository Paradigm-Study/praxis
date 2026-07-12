import type { Store } from "../storage/index.ts";
import type { RawEvent } from "../core/types.ts";
import type { CaptureSource } from "./source.ts";
import { makeIngest, type Ingest } from "./ingest.ts";
import { AgentSessionsSource } from "./sources/agentSessions.ts";
import { logger } from "../core/log.ts";
import { PrivacyControlStore } from "../privacy/control.ts";
import { RuntimeStatusStore } from "./runtimeStatus.ts";
import { runMaintenance } from "../storage/maintenance.ts";

const log = logger("capture");

/**
 * Runs a set of capture sources, funneling everything through one normalizing
 * ingest path into the store. Tracks the current foreground app from the focus
 * stream so sources like the clipboard tap can label their events correctly.
 */
export class CaptureManager {
  #ingest: Ingest;
  #sources: CaptureSource[];
  #started: CaptureSource[] = [];
  #state: "stopped" | "starting" | "running" | "stopping" | "failed" = "stopped";
  #runtime: RuntimeStatusStore;
  #store: Store;
  #maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #lastRuntimeEvent = 0;
  #front = { app: "unknown", window: "" };

  constructor(
    store: Store,
    sources: CaptureSource[],
    opts: { privacy?: PrivacyControlStore; runtime?: RuntimeStatusStore } = {},
  ) {
    this.#store = store;
    this.#runtime = opts.runtime ?? RuntimeStatusStore.forStore(store);
    this.#ingest = makeIngest(store, { privacy: opts.privacy, runtime: this.#runtime });
    // Agent-transcript ingestion (default OFF): opt in with PRAXIS_AGENT_SESSIONS=1.
    this.#sources =
      process.env.PRAXIS_AGENT_SESSIONS === "1"
        ? [...sources, new AgentSessionsSource()]
        : sources;
    this.#ingest.subscribe((e: RawEvent) => {
      if (e.source === "focus_timeline" && e.type === "app_focused") {
        this.#front = { app: e.app, window: e.window };
      }
      const now = Date.now();
      if (now - this.#lastRuntimeEvent >= 5_000) {
        this.#lastRuntimeEvent = now;
        this.#runtime.write({ lastEventAt: e.ts });
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
    if (this.#state === "running" || this.#state === "starting") return;
    this.#state = "starting";
    this.#runtime.write({
      state: "starting",
      pid: process.pid,
      activeSources: [],
      lastError: undefined,
    });
    try {
      this.#maintain();
      this.#maintenanceTimer = setInterval(() => this.#maintain(), 60 * 60_000);
      this.#maintenanceTimer.unref();
      for (const s of this.#sources) {
        log.info(`starting source: ${s.name}`);
        try {
          await s.start(this.#ingest.ingest);
        } catch (error) {
          // A source may allocate resources before its start rejects.
          try {
            await s.stop();
          } catch (stopError) {
            log.warn(`failed-source cleanup failed for ${s.name}`, String(stopError));
          }
          throw error;
        }
        this.#started.push(s);
        this.#runtime.write({ activeSources: this.#started.map((source) => source.name) });
      }
      this.#state = "running";
      this.#runtime.write({
        state: "running",
        pid: process.pid,
        activeSources: this.#started.map((source) => source.name),
      });
      this.#heartbeatTimer = setInterval(() => {
        this.#runtime.write({
          state: "running",
          pid: process.pid,
          activeSources: this.#started.map((source) => source.name),
        });
      }, 10_000);
      this.#heartbeatTimer.unref();
    } catch (error) {
      for (const source of [...this.#started].reverse()) {
        try {
          await source.stop();
        } catch (stopError) {
          log.warn(`rollback failed for ${source.name}`, String(stopError));
        }
      }
      this.#started = [];
      if (this.#maintenanceTimer) clearInterval(this.#maintenanceTimer);
      this.#maintenanceTimer = undefined;
      if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
      this.#state = "failed";
      this.#runtime.write({
        state: "failed",
        activeSources: [],
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped" || this.#state === "stopping") return;
    this.#state = "stopping";
    this.#runtime.write({ state: "stopping" });
    for (const s of [...this.#started].reverse()) {
      try {
        await s.stop();
      } catch (err) {
        log.warn(`error stopping ${s.name}`, String(err));
      }
    }
    if (this.#maintenanceTimer) clearInterval(this.#maintenanceTimer);
    this.#maintenanceTimer = undefined;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#started = [];
    this.#state = "stopped";
    this.#runtime.write({ state: "stopped", activeSources: [] });
  }

  #maintain(): void {
    try {
      runMaintenance(this.#store);
    } catch (error) {
      // Retention is fail-open for capture, but the error is visible in logs.
      log.warn("storage maintenance failed", String(error));
    }
  }
}
