import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseActions } from "../src/fuser/fuser.ts";
import { boundaryBetween } from "../src/fuser/boundaries.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import { fullPipeline, action } from "./helpers.ts";

test("a coherent session fuses into one episode", async () => {
  const { episodes } = await fullPipeline(false); // single session
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]!.boundaryReason, "session_start");
});

test("episode captures rejectedPaths, artifacts, decisions, uncertainty", async () => {
  const { episodes } = await fullPipeline(false);
  const e = episodes[0]!;
  assert.deepEqual(e.rejectedPaths, ["video-only inference"]);
  assert.ok(e.artifacts.includes("src/context-firehose.ts"));
  assert.ok(e.decisionPoints.some((d) => /video-only/.test(d)));
  assert.ok(e.uncertainty.some((u) => /no AX text/i.test(u)));
});

test("a long dwell gap splits into two episodes", () => {
  const actions = [
    action({ action: "edited_file", startTs: "2026-06-08T12:00:00.000Z" }),
    action({ action: "saved_file", startTs: "2026-06-08T12:00:10.000Z" }),
    // 10 minute gap →
    action({ action: "submitted_message", startTs: "2026-06-08T12:10:30.000Z" }),
  ];
  const eps = fuseActions(actions, { newId: makeSeededIdGen() });
  assert.equal(eps.length, 2);
  assert.equal(eps[1]!.boundaryReason, "long_dwell_gap");
});

test("a commit closes an episode", () => {
  assert.equal(
    boundaryBetween(
      action({ action: "committed", startTs: "2026-06-08T12:00:00.000Z" }),
      action({ action: "edited_file", startTs: "2026-06-08T12:00:05.000Z" }),
    ),
    "file_save_commit",
  );
});

test("goal provenance lands in payload.goalSource (commit vs prompt)", () => {
  const fromPrompt = fuseActions(
    [
      action({
        action: "submitted_message",
        startTs: "2026-06-08T12:00:00.000Z",
        text: "please migrate the billing tables\nand more detail here",
      }),
    ],
    { newId: makeSeededIdGen() },
  )[0]!;
  assert.equal(fromPrompt.goal, "please migrate the billing tables");
  assert.equal(fromPrompt.payload?.goalSource, "prompt");

  const fromCommit = fuseActions(
    [
      action({
        action: "committed",
        startTs: "2026-06-08T12:00:00.000Z",
        text: "fix: retry on 429",
      }),
    ],
    { newId: makeSeededIdGen() },
  )[0]!;
  assert.equal(fromCommit.goal, "fix: retry on 429");
  assert.equal(fromCommit.payload?.goalSource, "commit");
});

test("mid-task app switch with no gap does NOT split", () => {
  assert.equal(
    boundaryBetween(
      action({ action: "edited_file", app: "Cursor", startTs: "2026-06-08T12:00:00.000Z" }),
      action({ action: "ran_command", app: "iTerm2", startTs: "2026-06-08T12:00:02.000Z" }),
    ),
    undefined,
  );
});

test("agent transcript filePath values become episode artifacts", () => {
  const episode = fuseActions(
    [
      action({
        action: "edited_file",
        startTs: "2026-06-08T12:00:00.000Z",
        payload: { filePath: "/repo/src/agent-edit.ts", tool: "Edit" },
      }),
    ],
    { newId: makeSeededIdGen() },
  )[0]!;
  assert.deepEqual(episode.artifacts, ["/repo/src/agent-edit.ts"]);
});
