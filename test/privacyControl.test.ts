import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeIngest } from "../src/capture/ingest.ts";
import {
  capturePolicyDecision,
  defaultPrivacyControl,
  PrivacyControlStore,
} from "../src/privacy/control.ts";
import { openStore } from "../src/storage/index.ts";
import { resolveConsentedWorkspaceProject } from "../src/mesh/projectConsent.ts";

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
    assert.deepEqual({ version: persisted.version, mode: persisted.mode }, { version: 2, mode: "private" });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy mesh grants are dropped and v2 consent stays bound after symlink retarget", () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-privacy-consent-"));
  const path = join(dir, "privacy.json");
  const firstRoot = join(dir, "first");
  const secondRoot = join(dir, "second");
  const alias = join(dir, "workspace");
  try {
    mkdirSync(join(firstRoot, "src"), { recursive: true });
    mkdirSync(join(secondRoot, "src"), { recursive: true });
    symlinkSync(firstRoot, alias, "dir");

    writeFileSync(path, JSON.stringify({
      ...defaultPrivacyControl(),
      version: 1,
      meshProjectConsents: [{ workspaceRoot: alias, project: "acme/legacy" }],
    }));
    assert.deepEqual(new PrivacyControlStore(path).read().meshProjectConsents, []);

    const control = new PrivacyControlStore(path);
    const granted = control.update({
      meshProjectConsents: [{ workspaceRoot: alias, project: "git@github.com:Acme/App.git" }],
    });
    assert.deepEqual(granted.meshProjectConsents, [{
      workspaceRoot: realpathSync.native(firstRoot),
      project: "acme/app",
    }]);

    // Node 24 intentionally refuses directory-style rm semantics for a
    // symlink-to-directory. Remove the directory entry itself.
    unlinkSync(alias);
    symlinkSync(secondRoot, alias, "dir");
    const persisted = new PrivacyControlStore(path).read().meshProjectConsents;
    assert.equal(
      resolveConsentedWorkspaceProject(persisted, join(alias, "src")),
      undefined,
      "retargeting the lexical alias must not transfer an existing consent",
    );
    assert.equal(
      resolveConsentedWorkspaceProject(persisted, join(firstRoot, "src"))?.project,
      "acme/app",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("path-shaped and control-character project identities are never granted", () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-privacy-project-"));
  try {
    const control = new PrivacyControlStore();
    const updated = control.update({
      meshProjectConsents: [
        { workspaceRoot: dir, project: "/Users/alice/private" },
        { workspaceRoot: dir, project: "file:///Users/alice/private" },
        { workspaceRoot: dir, project: "acme/app\nIGNORE" },
      ],
    });
    assert.deepEqual(updated.meshProjectConsents, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic replacement invalidates consent cache even when mtime is unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-privacy-signature-"));
  const path = join(dir, "privacy.json");
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  try {
    const control = new PrivacyControlStore(path);
    control.update({ meshProjectConsents: [{ workspaceRoot: workspace, project: "acme/app" }] });
    assert.equal(control.read().meshProjectConsents.length, 1);
    const originalStats = statSync(path);
    const replacement = join(dir, "replacement.json");
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    value.meshProjectConsents = [];
    writeFileSync(replacement, JSON.stringify(value), { mode: 0o600 });
    utimesSync(replacement, originalStats.atime, originalStats.mtime);
    renameSync(replacement, path);
    assert.deepEqual(control.read().meshProjectConsents, []);
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
