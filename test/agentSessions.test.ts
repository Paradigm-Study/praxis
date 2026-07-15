import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { makeIngest } from "../src/capture/ingest.ts";
import type { CaptureSourceStatus } from "../src/capture/source.ts";
import { sha256 } from "../src/core/hash.ts";
import {
  AgentSessionsSource,
  transcriptLineToInputs,
} from "../src/capture/sources/agentSessions.ts";
import {
  defaultPrivacyControl,
  PrivacyControlStore,
} from "../src/privacy/control.ts";
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

test("filters sidechains, metadata, compact summaries, and internal hook text", () => {
  const base = {
    type: "user",
    timestamp: "2026-07-13T19:00:00.000Z",
    sessionId: SESSION_ID,
    message: { role: "user", content: "internal generated prompt" },
  };
  for (const flag of ["isSidechain", "isMeta", "isCompactSummary"] as const) {
    assert.deepEqual(
      transcriptLineToInputs(JSON.stringify({ ...base, [flag]: true })),
      [],
      `${flag} records are not user actions`,
    );
  }
  assert.deepEqual(
    transcriptLineToInputs(JSON.stringify({
      ...base,
      message: {
        role: "user",
        content: "<system-reminder>Praxis injected memory</system-reminder>",
      },
    })),
    [],
  );
  const mixed = transcriptLineToInputs(JSON.stringify({
    ...base,
    message: {
      role: "user",
      content: "<system-reminder>internal context</system-reminder>\nBuild the release.",
    },
  }));
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0]?.payload?.preview, "Build the release.");
});

test("redacts secrets from transcript previews and commands before storage", () => {
  const secret = "sk-supersecret0123456789";
  const prompt = transcriptLineToInputs(JSON.stringify({
    type: "user",
    timestamp: "2026-07-13T19:00:00.000Z",
    sessionId: SESSION_ID,
    message: { role: "user", content: `API_KEY=${secret} deploy now` },
  }));
  assert.equal(prompt[0]?.payload?.preview, "[redacted sensitive content]");
  assert.equal(prompt[0]?.payload?.contentRedacted, true);
  assert.doesNotMatch(JSON.stringify(prompt), new RegExp(secret));

  const command = transcriptLineToInputs(JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-13T19:00:01.000Z",
    sessionId: SESSION_ID,
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "tool_secret",
        name: "Bash",
        input: { command: `PASSWORD=hunter2 curl -H 'Bearer ${secret}' example.test` },
      }],
    },
  }));
  assert.equal(command[0]?.payload?.command, "[redacted sensitive content]");
  assert.equal(command[0]?.payload?.preview, "[redacted sensitive content]");
  assert.doesNotMatch(JSON.stringify(command), new RegExp(secret));
});

