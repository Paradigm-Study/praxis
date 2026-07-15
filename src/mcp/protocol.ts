import { isIP } from "node:net";
import type { Store } from "../storage/index.ts";
import type { ClaimKind, Correction, CorrectionVerdict } from "../core/types.ts";
import { CLAIM_KINDS } from "../core/types.ts";
import { buildPlaybook } from "../transfer/transfer.ts";
import { retrieveForTask } from "../agent/retrieveForTask.ts";
import { newId } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import { applyCorrections } from "../memory/consolidate.ts";

/**
 * MCP protocol layer: JSON-RPC 2.0 message handling + tool implementations,
 * independent of HTTP plumbing (which lives in router.ts). Everything here is
 * synchronous and pure-ish (tools read/write only through the Store facade),
 * so tests can drive single messages without a socket if they want to.
 *
 * Error taxonomy (deliberate, matches MCP):
 *   - malformed JSON-RPC / unknown METHOD  -> protocol error (-32600 / -32601)
 *   - unknown TOOL name                    -> protocol error (-32602, per spec)
 *   - failure INSIDE a known tool (missing
 *     args, bad verdict, store throw)      -> tools/call result with isError:
 *     true — the model should see tool failures as content, not transport
 *     failures, so it can self-correct.
 */

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "praxis-mcp", version: "0.1.0" } as const;

// JSON-RPC 2.0 error codes.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export interface JsonRpcErrorBody {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

/** What the HTTP layer should send back: a status and an optional JSON body. */
export interface McpHttpResult {
  status: number;
  body?: JsonRpcResponse;
}

export function rpcResult(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Loopback guard: the MCP endpoint exposes the memory graph, so even though
 * the studio binds localhost by default, the router re-checks the peer address
 * in case someone widens the bind. IPv4-mapped IPv6 ("::ffff:127.0.0.1")
 * counts; an absent address (socket gone) does not.
 */
export function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const addr = remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
  return addr === "::1" || addr.startsWith("127.");
}

/**
 * Origin allow-check for loopback HTTP endpoints (DNS-rebinding defense; the
 * MCP spec requires Origin validation for localhost servers).
 *
 * A peer-address check alone does not stop a browser: a page whose hostname
 * re-resolves to 127.0.0.1 posts from the local machine but with a foreign
 * Origin. Native clients send no Origin header at all — absent passes; any
 * present Origin must name localhost or an actual loopback IP literal (any
 * port, any scheme). A DNS name that merely starts with "127" is not local.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true; // non-browser client
  try {
    const { hostname } = new URL(origin);
    const host = hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
    if (host.toLowerCase() === "localhost" || host === "::1") return true;
    return isIP(host) === 4 && host.split(".", 1)[0] === "127";
  } catch {
    return false; // "null" or unparsable Origins are not trusted
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface ToolText {
  type: "text";
  text: string;
}

export interface ToolCallResult {
  content: ToolText[];
  isError?: boolean;
}

/** Every tool answers with a single JSON text block, per the module contract. */
function ok(data: unknown): ToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function strArg(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function numArg(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.floor(v)
    : undefined;
}

type ToolImpl = (store: Store, args: Record<string, unknown>) => ToolCallResult;

const TOOL_IMPLS: Record<string, ToolImpl> = {
  get_playbook: (store) => ok(buildPlaybook(store)),

  get_claims: (store, args) => {
    const kind = strArg(args.kind);
    const limit = numArg(args.limit) ?? 50;
    const corrected = applyCorrections(store.claims.all(), store.corrections.all());
    const claims = kind
      ? corrected.filter((claim) => claim.kind === (kind as ClaimKind))
      : corrected;
    return ok(claims.slice(0, limit));
  },

  retrieve_context: (store, args) => {
    const task = strArg(args.task);
    if (!task) return fail("retrieve_context requires a non-empty string 'task'");
    return ok(
      retrieveForTask(store, task, {
        cwd: strArg(args.cwd),
        repo: strArg(args.repo),
        path: strArg(args.path),
        limit: numArg(args.limit),
      }),
    );
  },

  get_episodes: (store, args) =>
    ok(store.episodes.latest(numArg(args.limit) ?? 20)),

  record_correction: (store, args) => {
    const observationId = strArg(args.observationId);
    const claimId = strArg(args.claimId);
    if (!observationId && !claimId) {
      return fail("record_correction requires 'observationId' or 'claimId'");
    }
    if (observationId && claimId) {
      return fail("record_correction accepts exactly one target");
    }
    const verdict: CorrectionVerdict | undefined =
      args.verdict === "confirm"
        ? "confirmed"
        : args.verdict === "reject"
          ? "rejected"
          : undefined;
    if (!verdict) {
      return fail("record_correction verdict must be 'confirm' or 'reject'");
    }
    // A model can report disagreement, but cannot manufacture human trust. The
    // auditable receipt is intentionally excluded from memory materialization
    // until a person confirms or edits it through Studio.
    const correction: Correction = {
      id: newId("corr"),
      targetKind: observationId ? "observation" : "claim",
      targetId: observationId ?? claimId!,
      verdict,
      origin: "agent",
      note: strArg(args.note),
      createdTs: nowIso(),
    };
    store.db.exec("BEGIN IMMEDIATE");
    try {
      // Keep target validation and insertion under one writer lock. A target
      // removed by a concurrent rebuild/forget can never leave an orphaned
      // correction that was acknowledged as successful.
      if (observationId && !store.observations.get(observationId)) {
        store.db.exec("ROLLBACK");
        return fail("record_correction observation target not found");
      }
      if (claimId && !store.claims.get(claimId)) {
        store.db.exec("ROLLBACK");
        return fail("record_correction claim target not found");
      }
      store.corrections.put(correction);
      store.db.exec("COMMIT");
    } catch (error) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        // Preserve the materialization error if SQLite already aborted.
      }
      return fail(`record_correction could not persist: ${String(error)}`);
    }
    return ok(correction);
  },
};

