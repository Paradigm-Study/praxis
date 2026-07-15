import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { BlobKind, EventSource } from "../../core/types.ts";
import type {
  CaptureSource,
  CaptureSourceFailure,
  CaptureSourceFailureReason,
  CaptureSourceFailureSink,
  CaptureSourceStatusSink,
  EventSink,
  RawEventInput,
} from "../source.ts";
import { logger } from "../../core/log.ts";

const log = logger("native");

/**
 * Wire format emitted by the Swift PraxisCapture client, one JSON object per
 * line on stdout. Large binary data (screen frames, audio) is written by Swift
 * to a temp file and referenced via `blobFiles`; this bridge reads each file,
 * offloads it to the content-addressed blob store, and deletes the temp file.
 */
interface NativeWireEvent {
  ts?: string;
  source?: unknown;
  app?: unknown;
  window?: unknown;
  type?: unknown;
  payload?: unknown;
  blobFiles?: unknown;
}

export interface NativeBridgeOptions {
  /** Must match PraxisCaptureKit's dedicated temporary blob directory. */
  blobDir?: string;
  /** Metadata-only privacy/resource fence, called before any blob bytes are read. */
  canAcquire?: (event: RawEventInput) => boolean;
}

const DEFAULT_NATIVE_BLOB_DIR = join(tmpdir(), "praxis-frames");
const MAX_NATIVE_BLOBS_PER_EVENT = 4;
const UUID_FILE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NATIVE_BLOB_NAMES: Partial<Record<BlobKind, RegExp>> = {
  image: new RegExp(`^${UUID_FILE}\\.png$`, "i"),
  video: new RegExp(`^${UUID_FILE}\\.mp4$`, "i"),
  text: new RegExp(`^${UUID_FILE}\\.txt$`, "i"),
  audio: new RegExp(`^${UUID_FILE}\\.(?:m4a|wav|caf)$`, "i"),
};
const NATIVE_BLOB_LIMITS: Partial<Record<BlobKind, number>> = {
  image: 32 * 1024 * 1024,
  video: 128 * 1024 * 1024,
  text: 8 * 1024 * 1024,
  audio: 64 * 1024 * 1024,
};
const NATIVE_EVENT_SOURCES = new Set<EventSource>([
  "screen_video",
  "accessibility",
  "input_events",
  "focus_timeline",
  "clipboard",
  "audio",
]);
const NATIVE_STATUS_CHANNELS = [
  "accessibility",
  "screen_recording",
  "audio_system",
  "audio_mic",
] as const;
const NATIVE_SOURCE_BLOB_KINDS: Partial<Record<EventSource, readonly BlobKind[]>> = {
  screen_video: ["image", "video"],
  accessibility: ["text"],
  clipboard: ["text"],
  audio: ["audio", "text"],
};

interface NativeBlobRoot {
  lexical: string;
  real: string;
}

interface OwnedNativeBlob {
  fd: number;
  path: string;
  realPath: string;
  root: NativeBlobRoot;
  stat: Stats;
}

/**
 * Bridges the native macOS capture client (ScreenCaptureKit / CGEventTap /
 * Accessibility) into the TypeScript ingest pipeline. The Swift process needs
 * Screen Recording + Accessibility TCC permissions to emit real data; without
 * them it still launches and emits focus/input metadata where allowed.
 */
export class NativeCaptureSource implements CaptureSource {
  readonly name = "native";
  readonly source = "screen_video" as const; // multiplexes several sources
  #cmd: string;
  #args: string[];
  #proc: ChildProcess | undefined;
  #policyPath: string | undefined;
  #bridgeOptions: NativeBridgeOptions;
  #generation = 0;

