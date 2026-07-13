import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";
import type { Store } from "../storage/index.ts";
import type { ActionEvent, RawEvent } from "../core/types.ts";
import { newId } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import { buildPlaybook } from "../transfer/transfer.ts";
import { buildBrief } from "./brief.ts";
import { handleBrowserIngest } from "./browserIngest.ts";
import { createMcpRouter } from "../mcp/router.ts";
import { isAllowedOrigin } from "../mcp/protocol.ts";
import { buildGraph } from "../memory/graph.ts";
import { logger } from "../core/log.ts";
import { PrivacyControlStore, type PrivacyControl } from "../privacy/control.ts";
import { RuntimeStatusStore } from "../capture/runtimeStatus.ts";
import { publishNativeAcquisitionPolicy } from "../privacy/nativePolicy.ts";
import { EgressAuditor } from "../privacy/egress.ts";
import {
  RetentionPolicyStore,
  runMaintenance,
  storageUsage,
  type RetentionPolicy,
} from "../storage/maintenance.ts";
import { authorizeLocalRequest, validateLocalToken } from "../security/localAuth.ts";

const log = logger("studio");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Launch Praxis Studio: a JSON API over the ledger + a static web UI. */
export function startStudio(store: Store, port = 4319): Server {
  const webDir = join(import.meta.dirname, "web");
  const clients = new Set<ServerResponse>();
  const mcpRouter = createMcpRouter(store);
  const localToken = validateLocalToken(process.env.PRAXIS_LOCAL_TOKEN);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/api/health") {
        return json(res, 200, { ok: true });
      }
      if (
        (path.startsWith("/api/") || path === "/mcp" || path.startsWith("/mcp/")) &&
        !authorizeLocalRequest(req, res, localToken)
      ) {
        return;
      }
      // MCP mount (default OFF): every /mcp request goes to the router when
      // PRAXIS_MCP=1; a false return falls through to normal handling.
      if (
        process.env.PRAXIS_MCP === "1" &&
        (path === "/mcp" || path.startsWith("/mcp/")) &&
        mcpRouter(req, res)
      ) {
        return;
      }
      if (path === "/api/stream") return handleStream(req, res, clients);
      if (path.startsWith("/api/")) return handleApi(store, req, res, path, url);
      return serveStatic(webDir, path, res);
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  // Live tail: poll the ledger for new rows (works across processes via WAL)
  // and push them to every connected SSE client. This is the "what it sees now".
  let cursor = store.events.maxRowid();
  let decisionCursor = store.decisions.maxRowid();
  const tailTimer = setInterval(() => {
    if (clients.size === 0) {
      cursor = store.events.maxRowid();
      decisionCursor = store.decisions.maxRowid();
      return;
    }
    const broadcast = (line: string) => {
      for (const c of clients) c.write(line);
    };

    const { maxRowid, events } = store.events.sinceRowid(cursor);
    if (events.length > 0) {
      cursor = maxRowid;
      for (const e of events) broadcast(`event: raw\ndata: ${JSON.stringify(e)}\n\n`);
      broadcast(
        `event: counts\ndata: ${JSON.stringify({
          events: store.events.count(),
          actions: store.actions.count(),
        })}\n\n`,
      );
    }

    // Live agent decisions (the loop's ask_expert / intervene / summarize).
    const dec = store.decisions.sinceRowid(decisionCursor);
    if (dec.decisions.length > 0) {
      decisionCursor = dec.maxRowid;
      for (const d of dec.decisions) broadcast(`event: decision\ndata: ${JSON.stringify(d)}\n\n`);
    }
  }, 750);
  tailTimer.unref();

  // Heartbeat so proxies don't drop idle SSE connections.
  const heartbeatTimer = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 15000);
  heartbeatTimer.unref();
  server.on("close", () => {
    clearInterval(tailTimer);
    clearInterval(heartbeatTimer);
  });

  // A second studio racing for the port must not crash-loop: if a healthy
  // studio already serves it, defer to that one and exit cleanly.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err;
    fetch(`http://localhost:${port}/api/status`, {
      headers: localToken ? { authorization: `Bearer ${localToken}` } : {},
    })
      .then((r) => {
        process.stdout.write(
          r.ok
            ? `Praxis Studio already running on :${port} — deferring to it.\n`
            : `port ${port} is taken by something that isn't a Studio\n`,
        );
        process.exit(r.ok ? 0 : 1);
      })
      .catch(() => {
        process.stdout.write(`port ${port} is taken and not responding\n`);
        process.exit(1);
      });
  });
  // Privacy invariant: praxis servers bind loopback only by default.
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(
      `\nPraxis Studio → http://localhost:${port}  (Ctrl-C to stop)\n`,
    );
  });
  return server;
}

