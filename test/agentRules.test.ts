import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { makeIngest } from "../src/capture/ingest.ts";
import { transcriptLineToInputs } from "../src/capture/sources/agentSessions.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import {
  reconstruct,
  reconstructEvents,
} from "../src/reconstructor/reconstructor.ts";
import { freshStore } from "./helpers.ts";

const SESSION_ID = "3f9c2b1e-8d4a-4c6f-9e21-7ab5c0d4e812";

function fixtureLines(): string[] {
  return readFileSync(
    new URL("./fixtures/agent-session.jsonl", import.meta.url),
    "utf8",
  )
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

test("reconstructs agent tools and transcript completion", () => {
  const store = freshStore();
  try {
    const ingest = makeIngest(store).ingest;
    for (const line of fixtureLines()) {
      for (const input of transcriptLineToInputs(line)) ingest(input);
    }

    const actions = reconstruct(store, { newId: makeSeededIdGen() });
    const edited = actions.filter((action) => action.action === "edited_file");
    assert.equal(edited.length, 3);
    assert.ok(
      edited.some((action) => action.text === "src/routes/index.ts"),
      "expected the route-index edit",
    );
    for (const action of edited) {
      assert.deepEqual(action.reconstructedBy, ["agent.agentEditedFile"]);
      assert.ok(
        action.confidence >= 0.9,
        `expected corroborated edit confidence, got ${action.confidence}`,
      );
    }

    const commands = actions.filter((action) => action.action === "ran_command");
    assert.equal(commands.length, 2);
    for (const command of commands) {
      assert.deepEqual(command.reconstructedBy, ["agent.agentRanCommand"]);
      assert.equal(command.payload?.sessionKey, SESSION_ID);
    }
    assert.ok(
      commands.some((action) => action.text?.includes("ls src/routes")),
      "expected the route-listing command",
    );
    assert.ok(
      commands.some((action) => action.text?.includes("npx vitest run")),
      "expected the test command",
    );

    const completions = actions.filter(
      (action) => action.action === "received_response",
    );
    assert.equal(completions.length, 1);
    const completion = completions[0]!;
    assert.deepEqual(completion.reconstructedBy, ["agent.agentCompletedTask"]);
    assert.match(completion.text ?? "", /Added the \/health endpoint/);
    assert.ok(completion.uncertainty && completion.uncertainty.length > 0);

    const eventIds = new Set(store.events.range().map((event) => event.id));
    for (const action of [...edited, ...commands, completion]) {
      assert.ok(action.evidence.length > 0);
      for (const evidenceId of action.evidence) {
        assert.ok(
          eventIds.has(evidenceId),
          `${action.action} refers to missing evidence ${evidenceId}`,
        );
      }
    }

    const events = store.events.range();
    const firstIds = reconstructEvents(events).map((action) => action.id);
    const secondIds = reconstructEvents(events).map((action) => action.id);
    assert.deepEqual(secondIds, firstIds);
  } finally {
    store.close();
  }
});
