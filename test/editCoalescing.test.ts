import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawEvent } from "../src/core/types.ts";
import { coalesceEditActions } from "../src/reconstructor/coalesce.ts";
import { reconstructEvents } from "../src/reconstructor/reconstructor.ts";

const BASE = Date.parse("2026-07-13T12:00:00.000Z");

function timestamp(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

function event(
  id: string,
  ts: string,
  source: RawEvent["source"],
  type: string,
  payload: Record<string, unknown>,
  blobRefs: string[] = [],
): RawEvent {
  return {
    id,
    ts,
    source,
    app: source === "filesystem" ? "filesystem" : "Claude Code",
    window: source === "filesystem" ? "workspace" : "Claude Code",
    type,
    payload,
    blobRefs,
    hash: `hash_${id}`,
  };
}

function agentEdit(
  id: string,
  filePath: string,
  startMs: number,
  endMs: number,
  cwd = "/Users/dev/workspace",
): RawEvent[] {
  const sessionKey = `session_${id}`;
  const toolUseId = `tool_${id}`;
  return [
    event(id, timestamp(startMs), "ai_proxy", "ai_response", {
      sessionKey,
      toolUseId,
      tool: "Edit",
      filePath,
      cwd,
    }),
    event(`${id}_result`, timestamp(endMs), "ai_proxy", "ai_request", {
      sessionKey,
      toolUseId,
      role: "tool_result",
    }),
  ];
}

function filesystemEdit(
  id: string,
  path: string,
  atMs: number,
  workspaceRoot?: string,
): RawEvent {
  return event(
    id,
    timestamp(atMs),
    "filesystem",
    "file_changed",
    {
      path,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      hashAfter: `sha256:${id}`,
    },
    [`diff_${id}`],
  );
}

function edits(events: RawEvent[]) {
  return reconstructEvents(events).filter((action) => action.action === "edited_file");
}

test("successful agent edit and filesystem write coalesce into one stable action", () => {
  const agentEvents = agentEdit(
    "agent_edit",
    "./src/../src/index.ts",
    0,
    500,
    "/Users/dev/workspace/",
  );
  const filesystemEvent = filesystemEdit(
    "filesystem_edit",
    "src/index.ts",
    250,
    "/Users/dev/workspace",
  );
  const agentOnly = edits(agentEvents)[0]!;
  const filesystemOnly = edits([filesystemEvent])[0]!;
  const merged = edits([
    ...agentEvents.slice(0, 1),
    filesystemEvent,
    ...agentEvents.slice(1),
  ])[0]!;

  assert.equal(edits([...agentEvents, filesystemEvent]).length, 1);
  assert.equal(merged.id, agentOnly.id, "the structured successful edit owns the stable id");
  assert.deepEqual(merged.evidence, ["agent_edit", "agent_edit_result", "filesystem_edit"]);
  assert.deepEqual(merged.reconstructedBy, ["agent.agentEditedFile", "editedFile"]);
  assert.equal(merged.payload?.hashAfter, "sha256:filesystem_edit");
  assert.equal(merged.payload?.filePath, "./src/../src/index.ts");
  assert.equal(
    merged.confidence,
    Math.max(agentOnly.confidence, filesystemOnly.confidence),
  );

  const withUncertainty = coalesceEditActions([
    { ...agentOnly, confidence: 0.8, uncertainty: ["agent timing"] },
    {
      ...filesystemOnly,
      confidence: 0.9,
      uncertainty: ["watcher timing", "agent timing"],
    },
  ]);
  assert.equal(withUncertainty.length, 1);
  assert.equal(
    withUncertainty[0]?.confidence,
    0.9,
    "corroboration never lowers confidence",
  );
  assert.deepEqual(withUncertainty[0]?.uncertainty, ["agent timing", "watcher timing"]);
});

test("legacy filesystem events without workspace metadata still match exact relative paths", () => {
  const events = [
    ...agentEdit(
      "absolute_agent_edit",
      "/Users/dev/workspace/src/index.ts",
      0,
      400,
    ),
    filesystemEdit("legacy_filesystem_edit", "src/index.ts", 200),
  ];
  assert.equal(edits(events).length, 1);
});

test("different paths, workspaces, and distant timestamps remain distinct edits", () => {
  const differentPath = edits([
    ...agentEdit("path_agent", "src/a.ts", 0, 300),
    filesystemEdit("path_filesystem", "src/b.ts", 150, "/Users/dev/workspace"),
  ]);
  assert.equal(differentPath.length, 2);

  const differentWorkspace = edits([
    ...agentEdit("workspace_agent", "src/a.ts", 0, 300, "/Users/dev/repo-a"),
    filesystemEdit("workspace_filesystem", "src/a.ts", 150, "/Users/dev/repo-b"),
  ]);
  assert.equal(differentWorkspace.length, 2);

  const distant = edits([
    ...agentEdit("distant_agent", "src/a.ts", 0, 300),
    filesystemEdit("distant_filesystem", "src/a.ts", 5_000, "/Users/dev/workspace"),
  ]);
  assert.equal(distant.length, 2);
});

test("rapid repeated writes pair one-to-one instead of collapsing transitively", () => {
  const events = [
    ...agentEdit("first_agent", "src/repeated.ts", 0, 300),
    filesystemEdit("first_filesystem", "src/repeated.ts", 150, "/Users/dev/workspace"),
    ...agentEdit("second_agent", "src/repeated.ts", 1_000, 1_300),
    filesystemEdit("second_filesystem", "src/repeated.ts", 1_150, "/Users/dev/workspace"),
  ];
  const reconstructed = edits(events);

  assert.equal(reconstructed.length, 2);
  assert.deepEqual(
    reconstructed.map((action) => action.evidence),
    [
      ["first_agent", "first_agent_result", "first_filesystem"],
      ["second_agent", "second_agent_result", "second_filesystem"],
    ],
  );
});