test("tails new and growing jsonl files", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "praxis-agent-sessions-"));
  const store = openStore({ memory: true });
  const sink = makeIngest(store).ingest;
  const source = new AgentSessionsSource({ dirs: [tempDir], pollMs: 25 });
  const statuses: CaptureSourceStatus[] = [];

  try {
    source.start(sink, (status) => statuses.push(status));
    assert.deepEqual(statuses.at(-1), {
      channel: "agent_sessions",
      status: "ready",
    });

    const subagentDir = join(tempDir, "proj", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(join(subagentDir, "agent-noise.jsonl"), `${JSON.stringify({
      type: "user",
      sessionId: "subagent-noise",
      message: { role: "user", content: "internal subagent task" },
    })}\n`);
    await delay(100);
    assert.equal(store.events.count(), 0, "subagent transcripts are never tailed");

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
    const missingStatuses: CaptureSourceStatus[] = [];
    assert.doesNotThrow(() => missing.start(sink, (status) => missingStatuses.push(status)));
    assert.deepEqual(missingStatuses.at(-1), {
      channel: "agent_sessions",
      status: "unavailable",
      reason: "transcript-directory-missing",
    });
    missing.stop();
  } finally {
    source.stop();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("never follows transcript symlinks outside the configured root", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "praxis-agent-symlink-"));
  const root = join(tempDir, "root");
  const outside = join(tempDir, "outside.jsonl");
  mkdirSync(root);
  const store = openStore({ memory: true });
  let preflights = 0;
  const source = new AgentSessionsSource({
    dirs: [root],
    pollMs: 20,
    canAcquire: () => {
      preflights++;
      return true;
    },
  });
  const line = (content: string): string => JSON.stringify({
    type: "user",
    sessionId: "secure-file-session",
    message: { role: "user", content },
  });

  try {
    source.start(makeIngest(store).ingest);
    writeFileSync(outside, `${line("SYMLINK_TARGET_MUST_NOT_BE_READ")}\n`);
    symlinkSync(outside, join(root, "linked.jsonl"));
    await delay(120);
    assert.equal(store.events.count(), 0);
    assert.equal(preflights, 0, "a rejected symlink never reaches acquisition policy");

    writeFileSync(join(root, "visible.jsonl"), `${line("visible regular transcript")}\n`);
    await waitForStableCount(store, 1);
    const persisted = JSON.stringify(store.events.range());
    assert.match(persisted, /visible regular transcript/);
    assert.doesNotMatch(persisted, /SYMLINK_TARGET_MUST_NOT_BE_READ/);
  } finally {
    source.stop();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a configured transcript root replacement stays failed closed", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "praxis-agent-root-retarget-"));
  const root = join(tempDir, "root");
  const oldRoot = join(tempDir, "old-root");
  mkdirSync(root);
  const store = openStore({ memory: true });
  const statuses: CaptureSourceStatus[] = [];
  const source = new AgentSessionsSource({ dirs: [root], pollMs: 20 });
  const line = (content: string): string => JSON.stringify({
    type: "user",
    sessionId: "root-retarget-session",
    message: { role: "user", content },
  });

  try {
    source.start(makeIngest(store).ingest, (status) => statuses.push(status));
    writeFileSync(join(root, "session.jsonl"), `${line("before root replacement")}\n`);
    await waitForStableCount(store, 1);

    renameSync(root, oldRoot);
    mkdirSync(root);
    writeFileSync(
      join(root, "session.jsonl"),
      `${line("RETARGETED_ROOT_MUST_NOT_BE_AUTHORIZED")}\n`,
    );
    await delay(150);
    assert.equal(store.events.count(), 1);
    assert.doesNotMatch(
      JSON.stringify(store.events.range()),
      /RETARGETED_ROOT_MUST_NOT_BE_AUTHORIZED/,
    );
    assert.deepEqual(statuses.at(-1), {
      channel: "agent_sessions",
      status: "unavailable",
      reason: "transcript-root-changed",
    });
  } finally {
    source.stop();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("skips oversized transcript backlogs without replay and captures later appends", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "praxis-agent-backlog-"));
  const store = openStore({ memory: true });
  const source = new AgentSessionsSource({ dirs: [tempDir], pollMs: 20 });
  const transcriptPath = join(tempDir, "oversized-session.jsonl");
  const line = (content: string): string => JSON.stringify({
    type: "user",
    sessionId: "oversized-session",
    message: { role: "user", content },
  });

  try {
    source.start(makeIngest(store).ingest);
    writeFileSync(transcriptPath, `${line("OVERSIZED_HISTORY_MUST_NOT_REPLAY")}\n`);
    truncateSync(transcriptPath, 12 * 1024 * 1024);
    await delay(120);
    assert.equal(store.events.count(), 0);

    appendFileSync(transcriptPath, `${line("visible after oversized baseline")}\n`);
    await waitForStableCount(store, 1);
    const [event] = store.events.range();
    assert.equal(event?.payload.preview, "visible after oversized baseline");
    assert.doesNotMatch(JSON.stringify(event), /OVERSIZED_HISTORY_MUST_NOT_REPLAY/);
  } finally {
    source.stop();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("same-path transcript rotation restarts from the replacement inode", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "praxis-agent-rotation-"));
  const store = openStore({ memory: true });
  const source = new AgentSessionsSource({ dirs: [tempDir], pollMs: 20 });
  const transcriptPath = join(tempDir, "rotation-session.jsonl");
  const line = (content: string): string => JSON.stringify({
    type: "user",
    sessionId: "rotation-session",
    message: { role: "user", content },
  });

  try {
    source.start(makeIngest(store).ingest);
    writeFileSync(transcriptPath, `${line("rotation first")}\n`);
    await waitForStableCount(store, 1);

    const replacement = join(tempDir, "replacement.tmp");
    writeFileSync(replacement, `${line("rotation next!")}\n`);
    assert.equal(
      readFileSync(replacement).byteLength,
      readFileSync(transcriptPath).byteLength,
      "the regression requires a same-sized replacement",
    );
    renameSync(replacement, transcriptPath);
    await waitForStableCount(store, 2);
    assert.deepEqual(store.events.range().map((event) => event.payload.preview), [
      "rotation first",
      "rotation next!",
    ]);
  } finally {
    source.stop();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("streaming transcript reads preserve UTF-8 split across poll chunks", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "praxis-agent-utf8-"));
  const store = openStore({ memory: true });
  const source = new AgentSessionsSource({ dirs: [tempDir], pollMs: 20 });
  const transcriptPath = join(tempDir, "utf8-session.jsonl");
  const line = (content: string): string => JSON.stringify({
    type: "user",
    sessionId: "utf8-session",
    message: { role: "user", content },
  });
  const markerOffset = Buffer.from(line("好")).indexOf(Buffer.from("好"));
  const padding = (256 * 1024) - 1 - markerOffset;
  assert.ok(padding > 0);
  const content = `${"x".repeat(padding)}好 end`;
  const encoded = Buffer.from(`${line(content)}\n`);
  assert.equal(encoded.indexOf(Buffer.from("好")), (256 * 1024) - 1);

  try {
    source.start(makeIngest(store).ingest);
    writeFileSync(transcriptPath, encoded);
    await waitForStableCount(store, 1);
    const [event] = store.events.range();
    assert.equal(event?.payload.textHash, sha256(content));
  } finally {
    source.stop();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("privacy fence baselines blocked Claude transcript bytes without replay", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "praxis-agent-private-"));
  const store = openStore({ memory: true });
  const sink = makeIngest(store).ingest;
  let allowed = false;
  const source = new AgentSessionsSource({
    dirs: [tempDir],
    pollMs: 20,
    canAcquire: () => allowed,
  });
  const transcriptPath = join(tempDir, "privacy-session.jsonl");
  const blocked = JSON.stringify({
    type: "user",
    timestamp: "2026-07-13T19:00:00.000Z",
    sessionId: "privacy-session",
    message: { content: "BLOCKED_TRANSCRIPT_MUST_NOT_REPLAY" },
  });
  const visible = JSON.stringify({
    type: "user",
    timestamp: "2026-07-13T19:00:01.000Z",
    sessionId: "privacy-session",
    message: { content: "visible after explicit resume" },
  });

  try {
    source.start(sink);
    writeFileSync(transcriptPath, `${blocked}\n`);
    await delay(120);
    assert.equal(store.events.count(), 0, "blocked transcript was never ingested");

    allowed = true;
    appendFileSync(transcriptPath, `${visible}\n`);
    await waitForStableCount(store, 1);
    const [event] = store.events.range();
    assert.equal(event?.payload.preview, "visible after explicit resume");
    assert.doesNotMatch(JSON.stringify(event), /BLOCKED_TRANSCRIPT_MUST_NOT_REPLAY/);
  } finally {
    source.stop();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a policy-suppressed Claude Read quarantines its result and assistant quote", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "praxis-agent-excluded-tool-"));
  const store = openStore({ memory: true });
  const privacy = new PrivacyControlStore(undefined, {
    ...defaultPrivacyControl(),
    excludedPaths: ["/excluded"],
  });
  const source = new AgentSessionsSource({ dirs: [tempDir], pollMs: 20 });
  const transcriptPath = join(tempDir, "privacy-tool-session.jsonl");
  const record = (
    type: "user" | "assistant",
    timestamp: string,
    message: Record<string, unknown>,
  ): string => JSON.stringify({
    type,
    timestamp,
    sessionId: "privacy-tool-session",
    cwd: "/repo",
    message,
  });
  const secret = "DO_NOT_PERSIST_THIS_SECRET";
  const lines = [
    record("user", "2026-07-13T20:00:00.000Z", {
      role: "user",
      content: "Inspect the requested file.",
    }),
    record("assistant", "2026-07-13T20:00:01.000Z", {
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_public_read",
          name: "Read",
          input: { file_path: "/repo/README.md" },
        },
        {
          type: "tool_use",
          id: "toolu_private_read",
          name: "Read",
          input: { file_path: "/excluded/secret.txt" },
        },
      ],
    }),
    record("user", "2026-07-13T20:00:02.000Z", {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_public_read",
          content: "PUBLIC_MULTI_TOOL_RESULT_MUST_STAY_QUARANTINED",
        },
        {
          type: "tool_result",
          tool_use_id: "toolu_private_read",
          content: [{ type: "text", text: secret }],
        },
      ],
    }),
    record("assistant", "2026-07-13T20:00:03.000Z", {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: `The file says ${secret}.` }],
    }),
    record("user", "2026-07-13T20:00:04.000Z", {
      role: "user",
      content: "Now summarize the public README.",
    }),
    record("assistant", "2026-07-13T20:00:05.000Z", {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "The README is public." }],
    }),
  ];

  try {
    source.start(makeIngest(store, { privacy }).ingest);
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
    await waitForStableCount(store, 4);

    const events = store.events.range();
    assert.deepEqual(events.map((event) => event.payload.preview), [
      "Inspect the requested file.",
      undefined,
      "Now summarize the public README.",
      "The README is public.",
    ]);
    assert.equal(events[1]?.payload.toolUseId, "toolu_public_read");
    const persisted = JSON.stringify(events);
    assert.doesNotMatch(persisted, /toolu_private_read/);
    assert.doesNotMatch(persisted, /PUBLIC_MULTI_TOOL_RESULT_MUST_STAY_QUARANTINED/);
    assert.doesNotMatch(persisted, /\/excluded\/secret\.txt/);
    assert.doesNotMatch(persisted, new RegExp(secret));
  } finally {
    source.stop();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a suppressed human request quarantines its entire derived Claude turn", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "praxis-agent-excluded-request-"));
  const store = openStore({ memory: true });
  const privacy = new PrivacyControlStore(undefined, {
    ...defaultPrivacyControl(),
    excludedPaths: ["/excluded"],
  });
  const source = new AgentSessionsSource({ dirs: [tempDir], pollMs: 20 });
  const transcriptPath = join(tempDir, "privacy-request-session.jsonl");
  const secret = "PRIVATE_REQUEST_DERIVATION_MUST_NOT_PERSIST";
  const base = {
    sessionId: "privacy-request-session",
  };
  const lines = [
    JSON.stringify({
      ...base,
      type: "user",
      cwd: "/excluded",
      timestamp: "2026-07-13T21:00:00.000Z",
      message: { role: "user", content: `Explain ${secret}.` },
    }),
    JSON.stringify({
      ...base,
      type: "assistant",
      timestamp: "2026-07-13T21:00:01.000Z",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: `I will inspect ${secret}.` },
          {
            type: "tool_use",
            id: "toolu_derived_public_read",
            name: "Read",
            input: { file_path: "/repo/README.md" },
          },
        ],
      },
    }),
    JSON.stringify({
      ...base,
      type: "user",
      timestamp: "2026-07-13T21:00:02.000Z",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_derived_public_read",
          content: `Public result combined with ${secret}`,
        }],
      },
    }),
    JSON.stringify({
      ...base,
      type: "assistant",
      timestamp: "2026-07-13T21:00:03.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `Final answer: ${secret}` }],
      },
    }),
    JSON.stringify({
      ...base,
      type: "user",
      cwd: "/repo",
      timestamp: "2026-07-13T21:00:04.000Z",
      message: { role: "user", content: "Start a public task." },
    }),
    JSON.stringify({
      ...base,
      type: "assistant",
      timestamp: "2026-07-13T21:00:05.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Public task complete." }],
      },
    }),
  ];

  try {
    source.start(makeIngest(store, { privacy }).ingest);
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
    await waitForStableCount(store, 2);
    const events = store.events.range();
    assert.deepEqual(events.map((event) => event.payload.preview), [
      "Start a public task.",
      "Public task complete.",
    ]);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
  } finally {
    source.stop();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
