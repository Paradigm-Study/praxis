import type { CaptureSource, EventSink } from "../source.ts";

/**
 * AI proxy tap. In production this sits as a local HTTP proxy that routed AI
 * tools (Codex, Claude, Cursor) point at, recording every prompt/response. Here
 * it exposes a `record*` API the proxy server calls; large prompt/response
 * bodies are offloaded to blobs.
 *
 * Prompts/responses are first-class evidence: a `submitted_message` action is
 * far more confident when a matching `ai_request` exists in the same window.
 */
export class AiProxySource implements CaptureSource {
  readonly name = "ai_proxy";
  readonly source = "ai_proxy" as const;
  #sink: EventSink | undefined;

  start(sink: EventSink): void {
    this.#sink = sink;
  }

  recordRequest(input: {
    app: string;
    model: string;
    prompt: string;
    window?: string;
  }): void {
    this.#sink?.({
      source: "ai_proxy",
      app: input.app,
      window: input.window ?? input.app,
      type: "ai_request",
      payload: { model: input.model, length: input.prompt.length },
      blobs: [{ kind: "text", data: input.prompt }],
    });
  }

  recordResponse(input: {
    app: string;
    model: string;
    text: string;
    window?: string;
  }): void {
    this.#sink?.({
      source: "ai_proxy",
      app: input.app,
      window: input.window ?? input.app,
      type: "ai_response",
      payload: { model: input.model, length: input.text.length },
      blobs: [{ kind: "text", data: input.text }],
    });
  }

  stop(): void {
    this.#sink = undefined;
  }
}
