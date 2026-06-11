import type { Store } from "../storage/index.ts";
import { makeIngest } from "../capture/ingest.ts";
import { replay } from "../capture/sources/synthetic.ts";
import { codexSessionEvents } from "../fixtures/codexSession.ts";
import { followupSessionEvents } from "../fixtures/followupSession.ts";
import { reconstruct } from "../reconstructor/reconstructor.ts";
import { fuse } from "../fuser/fuser.ts";
import { buildGraph } from "../memory/graph.ts";
import { bundleForEpisode } from "../observer/bundle.ts";
import { MockObserver, type Observer } from "../observer/observer.ts";
import { decide } from "../agent/policy.ts";
import { buildPlaybook, critique } from "../transfer/transfer.ts";
import { makeSeededIdGen } from "../core/ids.ts";
import type { ActionEvent } from "../core/types.ts";
import {
  bold,
  bullet,
  conf,
  cyan,
  dim,
  gray,
  green,
  header,
  pad,
  red,
  yellow,
} from "./render.ts";

export interface DemoOptions {
  observer?: Observer;
}

/** Wipe all derived + raw tables so the demo is reproducible. */
export function clearAll(store: Store): void {
  for (const t of [
    "raw_events",
    "blobs",
    "action_events",
    "episodes",
    "claims",
    "graph_nodes",
    "graph_edges",
    "observations",
    "corrections",
  ]) {
    store.db.exec(`DELETE FROM ${t};`);
  }
}