  constructor(
    opts: NativeBridgeOptions & {
      command?: string;
      args?: string[];
      packagePath?: string;
      policyPath?: string;
    } = {},
  ) {
    this.#policyPath = opts.policyPath;
    this.#bridgeOptions = {
      ...(opts.blobDir ? { blobDir: opts.blobDir } : {}),
      ...(opts.canAcquire ? { canAcquire: opts.canAcquire } : {}),
    };
    const pkg = opts.packagePath ?? "native/PraxisCapture";
    if (opts.command) {
      this.#cmd = opts.command;
      this.#args = opts.args ?? [];
      return;
    }
    // Resolution order: bundled binary (set by the Praxis.app bar so the TCC
    // identity stays with the signed app) → prebuilt binary → `swift run`.
    const envBin = process.env.PRAXIS_NATIVE_BIN;
    if (envBin && existsSync(envBin)) {
      this.#cmd = envBin;
      this.#args = opts.args ?? [];
      return;
    }
    const prebuilt = [
      join(pkg, ".build", "release", "praxis-capture"),
      join(pkg, ".build", "debug", "praxis-capture"),
    ].find((p) => existsSync(p));
    if (prebuilt) {
      this.#cmd = prebuilt;
      this.#args = opts.args ?? [];
      return;
    }
    this.#cmd = "swift";
    this.#args = opts.args ?? ["run", "--package-path", pkg, "praxis-capture"];
  }

  start(
    sink: EventSink,
    statusSink?: CaptureSourceStatusSink,
    failureSink?: CaptureSourceFailureSink,
  ): Promise<void> {
    const generation = ++this.#generation;
    log.info(`spawning native client: ${this.#cmd} ${this.#args.join(" ")}`);
    let proc: ChildProcess;
    try {
      proc = spawn(this.#cmd, this.#args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(this.#policyPath
            ? {
                PRAXIS_NATIVE_POLICY_PATH: this.#policyPath,
                PRAXIS_NATIVE_POLICY_MODE: "required",
              }
            : {}),
        },
      });
    } catch (error) {
      reportNativeUnavailable(statusSink, "start-failed");
      log.error(`native client failed to start: ${String(error)}`);
      throw error;
    }
    this.#proc = proc;
    let terminated = false;

    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        if (!terminated && generation === this.#generation) {
          this.#onLine(line, sink, statusSink);
        }
      });
    }
    // Surface the native client's diagnostics (incl. its permission self-report
    // "accessibility=… screenRecording=…") so capture.log shows the real state.
    proc.stderr?.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        const t = line.trim();
        if (t) log.info(`native » ${t}`);
      }
    });
    return new Promise<void>((resolveStart, rejectStart) => {
      let spawned = false;
      let startSettled = false;
      let failureReported = false;
      const reportFailure = (failure: CaptureSourceFailure): void => {
        if (failureReported || generation !== this.#generation) return;
        failureReported = true;
        reportNativeUnavailable(statusSink, failure.reason);
        if (!startSettled) {
          startSettled = true;
          rejectStart(new Error(failure.message));
          return;
        }
        try {
          failureSink?.(failure);
        } catch (error) {
          log.error("native failure callback failed", String(error));
        }
      };

      proc.once("spawn", () => {
        if (generation !== this.#generation || startSettled) return;
        spawned = true;
        startSettled = true;
        resolveStart();
      });
      proc.once("error", (error) => {
        terminated = true;
        const reason: CaptureSourceFailureReason = spawned
          ? "process-exited"
          : "start-failed";
        const message = spawned
          ? `native client process error: ${String(error)}`
          : `native client failed to start: ${String(error)}`;
        log.error(message);
        if (!spawned && this.#proc === proc) this.#proc = undefined;
        reportFailure({ reason, message });
      });
      // `close` follows `exit` only after stdout/stderr close, so a buffered
      // late "ready" line cannot overwrite the unavailable terminal state.
      proc.once("close", (code, signal) => {
        terminated = true;
        if (this.#proc === proc) this.#proc = undefined;
        if (generation !== this.#generation) return;
        const detail = code !== null
          ? `code ${code}`
          : signal
            ? `signal ${signal}`
            : "unknown status";
        const reason: CaptureSourceFailureReason = spawned
          ? "process-exited"
          : "start-failed";
        const message = spawned
          ? `native client exited unexpectedly (${detail})`
          : `native client failed before startup (${detail})`;
        log.error(message);
        reportFailure({
          reason,
          message,
          ...(code === null ? {} : { exitCode: code }),
          ...(signal === null ? {} : { signal }),
        });
      });
    });
  }

  #onLine(
    line: string,
    sink: EventSink,
    statusSink?: CaptureSourceStatusSink,
  ): void {
    processNativeLine(line, sink, statusSink, this.#bridgeOptions);
  }

  stop(): void {
    this.#generation += 1;
    this.#proc?.kill("SIGTERM");
    this.#proc = undefined;
  }
}

function reportNativeUnavailable(
  statusSink: CaptureSourceStatusSink | undefined,
  reason: CaptureSourceFailureReason,
): void {
  for (const channel of NATIVE_STATUS_CHANNELS) {
    try {
      statusSink?.({ channel, status: "unavailable", reason });
    } catch (error) {
      // One failed status write must not prevent the lifecycle failure itself
      // from reaching CaptureManager.
      log.error(`native ${channel} readiness callback failed`, String(error));
    }
  }
}

/** Parse one NDJSON line from the native client and feed the sink. */
export function processNativeLine(
  line: string,
  sink: EventSink,
  statusSink?: CaptureSourceStatusSink,
  options: NativeBridgeOptions = {},
): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let ev: NativeWireEvent;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return;
    ev = parsed as NativeWireEvent;
  } catch {
    log.debug("non-JSON native line", trimmed.slice(0, 80));
    return;
  }
  if (ev.type === "source_status") {
    if (ev.source !== "capture_control") {
      log.debug("invalid native readiness source");
      return;
    }
    const payload = isRecord(ev.payload) ? ev.payload : {};
    const channel = payload.channel;
    const status = payload.status;
    if (
      (
        channel === "accessibility" ||
        channel === "screen_recording" ||
        channel === "audio_system" ||
        channel === "audio_mic"
      ) &&
      (
        status === "disabled" ||
        status === "ready" ||
        status === "blocked" ||
        status === "unavailable"
      )
    ) {
      const reason = payload.reason;
      statusSink?.({
        channel,
        status,
        ...(typeof reason === "string" && reason
          ? { reason: reason.slice(0, 160) }
          : {}),
      });
    }
    return;
  }

  if (
    !isNativeEventSource(ev.source) ||
    typeof ev.app !== "string" ||
    typeof ev.window !== "string" ||
    typeof ev.type !== "string" ||
    (ev.ts !== undefined && typeof ev.ts !== "string") ||
    (ev.payload !== undefined && !isRecord(ev.payload))
  ) {
    log.debug("invalid native event envelope");
    return;
  }

  const event: RawEventInput = {
    source: ev.source,
    app: ev.app,
    window: ev.window,
    type: ev.type,
    ...(ev.ts ? { ts: ev.ts } : {}),
    payload: ev.payload ?? {},
  };
  let acquisitionAllowed = true;
  if (options.canAcquire) {
    try {
      acquisitionAllowed = options.canAcquire(event);
    } catch (error) {
      acquisitionAllowed = false;
      log.debug("native blob privacy preflight failed", String(error));
    }
  }

  const blobs: Array<{ kind: BlobKind; data: Uint8Array }> = [];
  const blobFiles = Array.isArray(ev.blobFiles)
    ? ev.blobFiles.slice(0, MAX_NATIVE_BLOBS_PER_EVENT)
    : [];
  const root = blobFiles.length > 0
    ? resolveNativeBlobRoot(options.blobDir ?? DEFAULT_NATIVE_BLOB_DIR)
    : undefined;
  for (const value of blobFiles) {
    if (!root || !isRecord(value) || !isNativeBlobKind(ev.source, value.kind) || typeof value.path !== "string") {
      log.debug("invalid native blob reference");
      continue;
    }
    const owned = openOwnedNativeBlob(root, value.kind, value.path);
    if (!owned) {
      log.debug("native blob path rejected");
      continue;
    }
    try {
      if (acquisitionAllowed) {
        blobs.push({ kind: value.kind, data: readOwnedNativeBlob(owned) });
      }
      // A denied event still must not leave sensitive producer-owned temp
      // bytes behind. The inode is rechecked immediately before unlink.
      if (!unlinkOwnedNativeBlob(owned)) log.debug("native blob cleanup skipped after identity changed");
    } catch (error) {
      log.debug("native blob unreadable", String(error));
    } finally {
      closeSync(owned.fd);
    }
  }
  sink({ ...event, blobs });
}

function resolveNativeBlobRoot(path: string): NativeBlobRoot | undefined {
  try {
    const lexical = resolve(path);
    const stat = lstatSync(lexical);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !ownedByCurrentUser(stat) ||
      (stat.mode & 0o077) !== 0
    ) return undefined;
    return { lexical, real: realpathSync(lexical) };
  } catch {
    return undefined;
  }
}

