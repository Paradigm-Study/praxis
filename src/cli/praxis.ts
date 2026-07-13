import { openStore, defaultDataDir, type Store } from "../storage/index.ts";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { runDemo, clearAll } from "./demo.ts";
import { reconstruct } from "../reconstructor/reconstructor.ts";
import { fuse } from "../fuser/fuser.ts";
import { buildGraph } from "../memory/graph.ts";
import { buildBundle } from "../observer/bundle.ts";
import { AnthropicObserver, defaultObserver, MockObserver } from "../observer/observer.ts";
import { CaptureManager } from "../capture/manager.ts";
import { makeIngest } from "../capture/ingest.ts";
import { SyntheticSource } from "../capture/sources/synthetic.ts";
import { ClipboardSource } from "../capture/sources/clipboard.ts";
import { FilesystemSource } from "../capture/sources/filesystem.ts";
import { GitSource } from "../capture/sources/git.ts";
import { TerminalSource, ZSH_HOOK } from "../capture/sources/terminal.ts";
import { NativeCaptureSource, StdinNativeSource } from "../capture/sources/nativeBridge.ts";
import { AiProxySource } from "../capture/sources/aiProxy.ts";
import { startAiProxy } from "../capture/sources/aiProxyServer.ts";
import { AgentLoop } from "../agent/loop.ts";
import { fileAsk, throttledAsk } from "../agent/notify.ts";
import { codexSessionEvents } from "../fixtures/codexSession.ts";
import { followupSessionEvents } from "../fixtures/followupSession.ts";
import { homedir } from "node:os";
import { join, dirname, relative } from "node:path";
import { loadEnvFile } from "../core/env.ts";
import { bold, conf, cyan, dim, gray, green, header, red, yellow } from "./render.ts";
import { consolidate, evidenceCoverage, applyCorrections } from "../memory/consolidate.ts";
import { renderSkill, skillStats } from "../transfer/skill.ts";
import { nowIso } from "../core/time.ts";
import { EgressAuditor } from "../privacy/egress.ts";
import { capturePolicyDecision, PrivacyControlStore } from "../privacy/control.ts";
import { resourceCaptureDecision, RuntimeStatusStore } from "../capture/runtimeStatus.ts";
import { nativePolicyPathForStore } from "../privacy/nativePolicy.ts";
import { createBackup, restoreBackup, verifyBackup } from "../storage/backup.ts";
import { doctorStore } from "../storage/doctor.ts";
import { rotateMasterKey } from "../storage/crypto.ts";

// Load <project>/.env (e.g. ANTHROPIC_API_KEY for the model-backed observer).
loadEnvFile(join(import.meta.dirname, "..", "..", ".env"));

const args = process.argv.slice(2);
const cmd = args[0];
const flags = new Set(args.filter((a) => a.startsWith("--")));
const has = (f: string) => flags.has(f);
const flagVal = (name: string): string | undefined => {
  const a = args.find((x) => x.startsWith(`${name}=`));
  return a ? a.slice(name.length + 1) : undefined;
};

// Exit cleanly when a downstream reader (e.g. `praxis export-skill | head`)
// closes the pipe — don't crash with an unhandled EPIPE.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

async function main(): Promise<void> {
  switch (cmd) {
    case "demo":
      return cmdDemo();
    case "capture":
      return cmdCapture();
    case "reconstruct":
      return runStage("reconstruct");
    case "fuse":
      return runStage("fuse");
    case "graph":
      return runStage("graph");
    case "profile":
      return cmdProfile();
    case "export-skill":
      return cmdExportSkill();
    case "observe":
      return cmdObserve();
    case "ab":
      return cmdAb();
    case "status":
      return cmdStatus();
    case "reset":
      return cmdReset();
    case "doctor":
      return cmdDoctor();
    case "backup":
      return cmdBackup();
    case "restore":
      return cmdRestore();
    case "rotate-key":
      return cmdRotateKey();
    case "hook":
      process.stdout.write(ZSH_HOOK + "\n");
      return;
    case "studio":
      return cmdStudio();
    case "proxy":
      return cmdProxy();
    default:
      usage();
  }
}

