import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { BlobKind, EventSource } from "../../core/types.ts";
import type { CaptureSource, EventSink } from "../source.ts";
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
  source: string;
  app: string;
  window: string;
  type: string;
  payload?: Record<string, unknown>;
  blobFiles?: Array<{ kind: BlobKind; path: string }>;
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

  constructor(
    opts: {
      command?: string;
      args?: string[];
      packagePath?: string;
      policyPath?: string;
    } = {},
  ) {
    this.#policyPath = opts.policyPath;
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

  #policyPath: string | undefined;

  start(sink: EventSink): void {
    log.info(`spawning native client: ${this.#cmd} ${this.#args.join(" ")}`);
    const proc = spawn(this.#cmd, this.#args, {
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
    this.#proc = proc;

    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => this.#onLine(line, sink));
    }
    // Surface the native client's diagnostics (incl. its permission self-report
    // "accessibility=… screenRecording=…") so capture.log shows the real state.
    proc.stderr?.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        const t = line.trim();
        if (t) log.info(`native » ${t}`);
      }
    });
    proc.on("error", (err) =>
      log.error(`native client failed to start: ${String(err)}`),
    );
    proc.on("exit", (code) => log.info(`native client exited (${code})`));
  }

  #onLine(line: string, sink: EventSink): void {
    processNativeLine(line, sink);
  }

  stop(): void {
    this.#proc?.kill("SIGTERM");
    this.#proc = undefined;
  }
}

/** Parse one NDJSON line from the native client and feed the sink. */
export function processNativeLine(line: string, sink: EventSink): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let ev: NativeWireEvent;
  try {
    ev = JSON.parse(trimmed) as NativeWireEvent;
  } catch {
    log.debug("non-JSON native line", trimmed.slice(0, 80));
    return;
  }
  const blobs: Array<{ kind: BlobKind; data: Uint8Array }> = [];
  for (const bf of ev.blobFiles ?? []) {
    try {
      blobs.push({ kind: bf.kind, data: readFileSync(bf.path) });
      rmSync(bf.path, { force: true });
    } catch (err) {
      log.debug(`blob file unreadable: ${bf.path}`, String(err));
    }
  }
  sink({
    source: ev.source as EventSource,
    app: ev.app,
    window: ev.window,
    type: ev.type,
    ts: ev.ts,
    payload: ev.payload ?? {},
    blobs,
  });
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

  start(sink: EventSink): void {
    this.#rl = createInterface({ input: process.stdin });
    this.#rl.on("line", (line) => processNativeLine(line, sink));
    log.info("reading native events from stdin");
  }

  stop(): void {
    this.#rl?.close();
  }
}
