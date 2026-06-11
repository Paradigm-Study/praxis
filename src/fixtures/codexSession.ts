import { buildScenario, type ScenarioStep } from "../capture/sources/synthetic.ts";
import type { RawEventInput } from "../capture/source.ts";

/**
 * A realistic ~5-minute session that mirrors the design doc's worked example:
 * the user pushes Codex for *exact* action reconstruction, edits the
 * implementation, runs tests (fail -> fix -> pass), corrects the agent toward
 * evidence-backed actions, and commits.
 *
 * These are LOW-LEVEL raw events — exactly what the OS/tool taps would emit.
 * The reconstructor turns them into user actions; the fuser turns those into an
 * episode; the graph turns the episode into claims. The fixture deliberately
 * exercises every supported action type, including a weak "possibly reading"
 * case with no accessibility text.
 */

const BASE_TS = "2026-06-08T12:00:00.000Z";

const CODEX = { app: "Codex", window: "Codex — Praxis" };
const EDITOR = { app: "Cursor", window: "context-firehose.ts — praxis" };
const TERMINAL = { app: "iTerm2", window: "zsh — praxis" };
const DISCORD = { app: "Discord", window: "#eng — Paradigm" };

const steps: ScenarioStep[] = [
  // --- Open Codex and ask the framing question -----------------------------
  {
    afterMs: 0,
    source: "focus_timeline",
    ...CODEX,
    type: "app_focused",
    payload: { to: "Codex", from: "Finder", dwellMsPrev: 0 },
  },
  {
    afterMs: 1200,
    source: "accessibility",
    ...CODEX,
    type: "focused_text_changed",
    payload: {
      role: "textfield",
      element: "composer",
      value: "how are we achieving exact action reconstruction",
    },
  },
  {
    afterMs: 2200,
    source: "screen_video",
    ...CODEX,
    type: "frame",
    payload: { ocrText: "how are we achieving exact action reconstruction" },
    blobs: [{ kind: "image", data: "PNGDATA:codex-composer-frame" }],
  },
  {
    afterMs: 400,
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
    payload: {
      role: "user",
      text: "how are we achieving exact action reconstruction",
    },
  },
  {
    afterMs: 250,
    source: "ai_proxy",
    ...CODEX,
    type: "ai_request",
    payload: {
      model: "gpt-5-codex",
      prompt: "how are we achieving exact action reconstruction",
    },
  },
  {
    afterMs: 3800,
    source: "ai_proxy",
    ...CODEX,
    type: "ai_response",
    payload: {
      model: "gpt-5-codex",
      text:
        "We could infer actions purely from screen video. Would you like me to " +
        "drive reconstruction from the video model?",
    },
  },
  {
    afterMs: 200,
    source: "accessibility",
    ...CODEX,
    type: "conversation_bubble_added",
    payload: {
      role: "assistant",
      text:
        "We could infer actions purely from screen video. Would you like me to " +
        "drive reconstruction from the video model?",
    },
  },
  // user reads the response (dwell, no input)
  {
    afterMs: 4200,
    source: "focus_timeline",
    ...CODEX,
    type: "dwell",
    payload: { dwellMs: 4200 },
  },

  // --- Correct the agent: model is not the source of truth -----------------
  {
    afterMs: 2600,
    source: "accessibility",
    ...CODEX,
    type: "focused_text_changed",
    payload: {
      role: "textfield",
      element: "composer",
      value:
        "no — don't rely on video-only inference. the model should not be the " +
        "source of truth. prefer evidence-backed action reconstruction.",
    },
  },
  {
    afterMs: 1800,
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
    payload: {
      role: "user",
      text:
        "no — don't rely on video-only inference. the model should not be the " +
        "source of truth. prefer evidence-backed action reconstruction.",
    },
  },

  // --- Switch to the editor, accept an AI edit, edit, save -----------------
  {
    afterMs: 2000,
    source: "focus_timeline",
    ...EDITOR,
    type: "app_focused",
    payload: { to: "Cursor", from: "Codex", dwellMsPrev: 13000 },
  },
  {
    afterMs: 600,
    source: "accessibility",
    ...EDITOR,
    type: "ui_snapshot",
    payload: {
      focusedRole: "editor",
      title: "src/context-firehose.ts",
      visibleText: "export class ContextFirehose {",
    },
  },
  {
    afterMs: 1500,
    source: "accessibility",
    ...EDITOR,
    type: "control_clicked",
    payload: { role: "button", title: "Accept" },
  },
  {
    afterMs: 1200,
    source: "filesystem",
    ...EDITOR,
    type: "file_changed",
    payload: {
      path: "src/context-firehose.ts",
      hashAfter: "sha256:aaa111",
      bytes: 4120,
    },
    blobs: [
      {
        kind: "diff",
        data:
          "+++ src/context-firehose.ts\n+  // reconstruct actions from the raw " +
          "event ledger, never from the model alone",
      },
    ],
  },
  {
    afterMs: 900,
    source: "input_events",
    ...EDITOR,
    type: "key_down",
    payload: { key: "s", mods: ["cmd"] },
  },
  {
    afterMs: 120,
    source: "filesystem",
    ...EDITOR,
    type: "file_saved",
    payload: {
      path: "src/context-firehose.ts",
      hashAfter: "sha256:aaa111",
      bytes: 4120,
    },
  },

  // --- Run tests: FAIL -----------------------------------------------------
  {
    afterMs: 1500,
    source: "focus_timeline",
    ...TERMINAL,
    type: "app_focused",
    payload: { to: "iTerm2", from: "Cursor", dwellMsPrev: 5300 },
  },
  {
    afterMs: 700,
    source: "terminal",
    ...TERMINAL,
    type: "command_run",
    payload: { cmd: "npm test", cwd: "~/praxis", exitCode: 1, durationMs: 2400 },
    blobs: [
      {
        kind: "text",
        data: "FAIL test/reconstructor.test.ts\n  1 failing, 12 passing",
      },
    ],
  },
  // inspect the failure (dwell on terminal output)
  {
    afterMs: 3000,
    source: "focus_timeline",
    ...TERMINAL,
    type: "dwell",
    payload: { dwellMs: 3000 },
  },
  // copy the error, paste into Codex
  {
    afterMs: 1200,
    source: "clipboard",
    ...TERMINAL,
    type: "clipboard_changed",
    payload: { op: "copy", text: "Expected confidence >= 0.9, received 0.0" },
  },

  // --- A weak "possibly reading" detour: Discord, no AX text ---------------
  {
    afterMs: 1500,
    source: "focus_timeline",
    ...DISCORD,
    type: "app_focused",
    payload: { to: "Discord", from: "iTerm2", dwellMsPrev: 5700 },
  },
  {
    afterMs: 200,
    source: "screen_video",
    ...DISCORD,
    type: "frame",
    payload: {},
    blobs: [{ kind: "image", data: "PNGDATA:discord-thread-frame" }],
  },
  {
    afterMs: 6000,
    source: "focus_timeline",
    ...DISCORD,
    type: "dwell",
    payload: { dwellMs: 6000 },
  },

  // --- Back to editor: fix, save -------------------------------------------
  {
    afterMs: 2000,
    source: "focus_timeline",
    ...EDITOR,
    type: "app_focused",
    payload: { to: "Cursor", from: "Discord", dwellMsPrev: 6200 },
  },
  {
    afterMs: 800,
    source: "filesystem",
    ...EDITOR,
    type: "file_changed",
    payload: {
      path: "src/context-firehose.ts",
      hashAfter: "sha256:bbb222",
      bytes: 4360,
    },
    blobs: [
      {
        kind: "diff",
        data:
          "+++ src/context-firehose.ts\n+  confidence = scoreEvidence(events) " +
          "// derive confidence from corroborating taps",
      },
    ],
  },
  {
    afterMs: 700,
    source: "input_events",
    ...EDITOR,
    type: "key_down",
    payload: { key: "s", mods: ["cmd"] },
  },
  {
    afterMs: 120,
    source: "filesystem",
    ...EDITOR,
    type: "file_saved",
    payload: {
      path: "src/context-firehose.ts",
      hashAfter: "sha256:bbb222",
      bytes: 4360,
    },
  },

  // --- Run tests again: PASS (a retry of the same command) -----------------
  {
    afterMs: 1500,
    source: "focus_timeline",
    ...TERMINAL,
    type: "app_focused",
    payload: { to: "iTerm2", from: "Cursor", dwellMsPrev: 3400 },
  },
  {
    afterMs: 700,
    source: "terminal",
    ...TERMINAL,
    type: "command_run",
    payload: { cmd: "npm test", cwd: "~/praxis", exitCode: 0, durationMs: 2300 },
    blobs: [{ kind: "text", data: "PASS  13 passing" }],
  },

  // --- Commit --------------------------------------------------------------
  {
    afterMs: 2500,
    source: "git",
    ...TERMINAL,
    type: "commit",
    payload: {
      sha: "9f2a1c7",
      message: "feat: evidence-backed action reconstructor",
      files: ["src/context-firehose.ts", "test/reconstructor.test.ts"],
      branch: "main",
    },
  },
];

/** The fully-timestamped raw event stream for the demo + tests. */
export function codexSessionEvents(): RawEventInput[] {
  return buildScenario(BASE_TS, steps);
}

export const CODEX_SESSION_BASE_TS = BASE_TS;