function usage(): void {
  process.stdout.write(
    `${bold("praxis")} — Context Firehose + Action Reconstructor\n\n` +
      `${bold("Usage:")} praxis <command>\n\n` +
      `  ${green("demo")}         Run the full pipeline on a synthetic session and explain it\n` +
      `  ${green("capture")}      Start live capture  [--synthetic --native --agent]\n` +
      `  ${green("reconstruct")}  Reconstruct actions from the ledger\n` +
      `  ${green("fuse")}         Fuse actions into episodes\n` +
      `  ${green("graph")}        Build the expert memory graph\n` +
      `  ${green("observe")}      Observe the latest context window\n` +
      `  ${green("ab")}           A/B two observers on the same real windows  [--rounds=3 --judge --step=15]\n` +
      `  ${green("status")}       Show ledger counts\n` +
      `  ${green("reset")}        Clear derived data (or everything with --all) + vacuum\n` +
      `  ${green("doctor")}       Check DB/WAL/blobs/permissions/spools  [--repair]\n` +
      `  ${green("backup")}       Create same-install encrypted rollback backup  [--out=PATH]\n` +
      `  ${green("restore")}      Verify + restore a backup with rollback  --from=PATH\n` +
      `  ${green("rotate-key")}   Rotate the local master key and re-encrypt stored content\n` +
      `  ${green("profile")}      Show your consolidated profile  [--all]\n` +
      `  ${green("export-skill")} Export your profile as a portable SKILL.md  [--out=PATH --name= --title= --durable-only]\n` +
      `  ${green("studio")}       Launch Praxis Studio (web UI)  [--port=4319]\n` +
      `  ${green("proxy")}        Run the AI proxy that records prompts/responses  [--enable --port=4318 --upstream=...]\n` +
      `  ${green("hook")}         Print the zsh hook for terminal capture\n\n` +
      `${dim("Data dir: $PRAXIS_DATA_DIR or ./data")}\n`,
  );
}

function dataDirFlag(): string {
  return flagVal("--data") ?? defaultDataDir();
}

function cmdDoctor(): void {
  const store = openStore({ dir: dataDirFlag() });
  try {
    const report = doctorStore(store, { repair: has("--repair") });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    store.close();
  }
}

function cmdBackup(): void {
  const store = openStore({ dir: dataDirFlag() });
  try {
    const path = createBackup(store, flagVal("--out"));
    const verification = verifyBackup(path);
    if (!verification.ok) throw new Error(verification.errors.join("; "));
    process.stdout.write(`${JSON.stringify({
      ok: true,
      path,
      verified: true,
      recoveryScope: "same_install",
    })}\n`);
  } finally {
    store.close();
  }
}

function cmdRestore(): void {
  const source = flagVal("--from");
  if (!source) {
    process.stderr.write(`${red("✗")} restore requires --from=PATH\n`);
    process.exitCode = 1;
    return;
  }
  const dir = dataDirFlag();
  const result = restoreBackup(source, dir);
  const verification = openStore({ dir });
  try {
    const report = doctorStore(verification);
    if (!report.ok) throw new Error("restored store failed doctor checks");
  } finally {
    verification.close();
  }
  process.stdout.write(
    `${green("✓")} restored ${source}; pre-restore backup: ${result.preRestoreBackup}\n`,
  );
}

function cmdRotateKey(): void {
  const dir = dataDirFlag();
  const before = openStore({ dir });
  before.close();
  const keyring = rotateMasterKey(dir);
  const rotated = openStore({ dir }); // startup content migration performs rotation
  try {
    const report = doctorStore(rotated);
    if (!report.ok) throw new Error("rotated store failed doctor checks");
    process.stdout.write(`${green("✓")} active master key is now v${keyring.activeVersion}\n`);
  } finally {
    rotated.close();
  }
}

async function cmdDemo(): Promise<void> {
  // The demo writes to a SEPARATE data/demo dir so synthetic fixtures never
  // pollute the real capture ledger (data/praxis.db).
  const store = has("--memory")
    ? openStore({ memory: true })
    : openStore({ dir: join(defaultDataDir(), "demo") });
  if (!has("--memory")) clearAll(store);
  await runDemo(store);
  if (!has("--memory")) {
    process.stdout.write(
      dim(`  (demo data is isolated in ${store.paths.db} — run `) +
        bold(`praxis studio --data=${join(defaultDataDir(), "demo")}`) +
        dim(" to view)\n"),
    );
  }
  store.close();
}

