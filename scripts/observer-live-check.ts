/**
 * Live API self-check — verifies the two model-backed paths against the REAL
 * Anthropic API (everything else in Praxis is verified offline):
 *
 *   1. AnthropicObserver: fixture session + one REAL screen frame (rendered +
 *      OCR'd by the native client) → multimodal observe() call → Observation.
 *   2. ai_proxy: a request routed through the local recording proxy to
 *      api.anthropic.com, prompt/response captured in the ledger.
 *
 * Needs ANTHROPIC_API_KEY (loaded from praxis/.env). Cost: two small calls.
 *
 *   node --disable-warning=ExperimentalWarning scripts/observer-live-check.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { loadEnvFile } from "../src/core/env.ts";
import { openStore } from "../src/storage/index.ts";
import { makeIngest } from "../src/capture/ingest.ts";
import { replay } from "../src/capture/sources/synthetic.ts";
import { codexSessionEvents } from "../src/fixtures/codexSession.ts";
import { NativeCaptureSource } from "../src/capture/sources/nativeBridge.ts";
import { reconstruct } from "../src/reconstructor/reconstructor.ts";
import { fuse } from "../src/fuser/fuser.ts";
import { buildBundle } from "../src/observer/bundle.ts";
import { AnthropicObserver } from "../src/observer/observer.ts";
import { AiProxySource } from "../src/capture/sources/aiProxy.ts";
import { startAiProxy } from "../src/capture/sources/aiProxyServer.ts";

loadEnvFile(join(import.meta.dirname, "..", ".env"));
const apiKey = process.env.PRAXIS_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
const out = (s = "") => process.stdout.write(s + "\n");

if (!apiKey) {
  out("no ANTHROPIC_API_KEY (checked env + praxis/.env) — cannot run the live check");
  process.exit(1);
}

const NATIVE_BIN = [
  "dist/Praxis.app/Contents/MacOS/praxis-capture",
  "native/PraxisCapture/.build/release/praxis-capture",
  "native/PraxisCapture/.build/debug/praxis-capture",
].find((p) => existsSync(p));

async function main(): Promise<void> {
  // ---- 1. Multimodal observer against the real API -----------------------
  const store = openStore({ memory: true });
  const ingest = makeIngest(store);
  await replay(codexSessionEvents(), ingest.ingest);

  if (NATIVE_BIN) {
    // A REAL PNG frame (with OCR text) from the native client's self-test.
    const native = new NativeCaptureSource({ command: NATIVE_BIN, args: ["--selftest-ocr"] });
    native.start(ingest.ingest);
    await new Promise((r) => setTimeout(r, 2500));
    native.stop();
  } else {
    out("⚠ native binary not built — observer call will be text-only");
  }

  reconstruct(store);
  fuse(store);
  const bundle = buildBundle(store, {
    windowSeconds: 3 * 86400, // span the fixture session + the just-added frame
    includeImages: true,
  });
  out(`bundle: ${bundle.actions.length} actions, ${bundle.frameText.length} OCR texts, ` +
      `${bundle.frameImages?.length ?? 0} real image(s)`);

  const observer = new AnthropicObserver({ apiKey: apiKey! });
  out(`calling ${observer.model} …`);
  const obs = await observer.observe(bundle);

  out("\n=== REAL OBSERVATION (model=" + obs.model + ") ===");
  out("  intent:      " + (obs.intent ?? "—"));
  out("  task:        " + (obs.task ?? "—"));
  out("  decision:    " + (obs.decisionPoint ?? "—"));
  out("  preference:  " + (obs.inferredPreference ?? "—"));
  out("  rejected:    " + JSON.stringify(obs.rejectedOptions));
  out("  uncertainty: " + JSON.stringify(obs.uncertainty));
  out("  question:    " + (obs.suggestedQuestion ?? "—"));
  out("  evidence:    " + obs.evidence.length + " action ids");

  const obsOk = !!obs.intent && obs.evidence.length > 0;

  // ---- 2. Recording proxy against the real API ----------------------------
  const proxySource = new AiProxySource();
  proxySource.start(ingest.ingest);
  const proxy: Server = startAiProxy({ source: proxySource, port: 0 });
  if (!proxy.address()) await new Promise((r) => proxy.once("listening", r));
  const port = (proxy.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey!,
      "anthropic-version": "2023-06-01",
      "x-praxis-app": "live-check",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: PROXY_OK" }],
    }),
  });
  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  const replyText = data.content?.map((b) => b.text ?? "").join("") ?? "";
  const ledger = store.events.range({ sources: ["ai_proxy"] });
  const sawReq = ledger.some((e) => e.type === "ai_request" && e.app === "live-check");
  const sawResp = ledger.some((e) => e.type === "ai_response" && e.app === "live-check");

  out("\n=== REAL PROXY PASSTHROUGH ===");
  out(`  upstream status: ${res.status}   reply: ${replyText.trim()}`);
  out(`  ledger captured: ai_request=${sawReq} ai_response=${sawResp}`);

  const proxyOk = res.status === 200 && replyText.includes("PROXY_OK") && sawReq && sawResp;

  proxy.close();
  store.close();
  out(`\n${obsOk && proxyOk ? "OK" : "FAIL"} live API check (observer ${obsOk ? "✓" : "✗"}, proxy ${proxyOk ? "✓" : "✗"})`);
  process.exit(obsOk && proxyOk ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`error: ${err?.stack ?? err}\n`);
  process.exit(1);
});
