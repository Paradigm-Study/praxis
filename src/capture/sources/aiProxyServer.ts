import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AiProxySource } from "./aiProxy.ts";
import type { Store } from "../../storage/index.ts";
import { buildInjectionBlock, detectBodyShape, injectIntoBody } from "./proxyInject.ts";
import { logger } from "../../core/log.ts";

const log = logger("ai_proxy");

export interface AiProxyServerOptions {
  source: AiProxySource;
  /** Upstream the proxy forwards to (real API or a mock). */
  upstreamBase?: string;
  port?: number;
  /** Enables context injection (with PRAXIS_PROXY_INJECT=1) — see proxyInject.ts. */
  store?: Store;
}

/**
 * A transparent local proxy that routed AI tools (Codex, Claude, Cursor) point
 * their API base URL at. It records every prompt/response into the ledger, then
 * forwards the request upstream and returns the response verbatim. Prompts and
 * responses are first-class evidence: an `ai_request` near an Enter keypress is
 * exactly what lifts `submitted_message` confidence.
 *
 * The proxy is transparent about auth — it forwards the client's own
 * `x-api-key` / `authorization` header and never injects keys.
 */
export function startAiProxy(opts: AiProxyServerOptions): Server {
  const upstream = (opts.upstreamBase ?? "https://api.anthropic.com").replace(/\/$/, "");

  const server = createServer((req, res) => {
    readBody(req, async (raw) => {
      const body = safeJson(raw) ?? {};
      const app = headerStr(req, "x-praxis-app") ?? "ai_proxy";
      const { model, prompt } = extractPrompt(body);
      if (prompt) {
        opts.source.recordRequest({ app, model: model ?? "unknown", prompt });
      }

      // Context injection (default OFF): with PRAXIS_PROXY_INJECT=1 and a
      // store, splice praxis's relevant knowledge into the outgoing body.
      // A null block means "inject nothing" and the request forwards verbatim.
      let forwardRaw = raw;
      if (process.env.PRAXIS_PROXY_INJECT === "1" && opts.store && prompt) {
        const record = body as Record<string, unknown>;
        const block = buildInjectionBlock(opts.store, { model, prompt }, { app });
        if (block) {
          forwardRaw = JSON.stringify(injectIntoBody(record, detectBodyShape(record), block));
        }
      }

      try {
        const upRes = await fetch(upstream + (req.url ?? "/"), {
          method: req.method,
          headers: forwardHeaders(req),
          body: req.method === "GET" || req.method === "HEAD" ? undefined : forwardRaw,
        });
        const text = await upRes.text();
        const data = safeJson(text);
        const respText = extractResponse(data);
        if (respText) {
          opts.source.recordResponse({ app, model: model ?? "unknown", text: respText });
        }
        res.writeHead(upRes.status, {
          "content-type": upRes.headers.get("content-type") ?? "application/json",
        });
        res.end(text);
      } catch (err) {
        log.warn("upstream failed", String(err));
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "praxis proxy upstream failed", detail: String(err) }));
      }
    });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.warn(`port ${opts.port ?? 4318} already in use — a proxy is already running`);
      process.exit(0); // clicking "Start AI Proxy" twice is harmless, not a crash
    }
    log.error(`proxy failed: ${String(err)}`);
    process.exit(1);
  });
  // Privacy invariant: praxis servers bind loopback only by default.
  server.listen(opts.port ?? 4318, "127.0.0.1", () => {
    const bound = server.address();
    const port = bound && typeof bound === "object" ? bound.port : opts.port;
    log.info(`proxy on http://localhost:${port} → ${upstream}`);
  });
  return server;
}

// --- prompt/response extraction (Anthropic + OpenAI shapes) ---------------

interface Body {
  model?: unknown;
  system?: unknown;
  messages?: unknown;
  content?: unknown;
  choices?: unknown;
}

function extractPrompt(body: Body): { model?: string; prompt: string } {
  const model = typeof body.model === "string" ? body.model : undefined;
  const parts: string[] = [];
  if (typeof body.system === "string") parts.push(body.system);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages as Array<{ role?: string; content?: unknown }>) {
      if (m?.role === "user" || m?.role === "system") parts.push(contentText(m.content));
    }
  }
  return { model, prompt: parts.filter(Boolean).join("\n") };
}

function extractResponse(data: Body | undefined): string {
  if (!data) return "";
  // Anthropic: { content: [{ type: "text", text }] }
  if (Array.isArray(data.content)) {
    return (data.content as Array<{ text?: unknown }>)
      .map((b) => (typeof b?.text === "string" ? b.text : ""))
      .join("");
  }
  // OpenAI: { choices: [{ message: { content } }] }
  if (Array.isArray(data.choices)) {
    return (data.choices as Array<{ message?: { content?: unknown }; delta?: { content?: unknown } }>)
      .map((c) => str(c?.message?.content) ?? str(c?.delta?.content) ?? "")
      .join("");
  }
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

// --- http helpers ---------------------------------------------------------

function forwardHeaders(req: IncomingMessage): Record<string, string> {
	// fetch/undici owns framing for the reconstructed request body. Forwarding
	// the inbound Transfer-Encoding (typically "chunked") makes undici reject
	// the request before it reaches upstream.
	const drop = new Set(["host", "content-length", "transfer-encoding", "accept-encoding", "connection"]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (drop.has(k.toLowerCase())) continue;
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function headerStr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
}

function readBody(req: IncomingMessage, cb: (raw: string) => void): void {
  // Collect Buffers and decode ONCE. Coercing each chunk individually would
  // corrupt any multibyte UTF-8 character split across a chunk boundary —
  // and the proxy's contract is to forward the body verbatim.
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer | string) => {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  });
  req.on("end", () => cb(Buffer.concat(chunks).toString("utf8")));
}

function safeJson(s: string): Body | undefined {
  try {
    return JSON.parse(s) as Body;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