/** Wipe derived data (or everything with --all) and reclaim space. */
function cmdReset(): void {
  const store = openStore(flagVal("--data") ? { dir: flagVal("--data")! } : {});
  const derived = [
    "action_events", "episodes", "claims",
    "graph_nodes", "graph_edges", "observations", "decisions",
  ];
  const before = store.events.count();
  store.db.exec("BEGIN");
  for (const t of derived) store.db.exec(`DELETE FROM ${t};`);
  if (has("--all")) {
    store.db.exec("DELETE FROM raw_events;");
    store.db.exec("DELETE FROM blobs;");
  }
  store.db.exec("COMMIT");
  store.db.exec("VACUUM;");
  if (has("--all")) {
    rmSync(store.paths.blobs, { recursive: true, force: true });
    process.stdout.write(`${green("✓")} wiped everything (${before} events + blobs) and vacuumed\n`);
  } else {
    process.stdout.write(`${green("✓")} cleared derived data (kept ${before} raw events) and vacuumed\n`);
  }
  store.close();
}

function summarize(store: Store): void {
  process.stdout.write(
    `  events:${store.events.count()}  actions:${store.actions.count()}  ` +
      `episodes:${store.episodes.count()}  claims:${store.claims.count()}  ` +
      `graph:${JSON.stringify(store.graph.counts())}\n`,
  );
}

function runStage(stage: "reconstruct" | "fuse" | "graph"): void {
  const store = openStore();
  if (stage === "reconstruct") {
    const a = reconstruct(store);
    process.stdout.write(`${green("✓")} reconstructed ${a.length} actions\n`);
  } else if (stage === "fuse") {
    const e = fuse(store);
    process.stdout.write(`${green("✓")} fused ${e.length} episodes\n`);
  } else {
    const g = buildGraph(store);
    process.stdout.write(
      `${green("✓")} graph: ${g.nodes.length} nodes, ${g.edges.length} edges, ${g.claims.length} claims\n`,
    );
  }
  summarize(store);
  store.close();
}

async function cmdObserve(): Promise<void> {
  const store = openStore();
  const observer = defaultObserver(store);
  const bundle = buildBundle(store, {
    windowSeconds: Number(flagVal("--window") ?? 120),
    includeImages: observer.wantsImages,
  });
  const obs = await observer.observe(bundle);
  store.observations.put(obs);
  process.stdout.write(`${green("✓")} ${obs.intent}\n`);
  if (obs.suggestedQuestion) process.stdout.write(`  ${bold("❝ " + obs.suggestedQuestion + " ❞")}\n`);
  store.close();
}

function cmdStatus(): void {
  const store = openStore(flagVal("--data") ? { dir: flagVal("--data")! } : {});
  process.stdout.write(header("Praxis ledger"));
  process.stdout.write("\n");
  summarize(store);
  const events = store.analytics.eventsPerDay();
  for (const d of events) process.stdout.write(`  ${gray(d.day)}  ${d.count} events\n`);
  store.close();
}