function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  clients: Set<ServerResponse>,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

function serveStatic(webDir: string, path: string, res: ServerResponse): void {
  const rel = path === "/" ? "index.html" : path.replace(/^\//, "");
  const file = join(webDir, rel);
  if (!file.startsWith(webDir) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(body);
}

function handleApi(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
): void {
  // --- reads ---
  if (req.method === "GET") {
    // Team brief (async — may consult the mesh relay; empty when mesh is off).
    if (path === "/api/brief") {
      void buildBrief(store, {
        person: url.searchParams.get("person") ?? undefined,
        project: url.searchParams.get("project") ?? undefined,
        cwd: url.searchParams.get("cwd") ?? undefined,
      })
        .then((brief) => json(res, 200, brief))
        .catch((err) => json(res, 500, { error: String(err) }));
      return;
    }
    switch (path) {
      case "/api/status":
        return json(res, 200, {
          counts: {
            events: store.events.count(),
            actions: store.actions.count(),
            episodes: store.episodes.count(),
            claims: store.claims.count(),
            graph: store.graph.counts(),
          },
          eventsPerDay: store.analytics.eventsPerDay(),
          capture: captureStatus(store),
        });
      case "/api/capture/status":
        return json(res, 200, captureStatus(store));
      case "/api/privacy":
        return json(res, 200, PrivacyControlStore.forStore(store).read());
      case "/api/mesh/projects":
        return json(res, 200, {
          projects: PrivacyControlStore.forStore(store).read().meshProjectConsents,
        });
      case "/api/egress":
        return json(
          res,
          200,
          EgressAuditor.forStore(store).recent(Number(url.searchParams.get("limit") ?? 100)),
        );
      case "/api/storage/status":
        return json(res, 200, {
          usage: storageUsage(store),
          retention: RetentionPolicyStore.forStore(store).read(),
          encryption: {
            enabled: store.encryption.enabled,
            activeVersion: store.encryption.activeVersion,
            keyVersions: store.encryption.keyVersions,
          },
        });
      case "/api/storage/retention":
        return json(res, 200, RetentionPolicyStore.forStore(store).read());
      case "/api/feed":
        return json(res, 200, store.events.range({ limit: 300 }).reverse());
      case "/api/actions":
        // Newest first, bounded — the timeline grows forever; the browser
        // must not be handed (and animate) tens of thousands of rows.
        return json(res, 200, store.actions.range().slice(-400).reverse());
      case "/api/episodes":
        return json(res, 200, store.episodes.all());
      case "/api/claims":
        return json(res, 200, store.claims.all());
      case "/api/graph":
        return json(res, 200, {
          nodes: store.graph.nodes(),
          edges: store.graph.edges(),
        });
      case "/api/observations":
        return json(res, 200, store.observations.all());
      case "/api/corrections":
        return json(res, 200, store.corrections.all());
      case "/api/decisions":
        return json(res, 200, store.decisions.recent(50));
      case "/api/playbook":
        return json(res, 200, buildPlaybook(store));
      case "/api/connections":
        return json(res, 200, connections(store));
      case "/api/questions":
        return json(res, 200, questions(store));
    }
    if (path.startsWith("/api/event/")) {
      const ev = store.events.get(decodeURIComponent(path.slice("/api/event/".length)));
      return ev ? json(res, 200, ev) : json(res, 404, { error: "not found" });
    }
    if (path.startsWith("/api/blob/")) {
      const hash = decodeURIComponent(path.slice("/api/blob/".length));
      const rec = store.blobs.record(hash);
      const buf = store.blobs.get(hash);
      if (!rec || !buf) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": rec.kind === "image" ? "application/octet-stream" : "text/plain" });
      return void res.end(buf);
    }
  }

  // --- writes: browser-extension event batches ---
  if (req.method === "POST" && path === "/api/ingest/browser") {
    return handleBrowserIngest(store, req, res);
  }

  // Browser writes to loopback APIs must carry a local Origin. Non-browser
  // clients (Electron main, CLI, hooks) normally omit Origin and are allowed.
  if (
    (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") &&
    !isAllowedOrigin(headerValue(req.headers.origin))
  ) {
    return json(res, 403, { error: "origin not allowed" });
  }

  // --- writes: privacy/capture control -----------------------------------
  if (req.method === "PUT" && path === "/api/privacy") {
    return readBody(req, res, (body) => {
      const data = safeParse(body);
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return json(res, 400, { error: "privacy control must be a JSON object" });
      }
      const control = PrivacyControlStore.forStore(store).update(data as Partial<PrivacyControl>);
      publishNativeAcquisitionPolicy(store);
      return json(res, 200, control);
    });
  }
  if (req.method === "PUT" && path === "/api/mesh/projects") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      if (!data || !Array.isArray(data.projects)) {
        return json(res, 400, { error: "projects must be an array" });
      }
      const control = PrivacyControlStore.forStore(store).update({
        meshProjectConsents: data.projects as PrivacyControl["meshProjectConsents"],
      });
      return json(res, 200, { projects: control.meshProjectConsents });
    });
  }
  if (req.method === "PUT" && path === "/api/runtime/resources") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      if (
        (data?.powerSource !== "ac" && data?.powerSource !== "battery") ||
        typeof data.suspended !== "boolean" ||
        typeof data.batteryAware !== "boolean"
      ) {
        return json(res, 400, {
          error: "powerSource ('ac'|'battery'), suspended, and batteryAware are required",
        });
      }
      const status = RuntimeStatusStore.forStore(store).updateResources({
        powerSource: data.powerSource,
        suspended: data.suspended,
        batteryAware: data.batteryAware,
      });
      publishNativeAcquisitionPolicy(store);
      return json(res, 200, captureStatus(store, status));
    });
  }
  if (req.method === "POST" && path === "/api/capture/pause") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      const minutes = data?.minutes === undefined ? 15 : Number(data.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
        return json(res, 400, { error: "minutes must be an integer from 1 to 1440" });
      }
      const control = PrivacyControlStore.forStore(store);
      const updated = control.update({
        mode: "paused",
        pausedUntil: new Date(Date.now() + minutes * 60_000).toISOString(),
      });
      publishNativeAcquisitionPolicy(store);
      return json(res, 200, updated);
    });
  }
  if (req.method === "POST" && path === "/api/capture/resume") {
    const control = PrivacyControlStore.forStore(store);
    const updated = control.update({ mode: "normal", pausedUntil: undefined });
    publishNativeAcquisitionPolicy(store);
    return json(res, 200, updated);
  }

  // --- writes: retention/quota maintenance ------------------------------
  if (req.method === "PUT" && path === "/api/storage/retention") {
    return readBody(req, res, (body) => {
      const data = safeParse(body);
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return json(res, 400, { error: "retention policy must be a JSON object" });
      }
      return json(
        res,
        200,
        RetentionPolicyStore.forStore(store).update(data as Partial<RetentionPolicy>),
      );
    });
  }
  if (req.method === "POST" && path === "/api/storage/maintenance") {
    return json(res, 200, runMaintenance(store));
  }

  // --- writes: real local forget -----------------------------------------
  if (req.method === "POST" && path === "/api/forget") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      const minutes = Number(data?.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
        return json(res, 400, { error: "minutes must be an integer from 1 to 1440" });
      }
      const result = forgetRecent(store, minutes);
      log.info(`forgot ${result.events} event(s) from the last ${minutes} minute(s)`);
      return json(res, 200, result);
    });
  }

  // --- writes: corrections (the human-in-the-loop) ---
  if (req.method === "POST" && path === "/api/correction") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      if (!data?.targetKind || !data?.targetId || !data?.verdict) {
        return json(res, 400, { error: "targetKind, targetId, verdict required" });
      }
      const correction = {
        id: newId("corr"),
        targetKind: data.targetKind as never,
        targetId: String(data.targetId),
        verdict: data.verdict as never,
        correctedText: data.correctedText ? String(data.correctedText) : undefined,
        note: data.note ? String(data.note) : undefined,
        createdTs: nowIso(),
      };
      store.corrections.put(correction);
      log.info(`correction: ${correction.verdict} on ${correction.targetId}`);
      return json(res, 200, correction);
    });
  }

  // --- writes: answers to the agent's proactive questions ---
  if (req.method === "POST" && path === "/api/answer") {
    return readBody(req, res, (body) => {
      const data = safeParse(body) as Record<string, unknown> | undefined;
      if (!data?.questionId || data.answer == null) {
        return json(res, 400, { error: "questionId and answer required" });
      }
      const answer = {
        id: newId("corr"),
        targetKind: "decision" as const,
        targetId: String(data.questionId),
        verdict: "edited" as const,
        correctedText: String(data.answer),
        note: data.question ? String(data.question) : undefined,
        createdTs: nowIso(),
      };
      store.corrections.put(answer);
      log.info(`answer "${answer.correctedText}" → ${answer.targetId}`);
      return json(res, 200, answer);
    });
  }

  json(res, 404, { error: "no such endpoint" });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function captureStatus(
  store: Store,
  supplied?: ReturnType<RuntimeStatusStore["read"]>,
): unknown {
  const runtime = supplied ?? RuntimeStatusStore.forStore(store).read();
  const privacy = PrivacyControlStore.forStore(store).read();
  const pauseActive =
    privacy.mode === "paused" &&
    (!privacy.pausedUntil || Date.parse(privacy.pausedUntil) > Date.now());
  return {
    ...runtime,
    stale:
      runtime.state === "running" &&
      Date.now() - Date.parse(runtime.updatedAt) > 30_000,
    effectiveState: runtime.resources.suspended ? "suspended" : runtime.state,
    effectiveMode: privacy.mode === "private" ? "private" : pauseActive ? "paused" : "normal",
    privacy: {
      mode: privacy.mode,
      ...(privacy.pausedUntil ? { pausedUntil: privacy.pausedUntil } : {}),
    },
  };
}

