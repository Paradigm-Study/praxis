import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchLogPath,
  errorFingerprint,
  maybeDispatch,
  normalizeErrorText,
  type DispatchContext,
  type ErrorDispatchRecord,
} from "../src/agent/dispatch.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import type { Observation, RawEvent } from "../src/core/types.ts";
import type { Store } from "../src/storage/index.ts";
import type { Decision } from "../src/agent/policy.ts";
import { action, freshStore } from "./helpers.ts";

// Each test gets its own PRAXIS_DATA_DIR so dispatches.ndjson is isolated and
// the repo's real data/ directory is never touched.
beforeEach(() => {
  process.env.PRAXIS_DATA_DIR = mkdtempSync(join(tmpdir(), "praxis-dispatch-"));
  delete process.env.PRAXIS_DISPATCH_SPAWN;
  delete process.env.BOARDROOM_URL;
});

function obs(): Observation {
  return {
    id: "obs_1",
    bundleId: "bundle_1",
    acceptedOptions: [],
    rejectedOptions: [],
    uncertainty: [],
    evidence: [],
    model: "mock",
    createdTs: new Date().toISOString(),
  };
}

function decision(partial: Partial<Decision> = {}): Decision {
  return {
    kind: "dispatch",
    reason: "recurring error observed",
    observationId: "obs_1",
    ...partial,
  };
}

function ctx(store: Store, partial: Partial<DispatchContext> = {}): DispatchContext {
  return {
    store,
    decision: decision(),
    observation: obs(),
    decisionId: "decision_test",
    newId: makeSeededIdGen(),
    ...partial,
  };
}

/** Seed a recent, high-confidence encountered_error action. */
function seedError(store: Store, errorText: string, agoMs = 30_000): string {
  const ts = new Date(Date.now() - agoMs).toISOString();
  const a = action({
    id: `act_err_${errorText.length}_${agoMs}`,
    action: "encountered_error",
    app: "iTerm2",
    startTs: ts,
    text: errorText.split("\n")[0],
    confidence: 0.78,
    payload: { errorText },
  });
  store.actions.put(a);
  return a.id;
}

function logLines(): ErrorDispatchRecord[] {
  const file = dispatchLogPath();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ErrorDispatchRecord);
}

test("fingerprint is stable across path, line-number, and hex variance", () => {
  const a = errorFingerprint(
    "Error: ENOENT open /Users/alice/proj/src/foo.ts at read (src/foo.ts:12:5) addr 0x7f3a2b",
  );
  const b = errorFingerprint(
    "Error: ENOENT open /home/bob/elsewhere/src/foo.ts at read (src/foo.ts:99:1) addr 0xdeadbeef",
  );
  assert.equal(a, b, "same failure, different machine/line/address");
  const c = errorFingerprint("TypeError: x is not a function");
  assert.notEqual(a, c, "different failures fingerprint differently");
});

test("normalizeErrorText collapses volatile tokens", () => {
  const norm = normalizeErrorText(
    'File "/Users/alice/app.py", line 31: crash at 0xABC123',
  );
  assert.ok(!norm.includes("alice"), "paths are stripped");
  assert.ok(!norm.includes("31"), "line numbers are stripped");
  assert.ok(!/0x[0-9a-f]/i.test(norm), "hex addresses are stripped");
});

test("dispatches a high-confidence error as a dry-run record with composed argv", async () => {
  const store = freshStore();
  const id = seedError(store, "Error: boom\n    at run (src/foo.ts:12:5)");
  const rec = (await maybeDispatch(
    ctx(store, { decision: decision({ evidence: [id] }) }),
  )) as ErrorDispatchRecord | undefined;
  assert.ok(rec, "a record is returned");
  assert.equal(rec.mode, "dry_run", "spawn flag unset => dry run");
  assert.equal(rec.status, "planned");
  assert.equal(rec.v, 0);
  assert.ok(rec.id.startsWith("dispatch_"));
  assert.ok(rec.task.length <= 500);
  assert.match(rec.task, /boom/);
  assert.equal(rec.fingerprint, errorFingerprint("Error: boom\n    at run (src/foo.ts:12:5)"));
  assert.deepEqual(rec.evidence, [id]);
  // argv composition: claude -p '<brief>' carrying the redacted error text
  assert.ok(rec.command, "command composed even in dry run");
  assert.equal(rec.command!.length, 3);
  assert.equal(rec.command![0], "claude");
  assert.equal(rec.command![1], "-p");
  assert.match(rec.command![2]!, /boom/);
  assert.match(rec.command![2]!, /Do not commit or push/);
  // persisted to the ndjson log
  const lines = logLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.fingerprint, rec.fingerprint);
  assert.equal(statSync(dispatchLogPath()).mode & 0o777, 0o600);
  store.close();
});

test("a missing dispatch executable fails open instead of crashing the agent", async () => {
  const store = freshStore();
  seedError(store, "Error: spawn target missing badly");
  process.env.PRAXIS_DISPATCH_SPAWN = "1";
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const record = (await maybeDispatch(ctx(store))) as ErrorDispatchRecord;
    assert.ok(record);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const persisted = logLines()[0]!;
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.resultSummary, "spawn failed");
  } finally {
    process.env.PATH = previousPath;
    store.close();
  }
});