async function cmdCapture(): Promise<void> {
  const store = openStore(flagVal("--data") ? { dir: flagVal("--data")! } : {});
  const privacy = PrivacyControlStore.forStore(store);
  const runtime = RuntimeStatusStore.forStore(store);
  let manager: CaptureManager;
  const sources = [];
  if (has("--synthetic")) {
    sources.push(
      new SyntheticSource([...codexSessionEvents(), ...followupSessionEvents()], {
        realtime: true,
        speed: Number(flagVal("--speed") ?? 50),
      }),
    );
  } else {
    const nativeCapture = has("--native") || has("--native-stdin");
    // Consumer/native capture reads the pasteboard in PraxisCaptureKit, where
    // the current app/window can be fenced before body acquisition. The legacy
    // Node poller is explicit development compatibility only.
    if (!nativeCapture && process.env.PRAXIS_NODE_CLIPBOARD_UNSAFE_DEV === "1") {
      sources.push(new ClipboardSource({
        frontApp: () => manager.frontApp(),
        canAcquire: (front) => {
          const contentPolicy = capturePolicyDecision(privacy.read(), {
            source: "clipboard",
            app: front.app,
            window: front.window,
            type: "clipboard_preflight",
            payload: {},
          });
          return contentPolicy.allowed && resourceCaptureDecision(
            runtime.read().resources,
            "clipboard",
          ).allowed;
        },
      }));
    }
    sources.push(new TerminalSource({ logPath: join(homedir(), ".praxis", "cmdlog.ndjson") }));

    // Filesystem + git taps are OPT-IN — point them at YOUR project(s), not at
    // wherever capture was launched (which would just record Praxis's own files).
    const watchDirs = (flagVal("--watch") ?? process.env.PRAXIS_WATCH ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    for (const dir of watchDirs) {
      sources.push(new FilesystemSource({
        root: dir,
        canAcquire: (absolutePath) => {
          const contentPolicy = capturePolicyDecision(privacy.read(), {
            source: "filesystem",
            app: "filesystem",
            window: relative(process.cwd(), absolutePath),
            type: "filesystem_preflight",
            payload: { path: absolutePath },
          });
          return contentPolicy.allowed && resourceCaptureDecision(
            runtime.read().resources,
            "filesystem",
          ).allowed;
        },
      }));
      sources.push(new GitSource({ repo: dir }));
    }
    if (watchDirs.length === 0) {
      process.stdout.write(
        dim("  (filesystem/git taps off — set --watch=/path/to/project or PRAXIS_WATCH)\n"),
      );
    }

    // --native-stdin: native events arrive on stdin (the app spawned the capture
    // binary directly). --native: spawn it ourselves (dev / terminal use).
    if (has("--native-stdin")) sources.push(new StdinNativeSource());
    else if (has("--native")) {
      sources.push(new NativeCaptureSource({
        policyPath: nativePolicyPathForStore(store),
      }));
    }
  }

  manager = new CaptureManager(store, sources, { privacy, runtime });
  process.stdout.write(`${green("●")} capturing → ${cyan(store.paths.db)}  ${dim("(Ctrl-C to stop)")}\n`);

  let live = 0;
  manager.subscribe(() => {
    live++;
    process.stdout.write(`\r${dim("events: " + live)}   `);
  });

  if (has("--agent")) {
    // The model observer is throttled inside the loop (per-episode + min
    // interval), so it can run all day at bounded cost. Opt in with
    // --observer=anthropic; otherwise the free deterministic mock is used.
    const useModel = flagVal("--observer") === "anthropic";
    const loop = new AgentLoop(store, {
      learnerMode: has("--learner"),
      observer: useModel ? defaultObserver(store) : new MockObserver(),
      // Speak up proactively, but only when it matters (≤1 every 5 min). The
      // menu-bar app tails this file and posts the native notification with the
      // candidate answers as buttons + a free-text box.
      onAsk: throttledAsk(
        fileAsk(join(dirname(store.paths.db), "notifications.ndjson")),
        5 * 60_000,
      ),
      onDecision: (d) => {
        if (d.question) process.stdout.write(`\n${bold("❝ " + d.question + " ❞")}\n`);
      },
    });
    loop.attach(manager);
    process.stdout.write(
      dim(`  agent loop attached (observer: ${useModel ? "anthropic" : "mock"}, proactive questions on)\n`),
    );
  }

  await manager.start();
  const shutdown = async (why: string) => {
    await manager.stop();
    process.stdout.write(`\n${green("✓")} stopped (${why}). `);
    summarize(store);
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // LIFELINE: in --native-stdin mode our stdin is a pipe from the menu-bar app.
  // If the bar dies — however it dies — the pipe EOFs, and we MUST exit with it.
  // (Learned the hard way: pkill'ing the bar orphaned a pipeline per relaunch;
  // ten agent loops ended up contending on one SQLite DB and asking the same
  // questions in triplicate.)
  if (has("--native-stdin")) {
    process.stdin.on("end", () => void shutdown("bar exited (stdin EOF)"));
    process.stdin.on("close", () => void shutdown("bar exited (stdin closed)"));
  }
  // keep the process alive
  await new Promise(() => {});
}

async function cmdAb(): Promise<void> {
  const { runAb, makeClaudeJudge, estimateCost } = await import("../observer/ab.ts");
  const { GeminiObserver } = await import("../observer/gemini.ts");
  const anthropicKey =
    process.env.PRAXIS_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!anthropicKey || !geminiKey) {
    process.stderr.write(
      `${red("✗")} ab needs both ANTHROPIC_API_KEY and GEMINI_API_KEY in praxis/.env\n`,
    );
    process.exit(1);
  }

  const store = openStore(flagVal("--data") ? { dir: flagVal("--data")! } : {});
  const privacy = PrivacyControlStore.forStore(store).read();
  if (!privacy.cloudObserverConsent) {
    process.stderr.write(`${red("✗")} ab requires cloud observer consent in Praxis privacy settings\n`);
    store.close();
    process.exitCode = 1;
    return;
  }
  const claudeModel = process.env.PRAXIS_OBSERVER_MODEL ?? "claude-haiku-4-5";
  const geminiModel = process.env.PRAXIS_GEMINI_MODEL ?? "gemini-3.5-flash";
  const auditor = EgressAuditor.forStore(store);
  const a = new AnthropicObserver({
    apiKey: anthropicKey,
    model: claudeModel,
    auditor,
    includeImages: privacy.screenshotConsent,
  });
  const b = new GeminiObserver({
    apiKey: geminiKey,
    model: geminiModel,
    auditor,
    includeImages: privacy.screenshotConsent,
  });

  // Published per-1M-token prices, verified 2026-06-11 (ai.google.dev/pricing,
  // platform.claude.com). Image tokens ≈ one 864×558 frame: Anthropic w*h/750;
  // Gemini 3.x default media_resolution=high is 1120/image. Estimates for the
  // table, not billing truth.
  const GEMINI_PRICES: Record<string, { inPerM: number; outPerM: number; imageTokens: number }> = {
    "gemini-3.5-flash": { inPerM: 1.5, outPerM: 9.0, imageTokens: 1120 },
    "gemini-3-flash-preview": { inPerM: 0.5, outPerM: 3.0, imageTokens: 1120 },
    "gemini-3.1-flash-lite": { inPerM: 0.25, outPerM: 1.5, imageTokens: 1120 },
    "gemini-2.5-flash": { inPerM: 0.3, outPerM: 2.5, imageTokens: 258 },
  };
  const CLAUDE_PRICES: Record<string, { inPerM: number; outPerM: number; imageTokens: number }> = {
    "claude-haiku-4-5": { inPerM: 1.0, outPerM: 5.0, imageTokens: 645 },
    "claude-sonnet-4-6": { inPerM: 3.0, outPerM: 15.0, imageTokens: 645 },
  };
  const PRICE_A = CLAUDE_PRICES[claudeModel] ?? CLAUDE_PRICES["claude-haiku-4-5"]!;
  const PRICE_B = GEMINI_PRICES[geminiModel] ?? GEMINI_PRICES["gemini-3.5-flash"]!;

  const rounds = Number(flagVal("--rounds") ?? 3);
  const judge = has("--judge") ? makeClaudeJudge(anthropicKey) : undefined;
  process.stdout.write(header(`Observer A/B — ${claudeModel} vs ${geminiModel}`));
  process.stdout.write(
    `\n  ${dim(`${rounds} real windows from your ledger · nothing persisted` +
      (judge ? " · blind judge: claude-haiku-4-5 (randomized positions)" : ""))}\n`,
  );

  const trunc = (s: string | undefined, n: number) => {
    const c = String(s ?? "—").replace(/\s+/g, " ").trim();
    return c.length > n ? c.slice(0, n) + "…" : c;
  };

  const results = await runAb(store, a, b, {
    rounds,
    stepMinutes: Number(flagVal("--step") ?? 15),
    judge,
    onRound: (r, i) => {
      process.stdout.write(`\n${bold(cyan(`ROUND ${i + 1}`))} ${dim(`window ending ${r.endTs} · ${r.actionCount} actions`)}\n`);
      for (const [tag, obs, ms] of [
        ["A " + claudeModel, r.a, r.aMs],
        ["B " + geminiModel, r.b, r.bMs],
      ] as const) {
        process.stdout.write(`  ${bold(tag)} ${dim(`(${ms}ms)`)}\n`);
        process.stdout.write(`    intent:      ${trunc(obs.intent, 90)}\n`);
        if (obs.inferredPreference)
          process.stdout.write(`    preference:  ${trunc(obs.inferredPreference, 90)}\n`);
        process.stdout.write(`    uncertainty: ${obs.uncertainty.length} item(s)\n`);
        if (obs.suggestedQuestion)
          process.stdout.write(`    question:    ${trunc(obs.suggestedQuestion, 90)}\n`);
      }
      if (r.verdict) {
        const who = r.verdict.winner === "a" ? claudeModel : r.verdict.winner === "b" ? geminiModel : "tie";
        process.stdout.write(`  ${green("⚖")} ${bold(who)} — ${trunc(r.verdict.reason, 110)}\n`);
      }
    },
  });

  if (!results.length) {
    process.stdout.write(`\n${red("✗")} no recent windows with enough actions to compare\n`);
    store.close();
    return;
  }

  const avg = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);
  const textChars = 14_000; // typical rendered bundle
  const costA = estimateCost({ textChars, images: 4 }, PRICE_A);
  const costB = estimateCost({ textChars, images: 4 }, PRICE_B);
  const tally = { a: 0, b: 0, tie: 0 };
  for (const r of results) if (r.verdict) tally[r.verdict.winner]++;

  process.stdout.write(header("Summary"));
  process.stdout.write(
    `\n  ${bold("A " + claudeModel)}   avg ${avg(results.map((r) => r.aMs))}ms · ~$${costA.toFixed(4)}/call\n` +
      `  ${bold("B " + geminiModel)}   avg ${avg(results.map((r) => r.bMs))}ms · ~$${costB.toFixed(4)}/call ${dim(costB < costA ? `(${(costA / costB).toFixed(1)}x cheaper)` : `(${(costB / costA).toFixed(1)}x MORE expensive)`)}\n`,
  );
  if (judge)
    process.stdout.write(
      `  ${bold("judge:")} ${claudeModel} ${tally.a} · ${geminiModel} ${tally.b} · tie ${tally.tie}\n`,
    );
  process.stdout.write(
    dim(`\n  Switch the live loop: PRAXIS_OBSERVER=gemini in the bar's env (or ask me).\n`),
  );
  store.close();
}

