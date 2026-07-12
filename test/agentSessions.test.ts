import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { makeIngest } from "../src/capture/ingest.ts";
import {
  AgentSessionsSource,
  transcriptLineToInputs,
} from "../src/capture/sources/agentSessions.ts";
import { openStore, type Store } from "../src/storage/index.ts";

const SESSION_ID = "3f9c2b1e-8d4a-4c6f-9e21-7ab5c0d4e812";
const SECRET_MARKER = "SECRET_EDIT_BODY_DO_NOT_LEAK";

interface FixtureRecord {
  type?: string;
  message?: { content?: unknown };
}

function fixtureLines(): string[] {
  return readFileSync(
    new URL("./fixtures/agent-session.jsonl", import.meta.url),
    "utf8",
  )
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

function isThinkingOnly(record: FixtureRecord): boolean {
  const content = record.message?.content;
  return (
    record.type === "assistant" &&
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => {
      if (typeof block !== "object" || block === null) return false;
      return (block as Record<string, unknown>).type === "thinking";
    })
  );
}

function assertStringsAreBounded(value: unknown, location = "payload"): void {
  if (typeof value === "string") {
    assert.ok(
      value.length <= 220,
      `${location} contains a ${value.length}-character string`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertStringsAreBounded(item, `${location}[${index}]`),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    assertStringsAreBounded(child, `${location}.${key}`);
  }
}

async function waitForStableCount(
  store: Store,
  expected: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = store.events.range().length;
    if (count > expected) {
      assert.fail(`expected at most ${expected} events, observed ${count}`);
    }
    if (count === expected) {
      await delay(75);
      assert.equal(
        store.events.range().length,
        expected,
        "event count did not remain stable",
      );
      return;
    }
    await delay(25);
  }
  assert.fail(
    `timed out waiting for ${expected} events; observed ${store.events.range().length}`,
  );
}

test("parses a real transcript into privacy-safe raw event inputs", () => {
  const parsed = fixtureLines().map((line) => ({
    record: JSON.parse(line) as FixtureRecord,
    inputs: transcriptLineToInputs(line),
  }));

  let metaLines = 0;
  let thinkingLines = 0;
  for (const entry of parsed) {
    if (entry.record.type !== "user" && entry.record.type !== "assistant") {
      metaLines += 1;
      assert.deepEqual(entry.inputs, [], `${entry.record.type} must be skipped`);
    }
    if (isThinkingOnly(entry.record)) {
      thinkingLines += 1;
      assert.deepEqual(entry.inputs, [], "thinking content must be skipped");
    }
  }
  assert.ok(metaLines >= 2);
  assert.ok(thinkingLines >= 1);

  const prompt = parsed.find(
    ({ record }) =>
      record.type === "user" && typeof record.message?.content === "string",
  );
  assert.ok(prompt, "fixture must contain a string user prompt");
  assert.equal(prompt.inputs.length, 1);
  const promptInput = prompt.inputs[0]!;
  const promptPayload = promptInput.payload ?? {};
  assert.equal(promptInput.type, "ai_request");
  assert.equal(promptPayload.role, "user");
  const promptHash = promptPayload.textHash;
  assert.ok(typeof promptHash === "string");
  assert.match(promptHash, /^[0-9a-f]{64}$/);
  const promptPreview = promptPayload.preview;
  assert.ok(typeof promptPreview === "string");
  assert.ok(promptPreview.length <= 200);

  const inputs = parsed.flatMap((entry) => entry.inputs);
  const edit = inputs.find((input) => input.payload?.tool === "Edit");
  assert.ok(edit, "fixture must produce an Edit tool event");
  assert.equal(edit.payload?.filePath, "src/routes/index.ts");

  const bash = inputs.find(
    (input) =>
      input.payload?.tool === "Bash" &&
      typeof input.payload.command === "string" &&
      input.payload.command.includes("ls src/routes"),
  );
  assert.ok(bash, "fixture must produce the route-listing Bash event");
  assert.match(bash.payload?.command as string, /ls src\/routes/);

  assert.equal(inputs.length, 13);
  for (const input of inputs) {
    assert.equal(input.source, "ai_proxy");
    assert.equal(input.payload?.sessionKey, SESSION_ID);
    const encoded = JSON.stringify(input.payload);
    assert.doesNotMatch(encoded, new RegExp(SECRET_MARKER));
    assertStringsAreBounded(input.payload);
  }
});

test("tails new and growing jsonl files", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "praxis-agent-sessions-"));
  const store = openStore({ memory: true });
  const sink = makeIngest(store).ingest;
  const source = new AgentSessionsSource({ dirs: [tempDir], pollMs: 25 });

  try {
    source.start(sink);

    const lines = fixtureLines();
    const finalLine = lines.at(-1);
    assert.ok(finalLine, "fixture must have a final assistant line");
    const finalRecord = JSON.parse(finalLine) as FixtureRecord;
    assert.equal(finalRecord.type, "assistant");

    const precedingLines = lines.slice(0, -1);
    const expectedBefore = precedingLines.reduce(
      (count, line) => count + transcriptLineToInputs(line).length,
      0,
    );
    const expectedFinal = transcriptLineToInputs(finalLine).length;
    assert.equal(expectedFinal, 1);

    const projectDir = join(tempDir, "proj");
    mkdirSync(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${SESSION_ID}.jsonl`);
    writeFileSync(transcriptPath, `${precedingLines.join("\n")}\n`);

    await waitForStableCount(store, expectedBefore);

    appendFileSync(transcriptPath, `${finalLine}\n`);
    await waitForStableCount(store, expectedBefore + expectedFinal);

    const events = store.events.range();
    assert.ok(events.length > 0);
    for (const event of events) {
      assert.equal(event.source, "ai_proxy");
      assert.equal(event.payload.sessionKey, SESSION_ID);
    }

    source.stop();
    const missing = new AgentSessionsSource({
      dirs: ["/nonexistent/nope"],
      pollMs: 25,
    });
    assert.doesNotThrow(() => missing.start(sink));
    missing.stop();
  } finally {
    source.stop();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
