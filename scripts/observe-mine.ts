/**
 * Run the REAL model-backed observer on a recent slice of the live ledger.
 * Read-only (no DB writes), so it's safe while capture is running. Shows what an
 * LLM actually extracts as intent / preferences / decisions from your genuine
 * (non-fixture) activity — the honest test of role-agnostic "understanding".
 *
 *   node --disable-warning=ExperimentalWarning scripts/observe-mine.ts [windowSeconds]
 */
import { join } from "node:path";
import { loadEnvFile } from "../src/core/env.ts";
import { openStore } from "../src/storage/index.ts";
import { reconstructEvents } from "../src/reconstructor/reconstructor.ts";
import { sniffImage } from "../src/observer/bundle.ts";
import { AnthropicObserver } from "../src/observer/observer.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import { toMs, toIso } from "../src/core/time.ts";
import type { ContextBundle } from "../src/core/types.ts";

loadEnvFile(join(import.meta.dirname, "..", ".env"));
const apiKey = process.env.PRAXIS_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.log("no ANTHROPIC_API_KEY"); process.exit(1); }

const windowSec = Number(process.argv[2] ?? 300);

const s = openStore();
const allEvents = s.events.range();
const blob = (h: string) => s.blobs.getText(h);
const actions = reconstructEvents(allEvents, { newId: makeSeededIdGen(), blob });

const endTs = allEvents[allEvents.length - 1]?.ts ?? new Date().toISOString();
const startMs = toMs(endTs) - windowSec * 1000;
const startTs = toIso(startMs);
const ev = allEvents.filter((e) => toMs(e.ts) >= startMs);
const act = actions.filter((a) => toMs(a.startTs) >= startMs);
const bySrc = (src: string) => ev.filter((e) => e.source === src);

const frameEvents = bySrc("screen_video");
const frameImages = frameEvents
  .slice(-4)
  .flatMap((e) =>
    e.blobRefs.flatMap((h) => {
      const buf = s.blobs.get(h);
      const mt = buf ? sniffImage(buf) : undefined;
      return buf && mt ? [{ hash: h, base64: Buffer.from(buf).toString("base64"), mediaType: mt }] : [];
    }),
  );

const bundle: ContextBundle = {
  id: "bundle_live",
  startTs,
  endTs,
  windowSeconds: windowSec,
  frames: frameEvents.flatMap((e) => e.blobRefs),
  frameText: frameEvents.map((e) => String((e.payload as Record<string, unknown>).ocrText ?? "")).filter(Boolean),
  frameImages,
  axText: bySrc("accessibility")
    .map((e) => {
      const p = e.payload as Record<string, unknown>;
      return String(p.text ?? p.value ?? p.visibleText ?? "");
    })
    .filter(Boolean),
  inputEvents: bySrc("input_events"),
  focus: bySrc("focus_timeline"),
  terminal: bySrc("terminal"),
  fileDiffs: bySrc("filesystem"),
  conversationTurns: act.filter((a) =>
    ["submitted_message", "received_response", "corrected_agent"].includes(a.action),
  ),
  actions: act,
};

console.log(`Observing last ${windowSec}s: ${act.length} actions, ${bundle.axText.length} AX texts, ${bundle.frameImages?.length ?? 0} frames`);
console.log("apps:", [...new Set(act.map((a) => a.app))].join(", "));
console.log("calling claude-opus-4-8 …\n");

const obs = await new AnthropicObserver({ apiKey: apiKey! }).observe(bundle);

const p = (label: string, v: unknown) => console.log(`  ${label.padEnd(13)} ${Array.isArray(v) ? JSON.stringify(v) : (v ?? "—")}`);
console.log("=== WHAT THE MODEL UNDERSTOOD ABOUT YOUR REAL SESSION ===");
p("intent:", obs.intent);
p("task:", obs.task);
p("decision:", obs.decisionPoint);
p("preference:", obs.inferredPreference);
p("accepted:", obs.acceptedOptions);
p("rejected:", obs.rejectedOptions);
p("uncertainty:", obs.uncertainty);
p("question:", obs.suggestedQuestion);
p("evidence:", obs.evidence.length + " action ids");
s.close();