function cmdProfile(): void {
  const store = openStore(flagVal("--data") ? { dir: flagVal("--data")! } : {});
  // Drop the stale code-template artifact noise; fold in corrections; consolidate.
  const raw = store.claims.all().filter((c) => c.kind !== "artifact_type");
  const corrections = store.corrections.all();
  const surviving = applyCorrections(raw, corrections);
  const profile = consolidate(raw, { corrections });
  const cov = evidenceCoverage(raw, profile, corrections);
  const rejected = raw.length - surviving.length;

  const trunc = (s: string, n: number) => {
    const c = String(s ?? "").replace(/\s+/g, " ").trim();
    return c.length > n ? c.slice(0, n) + "…" : c;
  };
  const labels: Record<string, string> = {
    decision_rule: "DECISIONS — what you choose / avoid",
    taste_rule: "TASTE / STYLE",
    know_how: "KNOW-HOW",
    workflow_pattern: "WORKFLOW PATTERNS",
    unresolved_question: "OPEN QUESTIONS (it's unsure)",
    correction: "CORRECTIONS",
  };
  const order = Object.keys(labels);
  const byKind = new Map<string, typeof profile>();
  for (const p of profile) {
    const arr = byKind.get(p.kind) ?? [];
    arr.push(p);
    byKind.set(p.kind, arr);
  }

  process.stdout.write(header("Your Praxis profile"));
  process.stdout.write(
    "\n  " +
      dim(
        `${raw.length} raw claims → ${profile.length} consolidated · ` +
          (rejected > 0 ? `${yellow(String(rejected))} suppressed by your corrections · ` : "") +
          `${cov.dropped.length} episodes dropped ` +
          (cov.dropped.length === 0 ? green("(no signal lost ✓)") : red("(SIGNAL LOST!)")),
      ) +
      "\n  " +
      dim(`${green("●")} durable (seen ≥2 episodes)   ${gray("○")} provisional (one-off)`) +
      "\n\n",
  );
  const showAll = has("--all");
  const cap = showAll ? Infinity : 8;
  for (const k of order) {
    // Durable (recurring) traits first, then by confidence.
    const items = (byKind.get(k) ?? []).sort(
      (a, b) =>
        Number(b.tier === "durable") - Number(a.tier === "durable") ||
        b.confidence - a.confidence,
    );
    if (!items.length) continue;
    process.stdout.write(bold(cyan(labels[k]!)) + "\n");
    for (const p of items.slice(0, cap)) {
      const dot = p.tier === "durable" ? green("●") : gray("○");
      const folded = p.variants.length ? dim(` (+${p.variants.length})`) : "";
      process.stdout.write(`  ${dot} ${conf(p.confidence)}  ${trunc(p.canonical, 92)}${folded}\n`);
    }
    if (items.length > cap)
      process.stdout.write(dim(`  … +${items.length - cap} more (--all to show)\n`));
    process.stdout.write("\n");
  }
  process.stdout.write(
    dim("  Mostly one-off (○) right now — durable (●) traits surface as patterns recur over days.\n"),
  );
  store.close();
}