/** tools/list payload — names must match TOOL_IMPLS keys exactly. */
export const TOOL_DEFINITIONS = [
  {
    name: "get_playbook",
    description:
      "The learned expert playbook distilled from the memory graph: workflow " +
      "steps, decision rules, know-how, taste rules, artifact types, and open " +
      "questions, each with confidence and evidence episode ids.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_claims",
    description:
      "Persisted expert-memory claims, highest confidence first. Optionally " +
      "filter by kind and cap the count.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: `Claim kind filter, e.g. one of: ${CLAIM_KINDS.join(", ")}`,
        },
        limit: { type: "number", description: "Max claims to return (default 50)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "retrieve_context",
    description:
      "Bounded long-term context for a free-text task: the few stored claims " +
      "most relevant to the task, most relevant first.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task text to retrieve context for" },
        cwd: { type: "string", description: "Working directory the task runs in" },
        repo: { type: "string", description: "Normalized repo url the task concerns" },
        path: { type: "string", description: "Repo-relative path the task concerns" },
        limit: { type: "number", description: "Max claims to return (default 5)" },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "get_episodes",
    description: "Most recent fused context episodes (summary, goal, artifacts, uncertainty).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max episodes to return (default 20)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "record_correction",
    description:
      "Record an agent-reported confirm/reject suggestion for an observation " +
      "or claim, with an optional note. This creates an auditable receipt but " +
      "does not alter trusted memory until a person reviews it in Studio.",
    inputSchema: {
      type: "object",
      properties: {
        observationId: { type: "string", description: "Target observation id" },
        claimId: { type: "string", description: "Target claim id" },
        verdict: { type: "string", enum: ["confirm", "reject"] },
        note: { type: "string", description: "Optional free-text note" },
      },
      required: ["verdict"],
      additionalProperties: false,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Handle one parsed JSON-RPC message (Streamable HTTP posts exactly one per
 * request). Notifications get 202 + no body; requests get 200 + a response
 * envelope; malformed messages get 400 + an id:null error envelope.
 */
export function handleMcpMessage(store: Store, msg: unknown): McpHttpResult {
  if (!isRecord(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return {
      status: 400,
      body: rpcError(null, INVALID_REQUEST, "not a JSON-RPC 2.0 message"),
    };
  }
  const method = msg.method;
  const hasId =
    "id" in msg && (typeof msg.id === "string" || typeof msg.id === "number");

  // Notifications (no id) never get a JSON-RPC response: 202 Accepted.
  // notifications/initialized is the only one we expect, but per spec any
  // notification is simply accepted.
  if (!hasId) return { status: 202 };
  const id = msg.id as string | number;
  const params = isRecord(msg.params) ? msg.params : {};

  switch (method) {
    case "initialize":
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      };

    case "ping":
      return { status: 200, body: rpcResult(id, {}) };

    case "tools/list":
      return { status: 200, body: rpcResult(id, { tools: TOOL_DEFINITIONS }) };

    case "tools/call": {
      const name = strArg(params.name);
      if (!name) {
        return {
          status: 200,
          body: rpcError(id, INVALID_PARAMS, "tools/call requires params.name"),
        };
      }
      const impl = TOOL_IMPLS[name];
      if (!impl) {
        return {
          status: 200,
          body: rpcError(id, INVALID_PARAMS, `unknown tool: ${name}`),
        };
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      // A throw inside a known tool is a TOOL error (isError result), not a
      // protocol error — the caller's model should see it and adapt.
      let result: ToolCallResult;
      try {
        result = impl(store, args);
      } catch (err) {
        result = fail(`tool ${name} failed: ${String(err)}`);
      }
      return { status: 200, body: rpcResult(id, result) };
    }

    default:
      return {
        status: 200,
        body: rpcError(id, METHOD_NOT_FOUND, `method not found: ${method}`),
      };
  }
}
