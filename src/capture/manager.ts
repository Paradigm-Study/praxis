import type { Store } from "../storage/index.ts";
import type { RawEvent } from "../core/types.ts";
import type {
  CaptureSource,
  CaptureSourceFailure,
  CaptureSourceStatus,
} from "./source.ts";
import { makeIngest, type Ingest } from "./ingest.ts";
import {
  AgentSessionsSource,
  type AgentSessionsOptions,
} from "./sources/agentSessions.ts";
import { logger } from "../core/log.ts";
import {
  capturePolicyDecision,
  PrivacyControlStore,
} from "../privacy/control.ts";
import {
  resourceCaptureDecision,
  RuntimeStatusStore,
  type CaptureRuntimeStatus,
} from "./runtimeStatus.ts";
import { runMaintenance } from "../storage/maintenance.ts";
import { publishNativeAcquisitionPolicy } from "../privacy/nativePolicy.ts";

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
  #sourceFailures = new Map<CaptureSource, string>();
  #state: "stopped" | "starting" | "running" | "stopping" | "failed" = "stopped";
  #runtime: RuntimeStatusStore;
  #privacy: PrivacyControlStore;
  #store: Store;
  #maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #lastRuntimeEvent = 0;
  #sourceLastEventAt: Record<string, string> = {};
  #channelLastEventAt: Partial<Record<CaptureSourceStatus["channel"], string>> = {};
  #sourceReadiness: CaptureRuntimeStatus["sourceReadiness"] = {};
  #front = { app: "unknown", window: "" };

  #recordSourceStatus = (status: CaptureSourceStatus): void => {
    this.#sourceReadiness = {
      ...this.#sourceReadiness,
      [status.channel]: {
        status: status.status,
        ...(status.reason ? { reason: status.reason.slice(0, 160) } : {}),
        updatedAt: new Date().toISOString(),
      },
    };
    this.#runtime.write({ sourceReadiness: { ...this.#sourceReadiness } });
  };

  #recordSourceFailure(source: CaptureSource, failure: CaptureSourceFailure): void {
    if (
      this.#state === "stopped" ||
      this.#state === "stopping" ||
      this.#sourceFailures.has(source)
    ) return;

    const lastError = `${source.name} ${failure.reason}: ${failure.message}`;
    this.#sourceFailures.set(source, lastError);
    this.#started = this.#started.filter((candidate) => candidate !== source);
    const activeSources = this.#started.map((candidate) => candidate.name);
    log.error(`capture source failed: ${lastError}`);

    try {
      const stopping = source.stop();
      if (stopping && typeof stopping.then === "function") {
        void stopping.catch((error) => {
          log.warn(`failed-source cleanup failed for ${source.name}`, String(error));
        });
      }
    } catch (error) {
      log.warn(`failed-source cleanup failed for ${source.name}`, String(error));
    }

    // While startup is still in progress, leave the outer start transaction in
    // charge of rollback. The loop checks #sourceFailures after each awaited
    // source start and turns this into a rejected start.
    if (this.#state === "starting") {
      this.#runtime.write({
        state: "starting",
        activeSources,
        lastError,
      });
      return;
    }

    // There is no distinct "limited" runtime state. Remaining sources keep
    // running, while activeSources + readiness + lastError truthfully expose
    // the degraded native coverage. With no source left, capture has failed.
    if (activeSources.length > 0) {
      this.#state = "running";
      this.#runtime.write({ state: "running", activeSources, lastError });
      return;
    }

    this.#state = "failed";
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    if (this.#maintenanceTimer) clearInterval(this.#maintenanceTimer);
    this.#maintenanceTimer = undefined;
    this.#runtime.write({ state: "failed", activeSources: [], lastError });
  }

  constructor(
    store: Store,
    sources: CaptureSource[],
    opts: {
      privacy?: PrivacyControlStore;
      runtime?: RuntimeStatusStore;
      /** Explicit source options, or false to override the environment opt-in. */
      agentSessions?: AgentSessionsOptions | false;
    } = {},
  ) {
    this.#store = store;
    this.#runtime = opts.runtime ?? RuntimeStatusStore.forStore(store);
    this.#privacy = opts.privacy ?? PrivacyControlStore.forStore(store);
    this.#ingest = makeIngest(store, { privacy: this.#privacy, runtime: this.#runtime });
    // Agent-transcript ingestion is enabled by the packaged desktop. The same
    // ai_proxy privacy control that fences final ingest also fences file reads.
    const sessionOptions = opts.agentSessions === false
      ? undefined
      : opts.agentSessions ?? (
          process.env.PRAXIS_AGENT_SESSIONS === "1" ? {} : undefined
        );
    if (sessionOptions) {
      const callerFence = sessionOptions.canAcquire;
      const sessions = new AgentSessionsSource({
        ...sessionOptions,
        canAcquire: (file) => {
          const content = capturePolicyDecision(this.#privacy.read(), {
            source: "ai_proxy",
            app: "Claude Code",
            window: "agent_sessions",
            type: "agent_session_preflight",
            payload: { path: file },
          });
          return content.allowed && resourceCaptureDecision(
            this.#runtime.read().resources,
            "ai_proxy",
          ).allowed && (callerFence?.(file) ?? true);
        },
      });
      this.#sources = [...sources, sessions];
    } else {
      this.#sources = sources;
    }
    this.#ingest.subscribe((e: RawEvent) => {
      if (e.source === "focus_timeline" && e.type === "app_focused") {
        this.#front = { app: e.app, window: e.window };
      }
      this.#sourceLastEventAt[e.source] = e.ts;
      const channel = captureChannelForEvent(e);
      const firstChannelEvent = channel !== undefined && this.#channelLastEventAt[channel] === undefined;
      if (channel) this.#channelLastEventAt[channel] = e.ts;
      const now = Date.now();
      if (firstChannelEvent || now - this.#lastRuntimeEvent >= 5_000) {
        this.#lastRuntimeEvent = now;
        this.#runtime.write({
          lastEventAt: e.ts,
          sourceLastEventAt: { ...this.#sourceLastEventAt },
          channelLastEventAt: { ...this.#channelLastEventAt },
        });
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
    this.#sourceLastEventAt = {};
    this.#channelLastEventAt = {};
    this.#sourceReadiness = {};
    this.#sourceFailures.clear();
    this.#runtime.write({
      state: "starting",
      pid: process.pid,
      activeSources: [],
      sourceLastEventAt: {},
      channelLastEventAt: {},
      sourceReadiness: {},
      lastError: undefined,
    });
    try {
      // Publish before starting any source. Native clients may already be
      // alive, but remain fail-closed until this complete snapshot appears.
      this.#publishNativePolicy();
      this.#maintain();
      this.#maintenanceTimer = setInterval(() => this.#maintain(), 60 * 60_000);
      this.#maintenanceTimer.unref();
      for (const s of this.#sources) {
        log.info(`starting source: ${s.name}`);
        try {
          await s.start(
            this.#ingest.ingest,
            this.#recordSourceStatus,
            (failure) => this.#recordSourceFailure(s, failure),
          );
          const asynchronousFailure = [...this.#sourceFailures.values()].at(-1);
          if (asynchronousFailure) throw new Error(asynchronousFailure);
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
        if (this.#state !== "running") return;
        this.#runtime.write({
          state: "running",
          pid: process.pid,
          activeSources: this.#started.map((source) => source.name),
          sourceLastEventAt: { ...this.#sourceLastEventAt },
          channelLastEventAt: { ...this.#channelLastEventAt },
          sourceReadiness: { ...this.#sourceReadiness },
        });
        this.#publishNativePolicy();
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

  #publishNativePolicy(): void {
    try {
      publishNativeAcquisitionPolicy(this.#store, {
        privacy: this.#privacy,
        runtime: this.#runtime,
      });
    } catch (error) {
      // A missing/stale snapshot makes packaged native capture fail closed.
      // Surface the failure rather than weakening that invariant.
      log.error("native acquisition policy publication failed", String(error));
    }
  }
}

function captureChannelForEvent(
  event: RawEvent,
): CaptureSourceStatus["channel"] | undefined {
  if (event.source === "accessibility") return "accessibility";
  if (event.source === "screen_video" && event.type === "frame") return "screen_recording";
  if (event.source === "ai_proxy") return "agent_sessions";
  if (event.source !== "audio") return undefined;
  return event.payload.channel === "system"
    ? "audio_system"
    : event.payload.channel === "mic"
      ? "audio_mic"
      : undefined;
}
