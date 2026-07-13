import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeIngest } from "../src/capture/ingest.ts";
import {
  capturePolicyDecision,
  defaultPrivacyControl,
  PrivacyControlStore,
} from "../src/privacy/control.ts";
import { openStore } from "../src/storage/index.ts";

const input = {
  source: "clipboard" as const,
  app: "Editor",
  window: "notes",
  type: "clipboard_changed",
  payload: { text: "hello" },
};

test("privacy defaults exclude sensitive apps, windows, and paths", () => {
  const policy = defaultPrivacyControl("2026-07-12T00:00:00.000Z");
  assert.equal(capturePolicyDecision(policy, { ...input, app: "1Password" }).reason, "excluded_app");
  assert.equal(capturePolicyDecision(policy, { ...input, window: "Private Browsing" }).reason, "excluded_window");
  assert.equal(capturePolicyDecision(policy, {
    ...input,
    source: "filesystem",
    payload: { path: "config/.env.local" },
  }).reason, "excluded_path");
  assert.equal(capturePolicyDecision(policy, input).allowed, true);
});

test("private, timed pause, and per-source controls are enforced", () => {
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  assert.equal(capturePolicyDecision({ ...defaultPrivacyControl(), mode: "private" }, input, now).reason, "private");
  assert.equal(capturePolicyDecision({
    ...defaultPrivacyControl(),
    mode: "paused",
    pausedUntil: "2026-07-12T12:05:00.000Z",
  }, input, now).reason, "paused");
  assert.equal(capturePolicyDecision({
    ...defaultPrivacyControl(),
    mode: "paused",
    pausedUntil: "2026-07-12T11:59:00.000Z",
  }, input, now).allowed, true, "an expired pause resumes capture");
  const disabled = defaultPrivacyControl();
  disabled.sources.clipboard = false;
  assert.equal(capturePolicyDecision(disabled, input).reason, "source_disabled");
});

test("final ingest gate never persists blocked inline content or blobs", () => {
  const store = openStore({ memory: true });
  const privacy = new PrivacyControlStore(undefined, {
    ...defaultPrivacyControl(),
    mode: "private",
  });
  const ingest = makeIngest(store, { privacy });
  const returned = ingest.ingest({
    ...input,
    blobs: [{ kind: "text", data: "must not reach disk" }],
  });
  assert.match(returned.id, /^suppressed_/);
  assert.equal(store.events.count(), 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number }).n, 0);
  store.close();
});

test("clipboard and accessibility secrets are redacted before payload or blob persistence", () => {
  const store = openStore({ memory: true });
  try {
    const ingest = makeIngest(store);
    const clipboard = ingest.ingest({
      ...input,
      payload: { text: "api_key=sk-supersecretvalue1234567890" },
      blobs: [{ kind: "text", data: "Bearer abcdefghijklmnopqrstuvwxyz012345" }],
    });
    assert.deepEqual(clipboard.payload, {
      text: "[redacted sensitive content]",
      contentRedacted: true,
    });
    assert.equal(store.blobs.getText(clipboard.blobRefs[0]!), "[redacted sensitive content]");

    const accessibility = ingest.ingest({
      source: "accessibility",
      app: "Editor",
      window: "Login",
      type: "focused_text_changed",
      payload: { password: "short-but-sensitive", title: "Sign in" },
    });
    assert.deepEqual(accessibility.payload, {
      password: "[redacted sensitive content]",
      title: "Sign in",
      contentRedacted: true,
    });
    const persisted = JSON.stringify(store.events.range());
    assert.equal(persisted.includes("supersecret"), false);
    assert.equal(persisted.includes("short-but-sensitive"), false);
  } finally {
    store.close();
  }
});

test("privacy control writes atomically with owner-only permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-privacy-"));
  const path = join(dir, "nested", "privacy.json");
  try {
    const control = new PrivacyControlStore(path);
    control.update({ mode: "private", cloudObserverConsent: true, screenshotConsent: true });
    const persisted = JSON.parse(readFileSync(path, "utf8")) as { version: number; mode: string };
    assert.deepEqual({ version: persisted.version, mode: persisted.mode }, { version: 1, mode: "private" });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing or malformed privacy control fails closed instead of using a permissive cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-privacy-corrupt-"));
  const path = join(dir, "privacy.json");
  try {
    const control = new PrivacyControlStore(path);
    control.update({ cloudObserverConsent: true, screenshotConsent: true, meshProjects: ["all"] });
    writeFileSync(path, "{broken", "utf8");
    const safe = control.read();
    assert.equal(safe.cloudObserverConsent, false);
    assert.equal(safe.screenshotConsent, false);
    assert.deepEqual(safe.meshProjects, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
