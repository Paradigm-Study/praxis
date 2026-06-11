/**
 * Real-capture self-check: runs the NON-synthetic pipeline against a throwaway
 * git project. Exercises the filesystem, git, and terminal sources (which the
 * fixtures never touch), performs real edits / commands / a commit, then
 * reconstructs and fuses. Proves the live capture path works on real activity.
 *
 *   node --disable-warning=ExperimentalWarning scripts/real-capture-check.ts
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/storage/index.ts";
import { CaptureManager } from "../src/capture/manager.ts";
import { FilesystemSource } from "../src/capture/sources/filesystem.ts";
import { GitSource } from "../src/capture/sources/git.ts";
import { TerminalSource } from "../src/capture/sources/terminal.ts";
import { reconstruct } from "../src/reconstructor/reconstructor.ts";
import { fuse } from "../src/fuser/fuser.ts";
import { buildGraph } from "../src/memory/graph.ts";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (proj: string, ...args: string[]) => exec("git", ["-C", proj, ...args]);

async function main() {
  const proj = mkdtempSync(join(tmpdir(), "praxis-realproj-"));
  const cmdlog = join(proj, ".praxis", "cmdlog.ndjson");
  mkdirSync(join(proj, ".praxis"), { recursive: true });
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(cmdlog, "");

  await git(proj, "init", "-b", "main");
  await git(proj, "config", "user.email", "praxis@example.com");
  await git(proj, "config", "user.name", "Praxis");

  const store = openStore({ memory: true });
  const manager = new CaptureManager(store, [
    new FilesystemSource({ root: proj }),
    new GitSource({ repo: proj, intervalMs: 400 }),
    new TerminalSource({ logPath: cmdlog }),
  ]);
  let live = 0;
  manager.subscribe((e) => {
    live++;
    process.stdout.write(`  live ▸ ${e.source}/${e.type} ${JSON.stringify(e.payload).slice(0, 60)}\n`);
  });

  process.stdout.write(`\nReal capture in ${proj}\n\n`);
  await manager.start();

  const widget = join(proj, "src", "widget.ts");
  const logCmd = (cmd: string, exitCode: number) =>
    appendFileSync(
      cmdlog,
      JSON.stringify({ ts: new Date().toISOString(), cmd, cwd: proj, exitCode, durationMs: 1200 }) + "\n",
    );

  // 1. create a file, 2. edit it, 3. run a failing then passing test, 4. commit
  writeFileSync(widget, "export const widget = () => null;\n");
  await sleep(400);
  appendFileSync(widget, "// derive state from props, not globals\n");
  await sleep(400);
  logCmd("npm test", 1);
  await sleep(300);
  logCmd("npm test", 0);
  await sleep(300);
  await git(proj, "add", "-A");
  await sleep(500);
  await git(proj, "commit", "-m", "feat: add widget component");
  await sleep(1200); // let the git poller catch the commit

  await manager.stop();

  // --- reconstruct from the REAL captured events ---
  const actions = reconstruct(store);
  const [episode] = fuse(store);
  const { claims } = buildGraph(store);

  const bySource = new Map<string, number>();
  for (const e of store.events.range()) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);

  process.stdout.write(`\n=== Captured ${store.events.count()} real events: ` +
    [...bySource].map(([s, n]) => `${s}:${n}`).join("  ") + " ===\n");
  process.stdout.write(`\n=== Reconstructed ${actions.length} actions ===\n`);
  for (const a of actions) {
    process.stdout.write(`  ${a.confidence.toFixed(2)}  ${a.action.padEnd(18)} ${(a.text ?? "").slice(0, 50)}  ev:${a.evidence.length}\n`);
  }
  if (episode) {
    process.stdout.write(`\n=== Episode ===\n  ${episode.summary}\n  artifacts: ${episode.artifacts.join(", ")}\n  decisions: ${episode.decisionPoints.join(" | ") || "—"}\n`);
  }
  process.stdout.write(`\n=== Claims (${claims.length}) ===\n`);
  for (const c of claims) process.stdout.write(`  ${c.confidence.toFixed(2)}  [${c.kind}] ${c.text.slice(0, 60)}\n`);

  const ok = actions.some((a) => a.action === "committed") &&
    actions.some((a) => a.action === "edited_file") &&
    actions.some((a) => a.action === "ran_command");
  process.stdout.write(`\n${ok ? "OK" : "FAIL"} real capture path (fs + git + terminal → actions)\n`);
  store.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`error: ${err?.stack ?? err}\n`);
  process.exit(1);
});
