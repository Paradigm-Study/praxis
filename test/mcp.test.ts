import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { freshStore, fullPipeline, type Pipeline } from "./helpers.ts";
import { createMcpRouter } from "../src/mcp/router.ts";
import {
  handleMcpMessage,
  isAllowedOrigin,
  isLoopback,
  PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  PARSE_ERROR,
  TOOL_DEFINITIONS,
  type JsonRpcResponse,
  type ToolCallResult,
} from "../src/mcp/protocol.ts";
import { applyCorrections } from "../src/memory/consolidate.ts";

/**
 * Full JSON-RPC round-trips over real HTTP against a seeded store: the router
 * is mounted exactly the way the studio mounts it (own the response when the
 * handler returns true, 404 otherwise).
 */

let pipeline: Pipeline;
let server: Server;
let base = "";

before(async () => {
  pipeline = await fullPipeline();
  const router = createMcpRouter(pipeline.store);
  server = createServer((req, res) => {
    if (!router(req, res)) res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  pipeline.store.close();
});

let nextId = 0;

async function post(body: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: res.status, text: await res.text() };
}

async function rpc(
  method: string,
  params?: unknown,
): Promise<{ status: number; body: JsonRpcResponse }> {
  const id = ++nextId;
  const { status, text } = await post(
    JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }),
  );
  const body = JSON.parse(text) as JsonRpcResponse;
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, id);
  return { status, body };
}

async function callTool(
  name: string,
  args?: Record<string, unknown>,
): Promise<ToolCallResult> {
  const { status, body } = await rpc("tools/call", { name, arguments: args ?? {} });
  assert.equal(status, 200);
  assert.equal(body.error, undefined, `unexpected protocol error: ${JSON.stringify(body.error)}`);
  return body.result as ToolCallResult;
}

/** Every tool answers a single JSON text block — parse it. */
function toolJson(result: ToolCallResult): unknown {
  assert.ok(!result.isError, `unexpected tool error: ${result.content[0]?.text}`);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "text");
  return JSON.parse(result.content[0]!.text);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("initialize round-trip returns protocol version, tools capability, serverInfo", async () => {
  const { status, body } = await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  });
  assert.equal(status, 200);
  const result = body.result as {
    protocolVersion: string;
    capabilities: { tools: object };
    serverInfo: { name: string };
  };
  assert.equal(result.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result.serverInfo.name, "praxis-mcp");
});