export async function runDemo(store: Store, opts: DemoOptions = {}): Promise<void> {
  const newId = makeSeededIdGen();
  const observer = opts.observer ?? new MockObserver();
  const out = (s = "") => process.stdout.write(s + "\n");

  out(bold(cyan("\nPraxis — Context Firehose + Action Reconstructor")));
  out(dim("Raw taps prove what happened. The model explains why it mattered.\n"));

  // 1. Capture -------------------------------------------------------------
  const ingest = makeIngest(store);
  await replay(codexSessionEvents(), ingest.ingest);
  await replay(followupSessionEvents(), ingest.ingest);

  out(header("Layer 1-2  Universal Capture → Raw Event Ledger"));
  const bySource = store.analytics.timePerApp();
  const sources = new Map<string, number>();
  for (const e of store.events.range())
    sources.set(e.source, (sources.get(e.source) ?? 0) + 1);
  out(
    `  ${store.events.count()} raw events across ${sources.size} sources, ` +
      `${countBlobs(store)} blobs (content-addressed).`,
  );
  out(
    "  " +
      [...sources.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `${gray(s)}:${n}`)
        .join("  "),
  );

  // 2. Reconstruct ---------------------------------------------------------
  const actions = reconstruct(store, { newId });
  out(header("Layer 3  Action Reconstructor (exact, evidence-backed)"));
  for (const a of actions) {
    const unc = a.uncertainty ? "  " + yellow("⚠ " + a.uncertainty[0]) : "";
    out(
      `  ${conf(a.confidence)}  ${pad(String(a.action), 22)} ${gray(
        pad("[" + a.app + "]", 10),
      )} ${truncate(a.text ?? "", 40)} ${dim("ev:" + a.evidence.length)}${unc}`,
    );
  }

  // 3. Fuse ----------------------------------------------------------------
  const episodes = fuse(store, { newId });
  out(header("Layer 4  Context Episode Fuser"));
  for (const e of episodes) {
    out(`  ${bold(e.id)}  ${gray(e.boundaryReason ?? "")}`);
    out(`    ${e.summary}`);
    if (e.goal) out(`    ${dim("goal:")} ${e.goal}`);
    if (e.artifacts.length) out(`    ${dim("artifacts:")} ${e.artifacts.join(", ")}`);
    if (e.decisionPoints.length)
      out(`    ${dim("decisions:")} ${e.decisionPoints.map((d) => truncate(d, 60)).join(" | ")}`);
    if (e.rejectedPaths.length)
      out(`    ${dim("rejected:")} ${red(e.rejectedPaths.join(", "))}`);
    if (e.uncertainty.length)
      out(`    ${dim("uncertainty:")} ${yellow(e.uncertainty.join(" | "))}`);
  }

  // 4. Memory graph --------------------------------------------------------
  const { claims, nodes, edges } = buildGraph(store, { newId });
  out(header("Layer 6  Expert Memory Graph"));
  out(`  ${nodes.length} nodes, ${edges.length} edges`);
  for (const c of claims.sort((a, b) => b.confidence - a.confidence)) {
    out(
      `  ${conf(c.confidence)}  ${gray(pad(c.kind, 18))} ${truncate(c.text, 56)} ` +
        dim(`(${c.evidenceEpisodes.length} ep)`),
    );
  }
  const reused = edges.filter((e) => e.kind === "reused_across_days").length;
  if (reused) out(`  ${green("↻")} ${reused} pattern(s) reused across days`);

  // 5. Observe (the rich first episode) ------------------------------------
  const rich = episodes[0]!;
  const bundle = bundleForEpisode(store, rich, newId);
  const obs = await observer.observe(bundle, { episodeId: rich.id, newId });
  store.observations.put(obs);
  out(header(`Layer 5  Multimodal Observer  ${dim("(model=" + obs.model + ")")}`));
  out(`  ${dim("intent:")}     ${obs.intent}`);
  if (obs.decisionPoint) out(`  ${dim("decision:")}   ${obs.decisionPoint}`);
  if (obs.inferredPreference) out(`  ${dim("preference:")} ${obs.inferredPreference}`);
  if (obs.rejectedOptions.length)
    out(`  ${dim("rejected:")}   ${red(obs.rejectedOptions.join(", "))}`);
  out(`  ${dim("evidence:")}   ${obs.evidence.length} action ids ${gray("(interpretation, not raw fact)")}`);

  // 6. Agent decision ------------------------------------------------------
  const richActions = store.actions.byIds(rich.actions);
  const decision = decide({
    observation: obs,
    actions: richActions,
    claims,
    learnerMode: false,
  });
  store.decisions.put({
    id: newId("decision"),
    kind: decision.kind,
    reason: decision.reason,
    question: decision.question,
    evidence: decision.evidence ?? [],
    observationId: obs.id,
    claimId: decision.claim?.id,
    createdTs: obs.createdTs,
  });
  out(header("Layer 7  Agent Loop — decision"));
  out(`  ${bold(decisionColor(decision.kind))}  ${decision.reason}`);
  if (decision.question) out(`\n  ${bold("❝ " + decision.question + " ❞")}`);

  // 7. Transfer ------------------------------------------------------------
  const playbook = buildPlaybook(store);
  out(header("Layer 11  Transfer — operate from the learned model"));
  out(`  ${dim("workflow:")} ${playbook.workflow.join(" → ")}`);
  for (const r of playbook.decisionRules) out(bullet(`${dim("rule:")} ${r.text}`));
  out(`\n  ${dim("Critique of a learner who commits without testing:")}`);
  for (const adv of critique(playbook, learnerCommitWithoutTests()))
    out("  " + yellow("⚠ " + adv));

  // 8. Definition of success ----------------------------------------------
  out(header("Definition of Success"));
  const firstSubmit = actions.find((a) => a.action === "submitted_message");
  answer(out, "What did the user do?", `${actions.length} reconstructed actions`);
  answer(out, "In what order?", "time-ordered action timeline above");
  answer(out, "In which app/tool/artifact?", playbook.artifactTypes.join("; ") || "tracked per action");
  answer(out, "What did they reject?", red(rich.rejectedPaths.join(", ") || "—"));
  answer(out, "What did they accept?", obs.acceptedOptions.join(", ") || "—");
  answer(out, "What did they correct?", truncate(rich.decisionPoints[0] ?? "—", 50));
  answer(out, "What pattern does this reveal?", playbook.workflow.join(" → "));
  answer(
    out,
    "What evidence supports that claim?",
    `every claim links to episodes; every action to ${firstSubmit?.evidence.length ?? 0}+ raw events`,
  );
  out(
    "\n" +
      dim("Stored at ") +
      cyan(store.paths.db) +
      dim("  — run ") +
      bold("praxis studio") +
      dim(" to explore.\n"),
  );
}

function learnerCommitWithoutTests(): ActionEvent[] {
  const base = {
    type: "user_action" as const,
    confidence: 0.95,
    evidence: [] as string[],
    startTs: "2026-06-10T10:00:00.000Z",
    endTs: "2026-06-10T10:00:00.000Z",
  };
  return [
    { ...base, id: "demo_a1", action: "edited_file", app: "Cursor", text: "src/x.ts" },
    { ...base, id: "demo_a2", action: "committed", app: "iTerm2", text: "wip" },
  ];
}

function answer(out: (s?: string) => void, q: string, a: string): void {
  out(`  ${green("✓")} ${pad(q, 36)} ${gray("→")} ${a}`);
}

function decisionColor(kind: string): string {
  if (kind === "ask_expert") return yellow(kind);
  if (kind === "intervene") return red(kind);
  return green(kind);
}

function countBlobs(store: Store): number {
  return (store.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number }).n;
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}
