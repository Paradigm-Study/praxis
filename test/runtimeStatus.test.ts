import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { RuntimeStatusStore } from "../src/capture/runtimeStatus.ts";

test("RuntimeStatusStore serializes cross-process read-merge-write updates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-runtime-status-lock-"));
  const runtimePath = join(dir, "runtime.json");
  const lockPath = `${runtimePath}.lock`;
  const readyPath = join(dir, "writer-ready");
  const runtime = new RuntimeStatusStore(runtimePath);
  runtime.write({ state: "starting", activeSources: [] });

  // Hold the exact lock used by RuntimeStatusStore as if Studio were inside
  // its critical section. The capture writer must not read until this update
  // is completely published.
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
    pid: process.pid,
    token: "studio-test-owner",
    createdAt: new Date().toISOString(),
  }));

  const moduleUrl = new URL("../src/capture/runtimeStatus.ts", import.meta.url).href;
  const childScript = `
    import { writeFileSync } from "node:fs";
    import { RuntimeStatusStore } from ${JSON.stringify(moduleUrl)};
    writeFileSync(${JSON.stringify(readyPath)}, "ready");
    new RuntimeStatusStore(${JSON.stringify(runtimePath)}).write({
      state: "running",
      pid: process.pid,
      activeSources: ["native-stdin"]
    });
  `;
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--input-type=module",
    "--eval",
    childScript,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

  try {
    for (let attempt = 0; attempt < 100 && !existsSync(readyPath); attempt += 1) {
      await delay(10);
    }
    assert.ok(existsSync(readyPath), "capture writer reached RuntimeStatusStore.write");
    await delay(100);
    assert.equal(child.exitCode, null, "capture writer waits while Studio owns the lock");

    const studioSnapshot = JSON.parse(readFileSync(runtimePath, "utf8")) as Record<string, unknown>;
    writeFileSync(runtimePath, `${JSON.stringify({
      ...studioSnapshot,
      resources: {
        powerSource: "battery",
        suspended: true,
        batteryAware: true,
        updatedAt: "2026-07-13T22:00:00.000Z",
      },
      interpretation: {
        requested: "anthropic",
        active: "model",
        status: "ready",
      },
      updatedAt: "2026-07-13T22:00:00.000Z",
    }, null, 2)}\n`);
    rmSync(lockPath, { recursive: true, force: true });

    const result = await exit;
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, stderr);

    const merged = runtime.read();
    assert.equal(merged.state, "running");
    assert.deepEqual(merged.activeSources, ["native-stdin"]);
    assert.equal(merged.resources.powerSource, "battery");
    assert.equal(merged.resources.suspended, true);
    assert.equal(merged.interpretation?.status, "ready");
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeStatusStore reclaims a lock whose owner process exited", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-runtime-status-stale-lock-"));
  const runtimePath = join(dir, "runtime.json");
  const lockPath = `${runtimePath}.lock`;
  mkdirSync(dirname(runtimePath), { recursive: true });

  const owner = spawn(process.execPath, ["--eval", "process.exit(0)"], {
    stdio: "ignore",
  });
  const ownerPid = owner.pid;
  await new Promise<void>((resolveExit, reject) => {
    owner.once("error", reject);
    owner.once("exit", () => resolveExit());
  });
  assert.ok(ownerPid);

  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
    pid: ownerPid,
    token: "abandoned-test-owner",
    createdAt: new Date().toISOString(),
  }));

  try {
    const status = new RuntimeStatusStore(runtimePath).write({
      state: "running",
      activeSources: ["native-stdin"],
    });
    assert.equal(status.state, "running");
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