test("dedup: the same error re-observed with different paths/lines is suppressed", async () => {
  const store = freshStore();
  seedError(store, "Error: boom\n    at run (/Users/alice/proj/src/foo.ts:12:5)");
  const first = await maybeDispatch(ctx(store));
  assert.ok(first, "first occurrence dispatches");

  const store2 = freshStore();
  seedError(store2, "Error: boom\n    at run (/tmp/ci/checkout/src/foo.ts:88:2)");
  const second = await maybeDispatch(ctx(store2));
  assert.equal(second, undefined, "same fingerprint is deduped");
  assert.equal(logLines().length, 1, "log still holds one record");
  store.close();
  store2.close();
});

test("budget: at most 3 dispatches per day", async () => {
  const texts = [
    "Error: alpha exploded badly",
    "TypeError: beta is not a function",
    "Exception: gamma timed out waiting",
    "Error: delta refused the connection",
  ];
  for (let i = 0; i < 3; i++) {
    const store = freshStore();
    seedError(store, texts[i]!);
    const rec = await maybeDispatch(ctx(store));
    assert.ok(rec, `dispatch ${i + 1} of 3 goes out`);
    store.close();
  }
  const store = freshStore();
  seedError(store, texts[3]!);
  const rec = await maybeDispatch(ctx(store));
  assert.equal(rec, undefined, "4th dispatch of the day is suppressed");
  assert.equal(logLines().length, 3);
  store.close();
});

test("stand-down: a recent edited_file on an implicated path suppresses dispatch", async () => {
  const store = freshStore();
  seedError(store, "Error: boom\n    at run (src/firehose.ts:12:5)");
  store.actions.put(
    action({
      id: "act_edit_1",
      action: "edited_file",
      app: "Cursor",
      startTs: new Date(Date.now() - 60_000).toISOString(),
      payload: { path: "src/firehose.ts" },
    }),
  );
  const rec = await maybeDispatch(ctx(store));
  assert.equal(rec, undefined, "the human is already on it");
  assert.equal(logLines().length, 0, "nothing recorded");
  store.close();
});

test("an old edit on the implicated path does NOT stand down", async () => {
  const store = freshStore();
  seedError(store, "Error: boom\n    at run (src/firehose.ts:12:5)");
  store.actions.put(
    action({
      id: "act_edit_old",
      action: "edited_file",
      app: "Cursor",
      startTs: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      payload: { path: "src/firehose.ts" },
    }),
  );
  const rec = await maybeDispatch(ctx(store));
  assert.ok(rec, "a 2h-old edit is not 'already on it'");
  store.close();
});

test("no qualifying error action and no decision.task => nothing dispatched", async () => {
  const store = freshStore();
  // a LOW-confidence error must not trigger
  const ts = new Date().toISOString();
  store.actions.put(
    action({
      id: "act_weak",
      action: "encountered_error",
      startTs: ts,
      confidence: 0.45,
      payload: { errorText: "Error: maybe nothing" },
    }),
  );
  const rec = await maybeDispatch(ctx(store));
  assert.equal(rec, undefined);
  assert.equal(logLines().length, 0);
  store.close();
});

test("falls back to decision.task when no encountered_error action exists", async () => {
  const store = freshStore();
  const rec = await maybeDispatch(
    ctx(store, { decision: decision({ task: "Investigate flaky relay test failure" }) }),
  );
  assert.ok(rec);
  assert.match(rec!.task, /flaky relay/);
  store.close();
});

test("record carries last-10 repro actions (id+action+app only) and a repo guess", async () => {
  const store = freshStore();
  const base = Date.now() - 10 * 60_000;
  for (let i = 0; i < 12; i++) {
    store.actions.put(
      action({
        id: `act_${String(i).padStart(2, "0")}`,
        action: "ran_command",
        app: "iTerm2",
        startTs: new Date(base + i * 1000).toISOString(),
        payload: { cmd: `step ${i}`, secret: "must not serialize" },
      }),
    );
  }
  seedError(store, "Error: omega failed hard\n    at boot (src/main.ts:1:1)", 1000);
  const gitEvent: RawEvent = {
    id: "event_git_1",
    ts: new Date(base).toISOString(),
    source: "git",
    app: "git",
    window: "git",
    type: "commit",
    payload: { repo: "https://github.com/acme/widget" },
    blobRefs: [],
    hash: "hash_git_1",
  };
  store.events.append(gitEvent);

  const rec = (await maybeDispatch(ctx(store))) as ErrorDispatchRecord | undefined;
  assert.ok(rec);
  assert.equal(rec.reproActions.length, 10, "capped at last 10");
  for (const r of rec.reproActions) {
    assert.deepEqual(
      Object.keys(r).sort(),
      ["action", "app", "id"],
      "id+action+app ONLY — no payloads leak into the record",
    );
  }
  assert.equal(rec.repoGuess, "https://github.com/acme/widget");
  store.close();
});
