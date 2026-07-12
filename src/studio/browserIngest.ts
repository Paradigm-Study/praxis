import type { IncomingMessage, ServerResponse } from "node:http";
import { makeIngest } from "../capture/ingest.ts";
import { logger } from "../core/log.ts";
import { isAllowedOrigin } from "../mcp/protocol.ts";
import type { Store } from "../storage/index.ts";

/**
 * Dev-loopback browser error telemetry follows the same ingest funnel as every
 * other capture source, so failures observed in a local product become durable
 * ledger evidence without exposing an ingest endpoint to the network.
 */

const log = logger("browser-ingest");
const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH_ITEMS = 500;

type BrowserEventKind = "console_error" | "network_error";

interface BatchItem {
  kind: BrowserEventKind;
  url: string;
  message: string;
  stack?: string;
  status?: number;
  ts: string;
}

type BatchValidation =
  | { ok: true; items: BatchItem[] }
  | { ok: false; reason: string };

function isLoopback(addr: string | undefined): boolean {
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBatch(value: unknown): BatchValidation {
  let events: unknown;
  if (Array.isArray(value)) {
    events = value;
  } else if (!isRecord(value)) {
    return { ok: false, reason: "body must be an object or array" };
  } else if (!Object.hasOwn(value, "events")) {
    return { ok: false, reason: "missing events" };
  } else {
    events = value.events;
  }

  if (!Array.isArray(events)) {
    return { ok: false, reason: "events must be an array" };
  }
  if (events.length > MAX_BATCH_ITEMS) {
    return { ok: false, reason: "too many events" };
  }

  const items: BatchItem[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const valueAtIndex = events[index];
    if (!isRecord(valueAtIndex)) {
      return { ok: false, reason: `event ${index} must be an object` };
    }

    const kind = valueAtIndex.kind;
    const url = valueAtIndex.url;
    const message = valueAtIndex.message;
    const stack = valueAtIndex.stack;
    const status = valueAtIndex.status;
    const ts = valueAtIndex.ts;

    if (kind !== "console_error" && kind !== "network_error") {
      return { ok: false, reason: `event ${index} has invalid kind` };
    }
    if (typeof url !== "string") {
      return { ok: false, reason: `event ${index} has invalid url` };
    }
    if (typeof message !== "string") {
      return { ok: false, reason: `event ${index} has invalid message` };
    }
    if (
      Object.hasOwn(valueAtIndex, "stack") &&
      typeof stack !== "string"
    ) {
      return { ok: false, reason: `event ${index} has invalid stack` };
    }
    if (
      Object.hasOwn(valueAtIndex, "status") &&
      typeof status !== "number"
    ) {
      return { ok: false, reason: `event ${index} has invalid status` };
    }
    if (typeof ts !== "string") {
      return { ok: false, reason: `event ${index} has invalid ts` };
    }

    const item: BatchItem = { kind, url, message, ts };
    if (typeof stack === "string") item.stack = stack;
    if (typeof status === "number") item.status = status;
    items.push(item);
  }

  return { ok: true, items };
}

function chunkToBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function handleBrowserIngest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  let done = false;

  const respond = (
    status: number,
    body: Record<string, unknown>,
    after?: () => void,
  ): void => {
    if (done) return;
    done = true;
    res.writeHead(status, { "content-type": "application/json" });
    const payload = JSON.stringify(body);
    if (after) {
      res.end(payload, after);
    } else {
      res.end(payload);
    }
  };

  const reject = (status: number, reason: string, after?: () => void): void => {
    log.warn(`rejected batch: ${reason}`);
    respond(status, { error: reason }, after);
  };

  if (!isLoopback(req.socket.remoteAddress)) {
    try {
      req.on("error", () => {});
      if (typeof req.resume === "function") {
        req.resume();
      } else {
        req.on("data", () => {});
      }
    } catch {
      // A minimal/faulty request object must not escape the route.
    }
    try {
      reject(403, "loopback only");
    } catch {
      // A broken peer may make the response unwritable; never escape the route.
    }
    return;
  }

  // DNS-rebinding defense: the loopback peer check does not stop a browser
  // page whose hostname re-resolves to 127.0.0.1 — its Origin still names the
  // attacker's site. Only localhost origins (the extension's injection
  // targets) may write browser events; native clients send no Origin at all.
  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!isAllowedOrigin(origin)) {
    try {
      req.resume?.();
    } catch {
      // ignore
    }
    try {
      reject(403, "origin not allowed");
    } catch {
      // never escape the route
    }
    return;
  }

  const chunks: Buffer[] = [];
  let bodyBytes = 0;

  req.on("data", (chunk: unknown) => {
    if (done) return;
    try {
      const buffer = chunkToBuffer(chunk);
      bodyBytes += buffer.byteLength;
      if (bodyBytes > MAX_BODY_BYTES) {
        reject(413, "body too large", () => {
          try {
            req.destroy();
          } catch {
            // The request may already have closed after the response flushed.
          }
        });
        return;
      }
      chunks.push(buffer);
    } catch {
      reject(400, "invalid request body");
    }
  });

  req.on("end", () => {
    if (done) return;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks, bodyBytes).toString("utf8"));
      } catch {
        reject(400, "malformed JSON");
        return;
      }

      const validation = validateBatch(parsed);
      if (!validation.ok) {
        reject(400, validation.reason);
        return;
      }

      try {
        const ingest = makeIngest(store);
        for (const item of validation.items) {
          ingest.ingest({
            ts: item.ts,
            source: "browser_dom",
            app: "browser",
            window: item.url,
            type: item.kind,
            payload: {
              url: item.url,
              message: item.message.slice(0, 1000),
              ...(item.stack ? { stack: item.stack.slice(0, 2000) } : {}),
              ...(typeof item.status === "number"
                ? { status: item.status }
                : {}),
            },
          });
        }
      } catch (error) {
        const reason = errorText(error);
        reject(500, reason);
        return;
      }

      log.info(`accepted batch of ${validation.items.length} browser event(s)`);
      respond(200, { ok: true, ingested: validation.items.length });
    } catch (error) {
      reject(500, errorText(error));
    }
  });

  req.on("error", () => {
    try {
      if (!done) reject(400, "request error");
    } catch {
      // The peer may have made the response unwritable before this event.
    }
  });
}
