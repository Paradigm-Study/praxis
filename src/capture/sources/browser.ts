import type { CaptureSource, EventSink } from "../source.ts";

/**
 * Browser/DOM tap. Fed by a browser extension (or the Chrome MCP) that reports
 * the active tab's URL, title, and a DOM snapshot. The snapshot is offloaded to
 * a blob; URL + title ride inline so navigation reconstructs cheaply.
 */
export class BrowserSource implements CaptureSource {
  readonly name = "browser_dom";
  readonly source = "browser_dom" as const;
  #sink: EventSink | undefined;

  start(sink: EventSink): void {
    this.#sink = sink;
  }

  recordPage(input: {
    url: string;
    title: string;
    dom?: string;
    app?: string;
  }): void {
    this.#sink?.({
      source: "browser_dom",
      app: input.app ?? "Chrome",
      window: input.title,
      type: "page_loaded",
      payload: { url: input.url, title: input.title },
      blobs: input.dom ? [{ kind: "text", data: input.dom }] : [],
    });
  }

  stop(): void {
    this.#sink = undefined;
  }
}
