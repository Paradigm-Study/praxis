import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { openStore } from "../src/storage/index.ts";
import { makeIngest } from "../src/capture/ingest.ts";
import { AiProxySource } from "../src/capture/sources/aiProxy.ts";
import { startAiProxy } from "../src/capture/sources/aiProxyServer.ts";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port));
  });
}
// startAiProxy already calls listen(); just await the bound port.
async function portOf(server: Server): Promise<number> {
  if (!server.address()) await new Promise((r) => server.once("listening", r));
  return (server.address() as { port: number }).port;
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

test("ai_proxy records prompt + response and forwards verbatim", async () => {
  // 1. Mock upstream that returns an Anthropic-shaped response.
  let upstreamSawBody = "";
  const upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      upstreamSawBody = raw;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model: "claude-test",
        content: [{ type: "text", text: "Tap raw OS events; never infer from video alone." }],
      }));
    });
  });
  const upstreamPort = await listen(upstream);

  // 2. Proxy → mock upstream, wired to a fresh ledger.
  const store = openStore({ memory: true });
  const source = new AiProxySource();
  source.start(makeIngest(store).ingest);
  const proxy = startAiProxy({
    source,
    port: 0,
    upstreamBase: `http://localhost:${upstreamPort}`,
  });
  const proxyPort = await portOf(proxy);

  // 3. Route an Anthropic-shaped request through the proxy.
  const reqBody = {
    model: "claude-test",
    system: "You observe a user.",
    messages: [{ role: "user", content: "how are we achieving exact action reconstruction" }],
  };
  const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-praxis-app": "Codex" },
    body: JSON.stringify(reqBody),
  });
  const returned = (await res.json()) as { content: Array<{ text: string }> };

  // Returned verbatim from upstream.
  assert.equal(res.status, 200);
  assert.match(returned.content[0]!.text, /Tap raw OS events/);
  assert.ok(upstreamSawBody.includes("exact action reconstruction"));

  // Ledger captured both sides as evidence.
  const events = store.events.range({ sources: ["ai_proxy"] });
  const reqEv = events.find((e) => e.type === "ai_request");
  const respEv = events.find((e) => e.type === "ai_response");
  assert.ok(reqEv, "expected an ai_request event");
  assert.ok(respEv, "expected an ai_response event");
  assert.equal(reqEv!.app, "Codex");
  assert.equal(reqEv!.payload.model, "claude-test");

  // Prompt + response text offloaded to blobs, resolvable.
  const promptText = store.blobs.getText(reqEv!.blobRefs[0]!);
  const respText = store.blobs.getText(respEv!.blobRefs[0]!);
  assert.match(promptText ?? "", /exact action reconstruction/);
  assert.match(respText ?? "", /never infer from video alone/);

  await close(proxy);
  await close(upstream);
  store.close();
});