test("notifications/initialized is accepted with 202 and no body", async () => {
  const { status, text } = await post(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  assert.equal(status, 202);
  assert.equal(text, "");
});

test("tools/list exposes exactly the five praxis tools with schemas", async () => {
  const { body } = await rpc("tools/list");
  const tools = (body.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["get_claims", "get_episodes", "get_playbook", "record_correction", "retrieve_context"],
  );
  for (const t of tools) assert.ok(t.inputSchema, `${t.name} missing inputSchema`);
  assert.equal(tools.length, TOOL_DEFINITIONS.length);
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

test("get_playbook returns the same playbook the studio serves", async () => {
  const pb = toolJson(await callTool("get_playbook")) as {
    workflow: string[];
    decisionRules: Array<{ text: string }>;
    knowHow: unknown[];
  };
  assert.ok(pb.workflow.length >= 3);
  assert.equal(pb.workflow[0], "consult AI");
  assert.ok(pb.decisionRules.some((r) => /evidence-backed/.test(r.text)));
});

test("get_playbook exposes curated unresolved decision questions", () => {
  const store = freshStore();
  try {
    const evidence = {
      id: "mcp_question_action", type: "user_action" as const, action: "answered_question",
      app: "Test", startTs: "2026-07-13T11:59:00.000Z", endTs: "2026-07-13T11:59:01.000Z",
      confidence: 0.98, evidence: ["raw_mcp_question"],
    };
    store.actions.put(evidence);
    store.decisions.put({
      id: "decision_mcp_open",
      kind: "ask_expert",
      reason: "Needs human judgment",
      question: "Should the installer include automatic updates?",
      evidence: [evidence.id],
      createdTs: "2026-07-13T12:00:00.000Z",
    });
    const result = handleMcpMessage(store, {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "get_playbook", arguments: {} },
    });
    assert.equal(result.status, 200);
    const toolResult = result.body?.result as ToolCallResult;
    const playbook = toolJson(toolResult) as { openQuestions: string[] };
    assert.deepEqual(playbook.openQuestions, [
      "Should the installer include automatic updates?",
    ]);
  } finally {
    store.close();
  }
});

test("get_claims returns claims, respects kind filter and limit", async () => {
  const all = toolJson(await callTool("get_claims")) as Array<{ id: string; kind: string }>;
  assert.equal(all.length, pipeline.store.claims.count());
  assert.ok(all.length > 0);

  const one = toolJson(await callTool("get_claims", { limit: 1 })) as unknown[];
  assert.equal(one.length, 1);

  const kind = all[0]!.kind;
  const filtered = toolJson(await callTool("get_claims", { kind })) as Array<{ kind: string }>;
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((c) => c.kind === kind));
});

test("retrieve_context returns a bounded claim array for a task", async () => {
  const claims = toolJson(
    await callTool("retrieve_context", {
      task: "write tests before committing the fix",
      cwd: "/tmp/repo",
      limit: 3,
    }),
  );
  // The retrieval builder may still be a stub returning [] — the contract here
  // is shape, bound, and claim fields, not recall.
  assert.ok(Array.isArray(claims));
  assert.ok(claims.length <= 3);
  for (const c of claims as Array<Record<string, unknown>>) {
    assert.equal(typeof c.id, "string");
    assert.equal(typeof c.text, "string");
    assert.equal(typeof c.confidence, "number");
  }
});

test("get_episodes returns the latest fused episodes", async () => {
  const episodes = toolJson(await callTool("get_episodes", { limit: 2 })) as Array<{
    id: string;
    summary: string;
  }>;
  assert.ok(episodes.length > 0);
  assert.ok(episodes.length <= 2);
  const known = new Set(pipeline.store.episodes.all().map((e) => e.id));
  for (const e of episodes) assert.ok(known.has(e.id));
});

test("record_correction on a claim persists a confirmed Correction", async () => {
  const claim = pipeline.store.claims.all()[0]!;
  let validationInWriterTransaction = false;
  const getClaim = pipeline.store.claims.get;
  pipeline.store.claims.get = (id) => {
    if (id === claim.id) {
      validationInWriterTransaction = pipeline.store.db.isTransaction;
    }
    return getClaim(id);
  };
  let rec: {
    id: string;
    targetKind: string;
    targetId: string;
    verdict: string;
    note?: string;
  };
  try {
    rec = toolJson(
      await callTool("record_correction", {
        claimId: claim.id,
        verdict: "confirm",
        note: "checked by hand",
      }),
    ) as typeof rec;
  } finally {
    pipeline.store.claims.get = getClaim;
  }

  assert.equal(validationInWriterTransaction, true);
  assert.match(rec.id, /^corr_/);
  assert.equal(rec.targetKind, "claim");
  assert.equal(rec.targetId, claim.id);
  assert.equal(rec.verdict, "confirmed");
  assert.equal(rec.note, "checked by hand");

  const stored = pipeline.store.corrections.get(rec.id);
  assert.ok(stored, "correction not persisted");
  assert.equal(stored.targetId, claim.id);
  assert.equal(stored.verdict, "confirmed");
  assert.equal(stored.origin, "agent");
  const effective = applyCorrections([claim], [stored]);
  assert.deepEqual(
    effective,
    [claim],
    "an agent-reported confirmation cannot promote or rewrite its own claim",
  );

  const rejected = toolJson(
    await callTool("record_correction", { claimId: claim.id, verdict: "reject" }),
  ) as { id: string };
  assert.equal(pipeline.store.corrections.get(rejected.id)?.origin, "agent");
  const visible = toolJson(await callTool("get_claims", { limit: 100 })) as Array<{ id: string }>;
  assert.equal(
    visible.some((item) => item.id === claim.id),
    true,
    "an agent-reported rejection cannot suppress human-visible memory",
  );
});

test("record_correction on an observation maps reject -> rejected", async () => {
  pipeline.store.observations.put({
    id: "obs_test1",
    bundleId: "bundle_test1",
    acceptedOptions: [],
    rejectedOptions: [],
    uncertainty: [],
    evidence: [],
    model: "test-observer",
    createdTs: "2026-07-13T00:00:00.000Z",
  });
  const rec = toolJson(
    await callTool("record_correction", { observationId: "obs_test1", verdict: "reject" }),
  ) as { id: string; targetKind: string; verdict: string };
  assert.equal(rec.targetKind, "observation");
  assert.equal(rec.verdict, "rejected");
  assert.equal(pipeline.store.corrections.get(rec.id)?.verdict, "rejected");
  assert.equal(pipeline.store.corrections.get(rec.id)?.origin, "agent");
});

test("record_correction rejects nonexistent and ambiguous targets", async () => {
  const missingClaim = await callTool("record_correction", {
    claimId: "missing_claim",
    verdict: "confirm",
  });
  assert.equal(missingClaim.isError, true);
  assert.match(missingClaim.content[0]!.text, /not found/);

  const missingObservation = await callTool("record_correction", {
    observationId: "missing_observation",
    verdict: "reject",
  });
  assert.equal(missingObservation.isError, true);
  assert.match(missingObservation.content[0]!.text, /not found/);
  assert.equal(pipeline.store.db.isTransaction, false, "missing targets roll back the writer lock");

  const claim = pipeline.store.claims.all()[0]!;
  const ambiguous = await callTool("record_correction", {
    claimId: claim.id,
    observationId: "obs_test1",
    verdict: "confirm",
  });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0]!.text, /exactly one/);
});

// ---------------------------------------------------------------------------
// Errors: protocol vs tool
// ---------------------------------------------------------------------------

test("unknown method is a -32601 protocol error", async () => {
  const { status, body } = await rpc("no/such/method");
  assert.equal(status, 200);
  assert.equal(body.error?.code, METHOD_NOT_FOUND);
});

