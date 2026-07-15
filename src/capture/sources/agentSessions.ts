import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { EventSource } from "../../core/types.ts";
import { sha256 } from "../../core/hash.ts";
import { logger } from "../../core/log.ts";
import type {
  CaptureSource,
  CaptureSourceStatusSink,
  EventSink,
  RawEventInput,
} from "../source.ts";
import { looksLikeSensitiveContent } from "../../privacy/contentFilter.ts";

const log = logger("agent_sessions");
const PREVIEW_LENGTH = 200;
const REDACTED_TRANSCRIPT_TEXT = "[redacted sensitive content]";
const INTERNAL_BLOCK = /<(system-reminder|local-command-caveat|user-prompt-submit-hook|session-start-hook|pre-tool-use-hook|post-tool-use-hook|local-command-stdout|local-command-stderr)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;
const MAX_TRANSCRIPT_BACKLOG_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_READ_BYTES_PER_POLL = 256 * 1024;
const MAX_TRANSCRIPT_LINE_BYTES = 1024 * 1024;
const MAX_TRACKED_TRANSCRIPTS = 4_096;

type JsonObject = Record<string, unknown>;

interface FileState {
  offset: number;
  buffer: string;
  decoder: StringDecoder;
  discardingLine: boolean;
  dev?: number;
  ino?: number;
}

interface TranscriptRoot {
  lexical: string;
  real: string;
  dev: number;
  ino: number;
}

interface OpenTranscript {
  fd: number;
  size: number;
  dev: number;
  ino: number;
}

interface TranscriptScan {
  files: string[];
  complete: boolean;
  root?: TranscriptRoot;
}

interface SuppressedAgentTurn {
  toolUseIds: Set<string>;
}

function fileState(offset = 0, identity?: { dev: number; ino: number }): FileState {
  return {
    offset,
    buffer: "",
    decoder: new StringDecoder("utf8"),
    discardingLine: false,
    ...(identity === undefined ? {} : identity),
  };
}

function isContainedPath(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ""
    && child !== ".."
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child);
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safePreview(text: string): { preview: string; contentRedacted?: true } {
  return looksLikeSensitiveContent(text)
    ? { preview: REDACTED_TRANSCRIPT_TEXT, contentRedacted: true }
    : { preview: text.slice(0, PREVIEW_LENGTH) };
}

function textPayload(text: string): {
  textHash: string;
  preview: string;
  contentRedacted?: true;
} {
  return {
    textHash: sha256(text),
    ...safePreview(text),
  };
}

