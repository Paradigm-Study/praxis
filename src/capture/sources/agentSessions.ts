import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { EventSource } from "../../core/types.ts";
import { sha256 } from "../../core/hash.ts";
import { logger } from "../../core/log.ts";
import type { CaptureSource, EventSink, RawEventInput } from "../source.ts";

const log = logger("agent_sessions");
const PREVIEW_LENGTH = 200;

type JsonObject = Record<string, unknown>;

interface FileState {
  offset: number;
  buffer: string;
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textPayload(text: string): { textHash: string; preview: string } {
  return {
    textHash: sha256(text),
    preview: text.slice(0, PREVIEW_LENGTH),
  };
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
    Object.prototype.hasOwnProperty.call(envelope, "attachment")
  ) {
    return [];
  }

  const message = object(envelope.message);
  if (!message) return [];

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
      return [makeInput("ai_request", { role: "user", ...textPayload(content) })];
    }
    if (!Array.isArray(content)) return [];

    const inputs: RawEventInput[] = [];
    const userText = textFromContent(content);
    const hasTextBlock = content.some((item) => {
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
    const command = fullCommand?.slice(0, PREVIEW_LENGTH);
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
}

/** Tails Claude Code JSONL transcripts and emits new, privacy-safe events. */
export class AgentSessionsSource implements CaptureSource {
  readonly name = "agent_sessions";
  readonly source: EventSource = "ai_proxy";
  #dirs: string[];
  #pollMs: number;
  #files = new Map<string, FileState>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: AgentSessionsOptions = {}) {
    this.#dirs = opts.dirs ?? [join(homedir(), ".claude", "projects")];
    this.#pollMs = opts.pollMs ?? 2000;
  }

  start(sink: EventSink): void {
    this.stop();

    for (const dir of this.#dirs) {
      if (!existsSync(dir)) {
        log.warn(`transcript directory ${dir} not found`);
        continue;
      }
      for (const file of this.#scan(dir)) {
        let fd: number | undefined;
        try {
          fd = openSync(file, "r");
          this.#files.set(file, { offset: fstatSync(fd).size, buffer: "" });
        } catch (err) {
          log.debug(`initial scan failed for ${file}`, String(err));
        } finally {
          if (fd !== undefined) {
            try {
              closeSync(fd);
            } catch (err) {
              log.debug(`failed to close transcript ${file}`, String(err));
            }
          }
        }
      }
    }

    this.#timer = setInterval(() => this.#poll(sink), this.#pollMs);
    this.#timer.unref();
  }

  #scan(dir: string): string[] {
    try {
      return readdirSync(dir, { recursive: true })
        .filter((entry): entry is string =>
          typeof entry === "string" && entry.endsWith(".jsonl")
        )
        .map((entry) => join(dir, entry));
    } catch (err) {
      log.debug(`transcript scan failed for ${dir}`, String(err));
      return [];
    }
  }

  #poll(sink: EventSink): void {
    for (const dir of this.#dirs) {
      for (const file of this.#scan(dir)) {
        if (!this.#files.has(file)) {
          this.#files.set(file, { offset: 0, buffer: "" });
        }
      }
    }

    for (const [file, state] of this.#files) {
      this.#drain(file, state, sink);
    }
  }

  #drain(file: string, state: FileState, sink: EventSink): void {
    let fd: number | undefined;
    try {
      fd = openSync(file, "r");
      const size = fstatSync(fd).size;
      if (size <= state.offset) return;

      const length = size - state.offset;
      const chunk = Buffer.alloc(length);
      readSync(fd, chunk, 0, length, state.offset);
      state.offset = size;
      state.buffer += chunk.toString("utf8");

      const fallback: TranscriptLineContext = {
        sessionKey: basename(file, ".jsonl"),
      };
      let newline: number;
      while ((newline = state.buffer.indexOf("\n")) >= 0) {
        const line = state.buffer.slice(0, newline).trim();
        state.buffer = state.buffer.slice(newline + 1);
        if (!line) continue;
        for (const input of transcriptLineToInputs(line, fallback)) sink(input);
      }
    } catch (err) {
      log.debug(`transcript drain failed for ${file}`, String(err));
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch (err) {
          log.debug(`failed to close transcript ${file}`, String(err));
        }
      }
    }
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#files.clear();
  }
}