test("unknown tool name is a -32602 protocol error", async () => {
  const { body } = await rpc("tools/call", { name: "no_such_tool", arguments: {} });
  assert.equal(body.error?.code, INVALID_PARAMS);
});

test("tool errors are isError results, not protocol errors", async () => {
  // Missing required 'task'.
  const noTask = await callTool("retrieve_context", {});
  assert.equal(noTask.isError, true);
  assert.match(noTask.content[0]!.text, /task/);

  // Neither observationId nor claimId.
  const noTarget = await callTool("record_correction", { verdict: "confirm" });
  assert.equal(noTarget.isError, true);

  // Bad verdict.
  const badVerdict = await callTool("record_correction", {
    claimId: "claim_x",
    verdict: "maybe",
  });
  assert.equal(badVerdict.isError, true);
  assert.match(badVerdict.content[0]!.text, /confirm|reject/);
});

test("malformed JSON body is a 400 with -32700", async () => {
  const { status, text } = await post("{not json");
  assert.equal(status, 400);
  const body = JSON.parse(text) as JsonRpcResponse;
  assert.equal(body.error?.code, PARSE_ERROR);
  assert.equal(body.id, null);
});

test("batch messages are rejected with 400", async () => {
  const { status } = await post(
    JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
  );
  assert.equal(status, 400);
});

test("non-POST methods get 405 with Allow: POST", async () => {
  const res = await fetch(`${base}/mcp`);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("router owns every /mcp request (never falls through to 404)", async () => {
  const res = await fetch(`${base}/mcp/anything`, { method: "DELETE" });
  assert.equal(res.status, 405); // owned by the router, not the host's 404
});

// ---------------------------------------------------------------------------
// Loopback guard
// ---------------------------------------------------------------------------

test("isLoopback accepts loopback peers and rejects everything else", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("127.0.0.53"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
  assert.equal(isLoopback("192.168.1.20"), false);
  assert.equal(isLoopback("::ffff:192.168.1.20"), false);
  assert.equal(isLoopback("10.0.0.5"), false);
  assert.equal(isLoopback(undefined), false);
});

test("a non-loopback peer is refused with 403 before any dispatch", async () => {
  // Simulate a remote peer with minimal req/res doubles — the router checks
  // req.socket.remoteAddress before reading the body.
  const router = createMcpRouter(pipeline.store);
  let status = 0;
  let ended = "";
  const req = {
    method: "POST",
    socket: { remoteAddress: "192.168.1.20" },
    on: () => req,
  } as never;
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: string) {
      ended = chunk ?? "";
    },
  } as never;
  const owned = router(req, res);
  assert.equal(owned, true);
  assert.equal(status, 403);
  assert.match(ended, /loopback/);
});

// ---------------------------------------------------------------------------
// Origin guard (DNS-rebinding defense) + UTF-8 body integrity
// ---------------------------------------------------------------------------

test("a non-local Origin is refused with 403; local origins and no Origin pass", async () => {
  const evil = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://attacker.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(evil.status, 403);
  assert.match(await evil.text(), /origin/i);

  const local = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  assert.equal(local.status, 200);
  // No Origin at all (native MCP clients): covered by every other test here.
});

test("origin validation accepts only exact localhost or loopback IP literals", () => {
  assert.equal(isAllowedOrigin("http://localhost:5173"), true);
  assert.equal(isAllowedOrigin("https://127.0.0.1:7777"), true);
  assert.equal(isAllowedOrigin("http://127.42.9.3"), true);
  assert.equal(isAllowedOrigin("http://[::1]:5173"), true);
  assert.equal(isAllowedOrigin("http://127.attacker.example"), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1.attacker.example"), false);
  assert.equal(isAllowedOrigin("http://attacker.example"), false);
});

test("multibyte UTF-8 split across chunk boundaries is not corrupted", async () => {
  const { request } = await import("node:http");
  const toolName = `工具-😀-name`;
  const payload = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 77,
      method: "tools/call",
      params: { name: toolName, arguments: {} },
    }),
    "utf8",
  );
  // Split INSIDE the emoji's 4-byte sequence (0xF0 lead byte + 2).
  const emojiStart = payload.indexOf(0xf0);
  assert.ok(emojiStart > 0, "fixture contains a 4-byte UTF-8 sequence");
  const parts = [payload.subarray(0, emojiStart + 2), payload.subarray(emojiStart + 2)];

  const text = await new Promise<string>((resolve, reject) => {
    const req = request(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (out += c));
      res.on("end", () => resolve(out));
    });
    req.on("error", reject);
    req.write(parts[0], () => {
      // Flush the first chunk before sending the rest so the server sees two
      // distinct 'data' events with the emoji split across them.
      setTimeout(() => req.end(parts[1]), 20);
    });
  });

  const body = JSON.parse(text) as JsonRpcResponse;
  assert.equal(body.id, 77);
  assert.equal(
    body.error?.message,
    `unknown tool: ${toolName}`,
    "the tool name must round-trip byte-identically (no U+FFFD mangling)",
  );
});