function humanText(text: string): string | undefined {
  const cleaned = text
    .replace(INTERNAL_BLOCK, " ")
    .replace(/<(?:command-name|command-message|command-args|hook-context)(?:\s[^>]*)?>[\s\S]*?<\/(?:command-name|command-message|command-args|hook-context)>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;

  const parts: string[] = [];
  for (const item of value) {
    const block = object(item);
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

export interface TranscriptLineContext {
  sessionKey?: string;
  cwd?: string;
}

/** Convert one Claude Code transcript line into privacy-safe capture inputs. */
export function transcriptLineToInputs(
  line: string,
  fallback?: TranscriptLineContext,
): RawEventInput[] {
  let envelope: JsonObject;
  try {
    const parsed = JSON.parse(line) as unknown;
    const parsedObject = object(parsed);
    if (!parsedObject) return [];
    envelope = parsedObject;
  } catch {
    return [];
  }

  if (
    (envelope.type !== "user" && envelope.type !== "assistant") ||
    Object.prototype.hasOwnProperty.call(envelope, "attachment") ||
    envelope.isSidechain === true ||
    envelope.isMeta === true ||
    envelope.isCompactSummary === true
  ) {
    return [];
  }

  const message = object(envelope.message);
  if (!message) return [];
  if (
    message.isSidechain === true ||
    message.isMeta === true ||
    message.isCompactSummary === true
  ) return [];

  const knownSessionKey = string(envelope.sessionId) ?? fallback?.sessionKey;
  const sessionKey = knownSessionKey ?? "unknown";
  const cwd = string(envelope.cwd) ?? fallback?.cwd;
  const window = cwd !== undefined ? basename(cwd) : (knownSessionKey ?? "agent");
  const ts = string(envelope.timestamp);

  const makeInput = (
    type: "ai_request" | "ai_response",
    payload: Record<string, unknown>,
  ): RawEventInput => ({
    ...(ts === undefined ? {} : { ts }),
    source: "ai_proxy",
    app: "Claude Code",
    window,
    type,
    payload: {
      sessionKey,
      ...(cwd === undefined ? {} : { cwd }),
      ...payload,
    },
  });

  if (envelope.type === "user") {
    const content = message.content;
    if (typeof content === "string") {
      const text = humanText(content);
      return text
        ? [makeInput("ai_request", { role: "user", ...textPayload(text) })]
        : [];
    }
    if (!Array.isArray(content)) return [];

    const inputs: RawEventInput[] = [];
    const rawUserText = textFromContent(content);
    const userText = rawUserText === undefined ? undefined : humanText(rawUserText);
    const hasTextBlock = userText !== undefined && content.some((item) => {
      const block = object(item);
      return block?.type === "text" && typeof block.text === "string";
    });
    if (hasTextBlock && userText !== undefined) {
      inputs.push(
        makeInput("ai_request", { role: "user", ...textPayload(userText) }),
      );
    }

    for (const item of content) {
      const block = object(item);
      if (block?.type !== "tool_result") continue;
      const resultText = textFromContent(block.content);
      if (resultText === undefined) continue;
      const toolUseId = string(block.tool_use_id);
      inputs.push(
        makeInput("ai_request", {
          role: "tool_result",
          // Shape the error-rules channel expects (reconstructor/rules/errors.ts
          // matches payload.type === "tool_result" plus payload.is_error): a
          // failed tool call becomes an `encountered_error` candidate.
          type: "tool_result",
          ...(block.is_error === true ? { is_error: true } : {}),
          ...(toolUseId === undefined ? {} : { toolUseId }),
          ...textPayload(resultText),
        }),
      );
    }
    return inputs;
  }

  if (!Array.isArray(message.content)) return [];

  const inputs: RawEventInput[] = [];
  for (const item of message.content) {
    const block = object(item);
    if (!block || block.type === "thinking") continue;

    if (block.type === "text" && typeof block.text === "string") {
      const stopReason = string(message.stop_reason);
      const model = string(message.model);
      inputs.push(
        makeInput("ai_response", {
          role: "assistant",
          ...(stopReason === undefined ? {} : { stopReason }),
          ...(model === undefined ? {} : { model }),
          ...textPayload(block.text),
        }),
      );
      continue;
    }

    if (block.type !== "tool_use") continue;
    const tool = string(block.name);
    const toolUseId = string(block.id);
    const input = object(block.input);
    const filePath = string(input?.file_path);
    const fullCommand = string(input?.command);
    const command = fullCommand === undefined
      ? undefined
      : safePreview(fullCommand).preview;
    inputs.push(
      makeInput("ai_response", {
        role: "assistant",
        ...(tool === undefined ? {} : { tool }),
        ...(toolUseId === undefined ? {} : { toolUseId }),
        ...(filePath === undefined ? {} : { filePath }),
        ...(fullCommand === undefined
          ? {}
          : { command, ...textPayload(fullCommand) }),
      }),
    );
  }
  return inputs;
}

export interface AgentSessionsOptions {
  /** Transcript directories to watch. Builder supplies sensible defaults. */
  dirs?: string[];
  /** Poll interval in ms. */
  pollMs?: number;
  /**
   * Acquisition-time privacy fence. When false, the source advances to the
   * current file size without reading transcript bytes, so content produced
   * while blocked cannot be replayed after capture is re-enabled.
   */
  canAcquire?: (file: string) => boolean;
}

/** Tails Claude Code JSONL transcripts and emits new, privacy-safe events. */
export class AgentSessionsSource implements CaptureSource {
  readonly name = "agent_sessions";
  readonly source: EventSource = "ai_proxy";
  #dirs: string[];
  #pollMs: number;
  #canAcquire: (file: string) => boolean;
  #files = new Map<string, FileState>();
  #roots = new Map<string, TranscriptRoot>();
  #invalidRoots = new Set<string>();
  #suppressedTurns = new Map<string, SuppressedAgentTurn>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #statusSink: CaptureSourceStatusSink | undefined;
  #availability: "ready" | "unavailable" | undefined;

  constructor(opts: AgentSessionsOptions = {}) {
    this.#dirs = (opts.dirs ?? [join(homedir(), ".claude", "projects")]).map((dir) =>
      resolve(dir));
    this.#pollMs = opts.pollMs ?? 2000;
    this.#canAcquire = opts.canAcquire ?? (() => true);
  }

  start(sink: EventSink, statusSink?: CaptureSourceStatusSink): void {
    this.stop();
    this.#statusSink = statusSink;

    for (const dir of this.#dirs) {
      if (!existsSync(dir)) {
        log.warn(`transcript directory ${dir} not found`);
        continue;
      }
      for (const file of this.#scan(dir).files) {
        let opened: OpenTranscript | undefined;
        try {
          opened = this.#openTranscript(file);
          if (opened) {
            this.#files.set(file, fileState(opened.size, opened));
          }
        } catch (err) {
          log.debug(`initial scan failed for ${file}`, String(err));
        } finally {
          if (opened !== undefined) {
            try {
              closeSync(opened.fd);
            } catch (err) {
              log.debug(`failed to close transcript ${file}`, String(err));
            }
          }
        }
      }
    }

    this.#reportAvailability();

    this.#timer = setInterval(() => this.#poll(sink), this.#pollMs);
    this.#timer.unref();
  }

  #root(dir: string): TranscriptRoot | undefined {
    const lexical = resolve(dir);
    if (this.#invalidRoots.has(lexical)) return undefined;
    try {
      const real = realpathSync.native(lexical);
      const stats = statSync(real);
      const pinned = this.#roots.get(lexical);
      if (!stats.isDirectory()) {
        if (pinned) this.#invalidRoots.add(lexical);
        return undefined;
      }
      if (pinned) {
        if (pinned.real === real && pinned.dev === stats.dev && pinned.ino === stats.ino) {
          return pinned;
        }
        // A configured root that changes identity stays failed closed for this
        // source lifetime; silently re-pinning would authorize a retarget.
        this.#invalidRoots.add(lexical);
        return undefined;
      }
      const root = { lexical, real, dev: stats.dev, ino: stats.ino };
      this.#roots.set(lexical, root);
      return root;
    } catch {
      return undefined;
    }
  }

  #openTranscript(file: string): OpenTranscript | undefined {
    let fd: number | undefined;
    try {
      const lexical = resolve(file);
      const root = this.#dirs
        .map((dir) => this.#root(dir))
        .find((candidate): candidate is TranscriptRoot =>
          candidate !== undefined
          && (
            isContainedPath(candidate.lexical, lexical)
            || isContainedPath(candidate.real, lexical)
          ));
      if (!root) return undefined;

      const before = lstatSync(lexical);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return undefined;
      if (typeof process.getuid === "function" && before.uid !== process.getuid()) return undefined;
      const real = realpathSync.native(lexical);
      if (!isContainedPath(root.real, real)) return undefined;

      fd = openSync(
        lexical,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const after = fstatSync(fd);
      if (
        !after.isFile()
        || after.nlink !== 1
        || after.dev !== before.dev
        || after.ino !== before.ino
        || (typeof process.getuid === "function" && after.uid !== process.getuid())
      ) {
        closeSync(fd);
        return undefined;
      }
      return {
        fd,
        size: after.size,
        dev: after.dev,
        ino: after.ino,
      };
    } catch {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Best effort after a failed validation/open.
        }
      }
      return undefined;
    }
  }

  #scan(dir: string): TranscriptScan {
    const root = this.#root(dir);
    if (!root) return { files: [], complete: false };
    const files: string[] = [];
    const pending = [root.real];
    const visited = new Set<string>();
    let complete = true;
    while (pending.length > 0) {
      try {
        const current = pending.pop()!;
        const currentStats = lstatSync(current);
        if (!currentStats.isDirectory() || currentStats.isSymbolicLink()) continue;
        const realCurrent = realpathSync.native(current);
        if (realCurrent !== root.real && !isContainedPath(root.real, realCurrent)) continue;
        const identity = `${currentStats.dev}:${currentStats.ino}`;
        if (visited.has(identity)) continue;
        visited.add(identity);

        for (const entry of readdirSync(current, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          const full = join(current, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== "subagents") pending.push(full);
            continue;
          }
          if (
            entry.isFile()
            && entry.name.endsWith(".jsonl")
            && !/^agent-.*\.jsonl$/i.test(entry.name)
          ) {
            if (files.length >= MAX_TRACKED_TRANSCRIPTS) {
              complete = false;
              pending.length = 0;
              break;
            }
            files.push(full);
          }
        }
      } catch (err) {
        complete = false;
        log.debug(`transcript scan failed for ${dir}`, String(err));
      }
    }
    return { files, complete, root };
  }

  #poll(sink: EventSink): void {
    const currentFiles = new Set<string>();
    const completedRoots: TranscriptRoot[] = [];
    for (const dir of this.#dirs) {
      const scan = this.#scan(dir);
      if (scan.complete && scan.root) completedRoots.push(scan.root);
      for (const file of scan.files) {
        currentFiles.add(file);
        if (!this.#files.has(file)) {
          if (this.#files.size >= MAX_TRACKED_TRANSCRIPTS) continue;
          this.#files.set(file, fileState());
        }
      }
    }

    for (const file of this.#files.keys()) {
      const safelyAbsent = completedRoots.some((root) =>
        isContainedPath(root.real, file) && !currentFiles.has(file));
      const invalidated = this.#dirs.some((dir) => {
        const lexical = resolve(dir);
        const root = this.#roots.get(lexical);
        return root !== undefined
          && this.#invalidRoots.has(lexical)
          && isContainedPath(root.real, file);
      });
      if (safelyAbsent || invalidated) this.#files.delete(file);
    }

    for (const [file, state] of this.#files) {
      this.#drain(file, state, sink);
    }
    this.#reportAvailability();
  }

  #reportAvailability(): void {
    const status = this.#dirs.some((dir) => this.#root(dir) !== undefined)
      ? "ready" as const
      : "unavailable" as const;
    if (status === this.#availability) return;
    this.#availability = status;
    this.#statusSink?.({
      channel: "agent_sessions",
      status,
      ...(status === "unavailable"
        ? {
            reason: this.#invalidRoots.size > 0
              ? "transcript-root-changed"
              : "transcript-directory-missing",
          }
        : {}),
    });
  }

  #resetFileState(
    state: FileState,
    identity: { dev: number; ino: number },
    offset = 0,
  ): void {
    state.offset = offset;
    state.buffer = "";
    state.decoder = new StringDecoder("utf8");
    state.discardingLine = false;
    state.dev = identity.dev;
    state.ino = identity.ino;
  }

  #consumeDecoded(
    state: FileState,
    text: string,
    fallback: TranscriptLineContext,
    sink: EventSink,
  ): void {
    let pending = text;
    if (state.discardingLine) {
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      pending = pending.slice(newline + 1);
      state.discardingLine = false;
    }
    state.buffer += pending;

    let newline: number;
    while ((newline = state.buffer.indexOf("\n")) >= 0) {
      const rawLine = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      if (Buffer.byteLength(rawLine, "utf8") > MAX_TRANSCRIPT_LINE_BYTES) continue;
      const line = rawLine.trim();
      if (!line) continue;
      for (const input of transcriptLineToInputs(line, fallback)) {
        this.#emitPrivacyCorrelated(input, sink);
      }
    }

    if (Buffer.byteLength(state.buffer, "utf8") > MAX_TRANSCRIPT_LINE_BYTES) {
      state.buffer = "";
      state.decoder = new StringDecoder("utf8");
      state.discardingLine = true;
    }
  }

  #drain(file: string, state: FileState, sink: EventSink): void {
    let opened: OpenTranscript | undefined;
    try {
      opened = this.#openTranscript(file);
      if (!opened) return;
      if (state.dev !== opened.dev || state.ino !== opened.ino) {
        // Atomic transcript rotation can replace a path with a same-sized file.
        // Inode identity, not only size, decides whether the new file starts at 0.
        this.#resetFileState(state, opened);
      }
      if (!this.#canAcquire(file)) {
        // Baseline without reading. This mirrors the native clipboard privacy
        // fence: bytes created while capture is blocked are never acquired or
        // surfaced after the user resumes.
        this.#resetFileState(state, opened, opened.size);
        return;
      }
      if (opened.size < state.offset) {
        // Claude can rotate/truncate a transcript in place. Treat the current
        // file as new rather than waiting for it to exceed the old size.
        this.#resetFileState(state, opened);
      }
      if (opened.size <= state.offset) return;

      const backlog = opened.size - state.offset;
      if (backlog > MAX_TRANSCRIPT_BACKLOG_BYTES) {
        // Never allocate or progressively replay an untrusted sparse/huge
        // backlog. Future appends begin from this safe baseline.
        this.#resetFileState(state, opened, opened.size);
        return;
      }
      const length = Math.min(backlog, MAX_TRANSCRIPT_READ_BYTES_PER_POLL);
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = readSync(opened.fd, chunk, 0, length, state.offset);
      if (bytesRead <= 0) return;
      state.offset += bytesRead;

      const fallback: TranscriptLineContext = {
        sessionKey: basename(file, ".jsonl"),
      };
      this.#consumeDecoded(
        state,
        state.decoder.write(chunk.subarray(0, bytesRead)),
        fallback,
        sink,
      );
    } catch (err) {
      log.debug(`transcript drain failed for ${file}`, String(err));
    } finally {
      if (opened !== undefined) {
        try {
          closeSync(opened.fd);
        } catch (err) {
          log.debug(`failed to close transcript ${file}`, String(err));
        }
      }
    }
  }

  #emitPrivacyCorrelated(input: RawEventInput, sink: EventSink): void {
    const payload = input.payload ?? {};
    const sessionKey = string(payload.sessionKey) ?? "unknown";
    const role = string(payload.role);
    const turn = this.#suppressedTurns.get(sessionKey);

    if (input.type === "ai_request" && role === "user") {
      // Only a human request that clears the final ingest fence starts a fresh
      // provenance chain. If the request itself is excluded, derived output
      // remains quarantined rather than silently re-opening the turn.
      const emitted = sink(input);
      if (emitted.id.startsWith("suppressed_")) {
        if (!turn) this.#suppressedTurns.set(sessionKey, { toolUseIds: new Set() });
      } else {
        this.#suppressedTurns.delete(sessionKey);
      }
      return;
    }

    if (turn) {
      if (role === "tool_result") {
        const toolUseId = string(payload.toolUseId);
        if (toolUseId !== undefined && turn.toolUseIds.has(toolUseId)) {
          turn.toolUseIds.delete(toolUseId);
        }
        // A multi-tool assistant message can issue a visible tool before an
        // excluded one. Its result still belongs to the same tainted turn, so
        // every tool_result remains quarantined, not only the matching ID.
        return;
      }
      if (role === "assistant") {
        const toolUseId = string(payload.toolUseId);
        if (typeof payload.tool === "string" && toolUseId !== undefined) {
          turn.toolUseIds.add(toolUseId);
        }
      }
      // Matching tool results and all later assistant text are derived from
      // the excluded tool input. Keeping the quarantine through the final
      // response prevents a model from re-quoting private bytes under an
      // otherwise harmless shape.
      return;
    }

    const emitted = sink(input);
    if (
      input.type === "ai_response"
      && role === "assistant"
      && typeof payload.tool === "string"
      && emitted.id.startsWith("suppressed_")
    ) {
      const toolUseId = string(payload.toolUseId);
      this.#suppressedTurns.set(sessionKey, {
        toolUseIds: new Set(toolUseId === undefined ? [] : [toolUseId]),
      });
    }
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#files.clear();
    this.#roots.clear();
    this.#invalidRoots.clear();
    this.#suppressedTurns.clear();
    this.#statusSink = undefined;
    this.#availability = undefined;
  }
}
