import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../storage/index.ts";
import {
  handleMcpMessage,
  isAllowedOrigin,
  isLoopback,
  rpcError,
  PARSE_ERROR,
  INVALID_REQUEST,
  type JsonRpcResponse,
} from "./protocol.ts";
import { logger } from "../core/log.ts";

const log = logger("mcp");

/**
 * MCP over Streamable HTTP, mounted on the Studio server at /mcp when
 * PRAXIS_MCP=1 (wired in src/studio/server.ts — builders do not touch the
 * server).
 *
 * This file is only the HTTP plumbing: peer checks, body reading, and the
 * request/response envelope. The JSON-RPC dispatch and the tools themselves
 * live in protocol.ts. The transport is deliberately minimal — one JSON-RPC
 * message per POST, plain application/json responses (no SSE stream: every
 * tool answers synchronously, so there is nothing to stream), stateless (no
 * session ids: the store IS the session).
 */

/**
 * Handle one request. Return true if the router OWNS the response (it will
 * end `res`, possibly asynchronously); false to let the studio fall through.
 */
export type McpHandler = (req: IncomingMessage, res: ServerResponse) => boolean;

export function createMcpRouter(store: Store): McpHandler {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    // The studio only routes /mcp paths here when PRAXIS_MCP=1; once a request
    // reaches us we own it entirely (no fall-through to static 404s that would
    // confuse MCP clients).

    // Loopback-only: the endpoint exposes the memory graph, so re-check the
    // actual peer even though the studio binds localhost by default.
    if (!isLoopback(req.socket.remoteAddress)) {
      log.warn(`rejected non-loopback MCP request from ${req.socket.remoteAddress}`);
      respond(res, 403, rpcError(null, INVALID_REQUEST, "forbidden: loopback only"));
      return true;
    }

    // DNS-rebinding defense (MCP spec requirement for localhost servers): a
    // browser page whose hostname re-resolves to 127.0.0.1 passes the peer
    // check above but carries its true Origin — reject anything non-local.
    const origin = headerValue(req.headers.origin);
    if (!isAllowedOrigin(origin)) {
      log.warn(`rejected MCP request with non-local origin ${String(origin)}`);
      respond(res, 403, rpcError(null, INVALID_REQUEST, "forbidden: origin not allowed"));
      return true;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-type": "application/json" });
      res.end(
        JSON.stringify(
          rpcError(null, INVALID_REQUEST, "MCP endpoint accepts POST only"),
        ),
      );
      return true;
    }

    // Collect Buffers and decode ONCE: coercing each chunk individually would
    // mangle any multibyte UTF-8 character split across a chunk boundary.
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      const data = Buffer.concat(chunks).toString("utf8");
      let msg: unknown;
      try {
        msg = JSON.parse(data);
      } catch {
        return respond(res, 400, rpcError(null, PARSE_ERROR, "parse error"));
      }
      // Streamable HTTP posts a single message per request; JSON-RPC batches
      // were removed from the MCP spec and are rejected outright.
      if (Array.isArray(msg)) {
        return respond(
          res,
          400,
          rpcError(null, INVALID_REQUEST, "batch messages are not supported"),
        );
      }
      const { status, body } = handleMcpMessage(store, msg);
      if (body === undefined) {
        // Notification accepted — 202 with an empty body, per Streamable HTTP.
        res.writeHead(status).end();
        return;
      }
      respond(res, status, body);
    });
    return true;
  };
}

function respond(res: ServerResponse, status: number, body: JsonRpcResponse): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
