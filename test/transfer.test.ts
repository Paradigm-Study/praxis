import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlaybook, critique } from "../src/transfer/transfer.ts";
import { fullPipeline, action } from "./helpers.ts";

test("playbook distills the learned graph", async () => {
  const { store } = await fullPipeline();
  const pb = buildPlaybook(store);
  assert.ok(pb.workflow.length >= 3);
  assert.equal(pb.workflow[0], "consult AI");
  assert.ok(pb.decisionRules.some((r) => /evidence-backed/.test(r.text)));
  assert.ok(pb.knowHow.length >= 1);
});

test("critique flags committing without running tests", async () => {
  const { store } = await fullPipeline();
  const pb = buildPlaybook(store);
  const advisories = critique(pb, [
    action({ action: "edited_file", startTs: "2026-06-10T10:00:00.000Z" }),
    action({ action: "committed", startTs: "2026-06-10T10:01:00.000Z", text: "wip" }),
  ]);
  assert.ok(advisories.some((a) => /tests before committing/i.test(a)));
});

test("critique is quiet when the learner follows the workflow", async () => {
  const { store } = await fullPipeline();
  const pb = buildPlaybook(store);
  const advisories = critique(pb, [
    action({ action: "edited_file", startTs: "2026-06-10T10:00:00.000Z" }),
    action({ action: "ran_command", startTs: "2026-06-10T10:00:30.000Z", text: "npm test", payload: { exitCode: 0 } }),
    action({ action: "committed", startTs: "2026-06-10T10:01:00.000Z", text: "feat: x" }),
  ]);
  assert.ok(!advisories.some((a) => /tests before committing/i.test(a)));
});