function cmdExportSkill(): void {
  const store = openStore(flagVal("--data") ? { dir: flagVal("--data")! } : {});
  // Same view the profile command builds: drop stale code-template noise, fold
  // in the user's corrections, consolidate non-destructively.
  const raw = store.claims.all().filter((c) => c.kind !== "artifact_type");
  const corrections = store.corrections.all();
  const surviving = applyCorrections(raw, corrections);
  const profile = consolidate(raw, { corrections });
  const cov = evidenceCoverage(raw, profile, corrections);

  const md = renderSkill(profile, {
    name: flagVal("--name"),
    title: flagVal("--title"),
    description: flagVal("--description"),
    durableOnly: has("--durable-only"),
    generatedTs: nowIso(),
  });

  // Raw markdown to stdout so it pipes cleanly; the human summary goes to stderr.
  const out = flagVal("--out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md, "utf8");
  }
  process.stdout.write(md);

  const stats = skillStats(profile);
  const rejected = raw.length - surviving.length;
  process.stderr.write(
    header("Skill exported") +
      "\n  " +
      dim(
        `${profile.length} traits (${green(String(stats.durable))} durable, ` +
          `${gray(String(stats.provisional))} provisional) from ${stats.episodes} episodes` +
          (rejected > 0 ? ` · ${yellow(String(rejected))} suppressed by your corrections` : "") +
          ` · ${cov.dropped.length === 0 ? green("no signal lost ✓") : red(`${cov.dropped.length} episodes dropped!`)}`,
      ) +
      "\n  " +
      (out
        ? green("●") + ` wrote ${out}`
        : dim("printed to stdout — add --out=PATH to save, e.g. --out=~/.claude/skills/how-i-work/SKILL.md")) +
      "\n",
  );
  store.close();
}