export interface ForgetResult {
  cutoff: string;
  events: number;
  actions: number;
  episodes: number;
  blobs: number;
}

/**
 * Permanently remove the requested recent capture window and its derived
 * interpretations. Candidate blobs are unlinked only when no retained event
 * references them. Claims/graph are rebuilt from the retained episodes so no
 * memory node keeps evidence that was deliberately forgotten.
 */
export function forgetRecent(
  store: Store,
  minutes: number,
  nowMs = Date.now(),
): ForgetResult {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new RangeError("minutes must be an integer from 1 to 1440");
  }
  const cutoff = new Date(nowMs - minutes * 60_000).toISOString();
  const forgottenRows = store.db
    .prepare("SELECT blob_refs FROM raw_events WHERE ts >= ?")
    .all(cutoff) as Array<{ blob_refs: string }>;
  const candidateBlobs = new Set<string>();
  for (const row of forgottenRows) {
    try {
      for (const hash of JSON.parse(row.blob_refs) as unknown[]) {
        if (typeof hash === "string") candidateBlobs.add(hash);
      }
    } catch {
      // A malformed legacy ref list must not block forgetting its event.
    }
  }

  const count = (table: string, column: string): number =>
    Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} >= ?`).get(cutoff) as { n: number }).n);
  const result: ForgetResult = {
    cutoff,
    events: count("raw_events", "ts"),
    actions: count("action_events", "end_ts"),
    episodes: count("episodes", "end_ts"),
    blobs: 0,
  };

  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare("DELETE FROM raw_events WHERE ts >= ?").run(cutoff);
    store.db.prepare("DELETE FROM action_events WHERE end_ts >= ?").run(cutoff);
    store.db.prepare("DELETE FROM episodes WHERE end_ts >= ?").run(cutoff);
    store.db.prepare("DELETE FROM observations WHERE created_ts >= ?").run(cutoff);
    store.db.prepare("DELETE FROM decisions WHERE created_ts >= ?").run(cutoff);
    store.db.prepare("DELETE FROM corrections WHERE created_ts >= ?").run(cutoff);
    // Claims and graph are derived from the retained episodes/observations.
    store.db.exec("DELETE FROM graph_edges; DELETE FROM graph_nodes; DELETE FROM claims;");
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }

  buildGraph(store);
  const retainedRefs = new Set(store.events.range().flatMap((event) => event.blobRefs));
  for (const hash of candidateBlobs) {
    if (retainedRefs.has(hash)) continue;
    const record = store.blobs.record(hash);
    if (record) {
      try {
        unlinkSync(record.path);
      } catch {
        // Missing blob bytes are already effectively forgotten.
      }
    }
    store.db.prepare("DELETE FROM blobs WHERE hash = ?").run(hash);
    result.blobs += 1;
  }
  return result;
}

/** Recurring patterns across days — for the Connections view. */
function connections(store: Store): unknown {
  const edges = store.graph.edges();
  const nodes = new Map(store.graph.nodes().map((n) => [n.id, n]));
  const reused = edges.filter((e) => e.kind === "reused_across_days");
  const byNode = new Map<string, { node: unknown; days: Set<string> }>();
  for (const e of reused) {
    const n = nodes.get(e.from);
    if (!n) continue;
    const entry = byNode.get(e.from) ?? { node: n, days: new Set<string>() };
    if (e.data?.day) entry.days.add(String(e.data.day));
    byNode.set(e.from, entry);
  }
  return [...byNode.values()].map((v) => ({
    node: v.node,
    days: [...v.days].sort(),
  }));
}

/**
 * The correction cards: every uncertain interpretation, framed as
 * "I think you did X because Y. Evidence: A, B, C. Correct?" with the raw
 * evidence resolved so the user can verify before confirming.
 */
function questions(store: Store): unknown {
  const answered = new Set(store.corrections.all().map((c) => c.targetId));

  // The agent's proactive questions (it said it was unsure WHY) — each with
  // candidate answers to pick from. The card also offers a free-text box.
  const agent = store.decisions
    .recent(50)
    .filter(
      (d) =>
        (d.kind === "ask_expert" || d.kind === "intervene") &&
        d.question &&
        !answered.has(d.id),
    )
    .slice(0, 8)
    .map((d) => {
      const obs = d.observationId ? store.observations.get(d.observationId) : undefined;
      return {
        questionId: d.id,
        question: d.question,
        options: obs?.options ?? [],
        kind: d.kind,
        createdTs: d.createdTs,
        evidence: (d.evidence ?? []).map((id) => evidenceSummary(store, id)),
      };
    });

  // Per-action verification cards (uncertain reconstructions).
  const cards = store.actions
    .range()
    .filter((a) => (a.confidence < 0.85 || a.uncertainty?.length) && !answered.has(a.id))
    .map((a) => ({
      actionId: a.id,
      proposed: propose(a),
      action: a.action,
      app: a.app,
      text: a.text,
      confidence: a.confidence,
      uncertainty: a.uncertainty ?? [],
      evidence: a.evidence.map((id) => evidenceSummary(store, id)),
    }));

  return { agent, cards };
}

function propose(a: ActionEvent): string {
  const verb = a.action.startsWith("possibly_reading")
    ? "were reading"
    : a.action.replace(/_/g, " ");
  const why = a.uncertainty?.length
    ? a.uncertainty[0]
    : `${a.evidence.length} raw signal(s) corroborate it (${Math.round(a.confidence * 100)}% confidence)`;
  const what = a.text ? ` "${a.text.replace(/\s+/g, " ").slice(0, 70)}"` : "";
  return `I think you ${verb}${what} in ${a.app} because ${why}. Correct?`;
}

function evidenceSummary(store: Store, id: string): unknown {
  const ev: RawEvent | undefined = store.events.get(id);
  if (!ev) return { id, label: id };
  const text =
    (ev.payload.text as string) ??
    (ev.payload.value as string) ??
    (ev.payload.cmd as string) ??
    (ev.payload.title as string) ??
    "";
  return {
    id,
    source: ev.source,
    type: ev.type,
    app: ev.app,
    ts: ev.ts,
    label: `${ev.source}/${ev.type}`,
    snippet: String(text).slice(0, 80),
    blobRefs: ev.blobRefs,
  };
}

// --------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  cb: (body: string) => void,
  maxBytes = 64 * 1024,
): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let rejected = false;
  req.on("data", (chunk: Buffer | string) => {
    if (rejected) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      rejected = true;
      res.writeHead(413, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: "request body too large" }), () => req.destroy());
      return;
    }
    chunks.push(buffer);
  });
  req.on("end", () => {
    if (!rejected) cb(Buffer.concat(chunks, bytes).toString("utf8"));
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
