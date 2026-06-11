import { buildScenario, type ScenarioStep } from "../capture/sources/synthetic.ts";
import type { RawEventInput } from "../capture/source.ts";

/**
 * A shorter session the NEXT DAY that reuses the same workflow (consult AI →
 * edit → test → commit) on a different file. This is what lets the memory graph
 * promote the workflow pattern with a `reused_across_days` edge and raise its
 * confidence — and what the Studio "Connections" view surfaces.
 */
const BASE_TS = "2026-06-09T09:15:00.000Z";

const CODEX = { app: "Codex", window: "Codex — Praxis" };
const EDITOR = { app: "Cursor", window: "episode-fuser.ts — praxis" };
const TERMINAL = { app: "iTerm2", window: "zsh — praxis" };

const steps: ScenarioStep[] = [
  {
    afterMs: 0,
    source: "focus_timeline",
    ...CODEX,
    type: "app_focused",
    payload: { to: "Codex", from: "Finder" },
  },
  {
    afterMs: 1000,
    source: "accessibility",
    ...CODEX,
    type: "focused_text_changed",
    payload: {
      role: "textfield",
      element: "composer",
      value: "how should the fuser decide episode boundaries",
    },
  },
  {
    afterMs: 1500,
    source: "input_events",
    ...CODEX,
    type: "key_down",
    payload: { key: "Enter", mods: [] },
  },
  {
    afterMs: 150,
    source: "accessibility",
    ...CODEX,
    type: "conversation_bubble_added",
    payload: { role: "user", text: "how should the fuser decide episode boundaries" },
  },
  {
    afterMs: 200,
    source: "ai_proxy",
    ...CODEX,
    type: "ai_request",
    payload: { model: "gpt-5-codex", prompt: "episode boundaries" },
  },
  {
    afterMs: 2500,
    source: "focus_timeline",
    ...EDITOR,
    type: "app_focused",
    payload: { to: "Cursor", from: "Codex" },
  },
  {
    afterMs: 900,
    source: "filesystem",
    ...EDITOR,
    type: "file_changed",
    payload: { path: "src/episode-fuser.ts", hashAfter: "sha256:ccc333", bytes: 2200 },
    blobs: [{ kind: "diff", data: "+++ src/episode-fuser.ts\n+ boundary scoring" }],
  },
  {
    afterMs: 600,
    source: "filesystem",
    ...EDITOR,
    type: "file_saved",
    payload: { path: "src/episode-fuser.ts", hashAfter: "sha256:ccc333", bytes: 2200 },
  },
  {
    afterMs: 1500,
    source: "focus_timeline",
    ...TERMINAL,
    type: "app_focused",
    payload: { to: "iTerm2", from: "Cursor" },
  },
  {
    afterMs: 700,
    source: "terminal",
    ...TERMINAL,
    type: "command_run",
    payload: { cmd: "npm test", cwd: "~/praxis", exitCode: 0, durationMs: 2100 },
    blobs: [{ kind: "text", data: "PASS 18 passing" }],
  },
  {
    afterMs: 2000,
    source: "git",
    ...TERMINAL,
    type: "commit",
    payload: {
      sha: "a4b8e21",
      message: "feat: scored episode boundary detection",
      files: ["src/episode-fuser.ts"],
      branch: "main",
    },
  },
];

export function followupSessionEvents(): RawEventInput[] {
  return buildScenario(BASE_TS, steps);
}

export const FOLLOWUP_SESSION_BASE_TS = BASE_TS;