async function cmdProxy(): Promise<void> {
  if (!has("--enable") && process.env.PRAXIS_PROXY_ENABLED !== "1") {
    process.stderr.write(
      `${red("✗")} proxy is disabled by default; pass --enable or set PRAXIS_PROXY_ENABLED=1\n`,
    );
    process.exitCode = 1;
    return;
  }
  const store = openStore(flagVal("--data") ? { dir: flagVal("--data")! } : {});
  const source = new AiProxySource();
  const ingest = makeIngest(store);
  source.start(ingest.ingest);
  const port = Number(flagVal("--port") ?? 4318);
  startAiProxy({ source, port, upstreamBase: flagVal("--upstream"), store });
  process.stdout.write(
    `${green("●")} AI proxy on :${port} → ${flagVal("--upstream") ?? "https://api.anthropic.com"}\n` +
      dim("  point your AI tool's base URL here; prompts/responses are recorded.\n"),
  );
  await new Promise(() => {});
}

async function cmdStudio(): Promise<void> {
  const { startStudio } = await import("../studio/server.ts");
  const dir = flagVal("--data");
  const store = openStore(dir ? { dir } : {});
  const port = Number(flagVal("--port") ?? 4319);
  startStudio(store, port);
}

main().catch((err) => {
  process.stderr.write(`praxis error: ${err?.stack ?? err}\n`);
  process.exit(1);
});
