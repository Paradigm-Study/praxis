import { openStore, defaultDataDir, type Store } from "../storage/index.ts";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { runDemo, clearAll } from "./demo.ts";
import { reconstruct } from "../reconstructor/reconstructor.ts";
import { fuse } from "../fuser/fuser.ts";
import { buildGraph } from "../memory/graph.ts";
import { buildBundle } from "../observer/bundle.ts";
import { defaultObserver, MockObserver } from "../observer/observer.ts";
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
import { join, dirname } from "node:path";
import { loadEnvFile } from "../core/env.ts";
import { bold, conf, cyan, dim, gray, green, header, red, yellow } from "./render.ts";
import { consolidate, evidenceCoverage, applyCorrections } from "../memory/consolidate.ts";
import { renderSkill, skillStats } from "../transfer/skill.ts";
import { nowIso } from "../core/time.ts";

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
    case "status":
      return cmdStatus();
    case "reset":
      return cmdReset();
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
      `  ${green("status")}       Show ledger counts\n` +
      `  ${green("reset")}        Clear derived data (or everything with --all) + vacuum\n` +
      `  ${green("profile")}      Show your consolidated profile  [--all]\n` +
      `  ${green("export-skill")} Export your profile as a portable SKILL.md  [--out=PATH --name= --title= --durable-only]\n` +
      `  ${green("studio")}       Launch Praxis Studio (web UI)  [--port=4319]\n` +
      `  ${green("proxy")}        Run the AI proxy that records prompts/responses  [--port=4318 --upstream=...]\n` +
      `  ${green("hook")}         Print the zsh hook for terminal capture\n\n` +
      `${dim("Data dir: $PRAXIS_DATA_DIR or ./data")}\n`,
  );
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
  const observer = defaultObserver();
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
  const sources = [];
  if (has("--synthetic")) {
    sources.push(
      new SyntheticSource([...codexSessionEvents(), ...followupSessionEvents()], {
        realtime: true,
        speed: Number(flagVal("--speed") ?? 50),
      }),
    );
  } else {
    sources.push(new ClipboardSource({ frontApp: () => manager.frontApp() }));
    sources.push(new TerminalSource({ logPath: join(homedir(), ".praxis", "cmdlog.ndjson") }));

    // Filesystem + git taps are OPT-IN — point them at YOUR project(s), not at
    // wherever capture was launched (which would just record Praxis's own files).
    const watchDirs = (flagVal("--watch") ?? process.env.PRAXIS_WATCH ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    for (const dir of watchDirs) {
      sources.push(new FilesystemSource({ root: dir }));
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
    else if (has("--native")) sources.push(new NativeCaptureSource());
  }

  const manager = new CaptureManager(store, sources);
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
      observer: useModel ? defaultObserver() : new MockObserver(),
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
  const store = openStore(flagVal("--data") ? { dir: flagVal("--data")! } : {});
  const source = new AiProxySource();
  const ingest = makeIngest(store);
  source.start(ingest.ingest);
  const port = Number(flagVal("--port") ?? 4318);
  startAiProxy({ source, port, upstreamBase: flagVal("--upstream") });
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