function openOwnedNativeBlob(
  root: NativeBlobRoot,
  kind: BlobKind,
  inputPath: string,
): OwnedNativeBlob | undefined {
  let fd: number | undefined;
  try {
    if (!isAbsolute(inputPath)) return undefined;
    const path = resolve(inputPath);
    if (
      dirname(path) !== root.lexical ||
      !NATIVE_BLOB_NAMES[kind]?.test(basename(path))
    ) return undefined;

    const before = lstatSync(path);
    if (!validOwnedBlobStat(before, kind)) return undefined;
    const realPath = realpathSync(path);
    if (dirname(realPath) !== root.real) return undefined;
    if (realpathSync(root.lexical) !== root.real) return undefined;

    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(fd);
    if (
      !sameFile(before, opened) ||
      !validOwnedBlobStat(opened, kind) ||
      realpathSync(path) !== realPath ||
      dirname(realPath) !== root.real
    ) {
      closeSync(fd);
      return undefined;
    }
    return { fd, path, realPath, root, stat: opened };
  } catch {
    if (fd !== undefined) closeSync(fd);
    return undefined;
  }
}

function readOwnedNativeBlob(blob: OwnedNativeBlob): Uint8Array {
  const data = Buffer.alloc(blob.stat.size);
  let offset = 0;
  while (offset < data.length) {
    const read = readSync(blob.fd, data, offset, data.length - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  const after = fstatSync(blob.fd);
  if (offset !== data.length || !sameFile(blob.stat, after) || after.size !== blob.stat.size) {
    throw new Error("native blob changed while being read");
  }
  return data;
}

function unlinkOwnedNativeBlob(blob: OwnedNativeBlob): boolean {
  try {
    const current = lstatSync(blob.path);
    if (
      !sameFile(blob.stat, current) ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      !ownedByCurrentUser(current) ||
      realpathSync(blob.path) !== blob.realPath ||
      dirname(blob.realPath) !== blob.root.real ||
      realpathSync(blob.root.lexical) !== blob.root.real
    ) return false;
    unlinkSync(blob.path);
    return true;
  } catch {
    return false;
  }
}

function validOwnedBlobStat(stat: Stats, kind: BlobKind): boolean {
  const limit = NATIVE_BLOB_LIMITS[kind];
  return stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    ownedByCurrentUser(stat) &&
    (stat.mode & 0o077) === 0 &&
    Number.isSafeInteger(stat.size) &&
    stat.size > 0 &&
    limit !== undefined &&
    stat.size <= limit;
}

function ownedByCurrentUser(stat: Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isNativeEventSource(value: unknown): value is EventSource {
  return typeof value === "string" && NATIVE_EVENT_SOURCES.has(value as EventSource);
}

function isNativeBlobKind(source: EventSource, value: unknown): value is BlobKind {
  return typeof value === "string" &&
    (NATIVE_SOURCE_BLOB_KINDS[source]?.includes(value as BlobKind) ?? false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads native NDJSON from this process's stdin. The packaged Praxis.app spawns
 * `praxis-capture` as a DIRECT child (so screen/AX requests are attributed to
 * the granted app, not to node) and pipes its stdout into a node process running
 * `capture --native-stdin`, which uses this source.
 */
export class StdinNativeSource implements CaptureSource {
  readonly name = "native-stdin";
  readonly source = "screen_video" as const;
  #rl: ReturnType<typeof createInterface> | undefined;
  #options: NativeBridgeOptions;
  #stopping = false;

  constructor(options: NativeBridgeOptions = {}) {
    this.#options = options;
  }

  start(
    sink: EventSink,
    statusSink?: CaptureSourceStatusSink,
    failureSink?: CaptureSourceFailureSink,
  ): void {
    this.#stopping = false;
    this.#rl = createInterface({ input: process.stdin });
    this.#rl.on("line", (line) => processNativeLine(line, sink, statusSink, this.#options));
    this.#rl.once("close", () => {
      this.#rl = undefined;
      if (this.#stopping) return;
      reportNativeUnavailable(statusSink, "process-exited");
      try {
        failureSink?.({
          reason: "process-exited",
          message: "native input stream closed unexpectedly",
        });
      } catch (error) {
        log.error("native input failure callback failed", String(error));
      }
    });
    log.info("reading native events from stdin");
  }

  stop(): void {
    this.#stopping = true;
    this.#rl?.close();
    this.#rl = undefined;
  }
}
