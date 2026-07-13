import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
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
import { TerminalSource } from "../src/capture/sources/terminal.ts";
import { openStore, type Store } from "../src/storage/index.ts";

function commandLine(cmd: string, ts = "2026-07-13T22:00:00.000Z"): string {
  return JSON.stringify({
    ts,
    cmd,
    cwd: "/repo",
    exitCode: 0,
    durationMs: 12,
  });
}

async function waitForCount(store: Store, expected: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = store.events.count();
    if (count > expected) assert.fail(`expected at most ${expected} events, observed ${count}`);
    if (count === expected) {
      await delay(40);
      assert.equal(store.events.count(), expected);
      return;
    }
    await delay(10);
  }
  assert.fail(`timed out waiting for ${expected} events; observed ${store.events.count()}`);
}

test("terminal privacy baselines blocked bytes without replay and redacts allowed secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-terminal-private-"));
  const path = join(dir, "cmdlog.ndjson");
  writeFileSync(path, "");
  const store = openStore({ memory: true });
  let allowed = false;
  let revision = "privacy-1";
  const source = new TerminalSource({
    logPath: path,
    pollMs: 10,
    canAcquire: () => allowed,
    acquisitionRevision: () => revision,
  });
  const blocked = "BLOCKED_COMMAND_MUST_NOT_REPLAY";
  const secret = "sk-terminalsecret0123456789";

  try {
    source.start(makeIngest(store).ingest);
    appendFileSync(path, `${commandLine(`echo ${blocked}`)}\n`);
    await delay(80);
    assert.equal(store.events.count(), 0);

    // Even if a private -> normal transition happened entirely between file
    // notifications, its revision forces a fresh metadata baseline.
    allowed = true;
    revision = "privacy-2";
    await delay(40);
    appendFileSync(
      path,
      `${commandLine("pnpm test", "2026-07-13T22:00:01.000Z")}\n`,
    );
    await waitForCount(store, 1);

    appendFileSync(
      path,
      `${commandLine(
        `curl -H 'Bearer ${secret}' https://example.test`,
        "2026-07-13T22:00:02.000Z",
      )}\n`,
    );
    await waitForCount(store, 2);
    const events = store.events.range();
    assert.equal(events[0]?.payload.cmd, "pnpm test");
    assert.equal(events[1]?.payload.cmd, "[redacted sensitive content]");
    assert.equal(events[1]?.payload.contentRedacted, true);
    const persisted = JSON.stringify(events);
    assert.doesNotMatch(persisted, new RegExp(blocked));
    assert.doesNotMatch(persisted, new RegExp(secret));
  } finally {
    source.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal rejects symlinked command logs before acquisition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-terminal-symlink-"));
  const root = join(dir, "root");
  mkdirSync(root);
  const target = join(dir, "outside.ndjson");
  const path = join(root, "cmdlog.ndjson");
  writeFileSync(target, `${commandLine("SYMLINK_COMMAND_MUST_NOT_BE_READ")}\n`);
  symlinkSync(target, path);
  const store = openStore({ memory: true });
  let preflights = 0;
  const source = new TerminalSource({
    logPath: path,
    pollMs: 10,
    canAcquire: () => {
      preflights++;
      return true;
    },
  });

  try {
    source.start(makeIngest(store).ingest);
    await delay(80);
    assert.equal(preflights, 0);
    assert.equal(store.events.count(), 0);
  } finally {
    source.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal skips oversized sparse backlogs and captures only later appends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-terminal-backlog-"));
  const path = join(dir, "cmdlog.ndjson");
  writeFileSync(path, "");
  const store = openStore({ memory: true });
  const source = new TerminalSource({ logPath: path, pollMs: 10 });

  try {
    source.start(makeIngest(store).ingest);
    appendFileSync(path, `${commandLine("OVERSIZED_COMMAND_MUST_NOT_REPLAY")}\n`);
    truncateSync(path, 6 * 1024 * 1024);
    await delay(80);
    assert.equal(store.events.count(), 0);

    appendFileSync(
      path,
      `${commandLine("visible after baseline", "2026-07-13T22:00:03.000Z")}\n`,
    );
    await waitForCount(store, 1);
    const [event] = store.events.range();
    assert.equal(event?.payload.cmd, "visible after baseline");
    assert.doesNotMatch(JSON.stringify(event), /OVERSIZED_COMMAND_MUST_NOT_REPLAY/);
  } finally {
    source.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
