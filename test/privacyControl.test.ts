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
  assert.equal(capturePolicyDecision(policy, {
    ...input,
    source: "ai_proxy",
    payload: { cwd: "/repo", filePath: "/repo/.env.local" },
  }).reason, "excluded_path", "every path-shaped field is checked, not only the first one");
  assert.equal(capturePolicyDecision(policy, input).allowed, true);
});

test("git privacy resolves nested file payloads against the repository root", () => {
  const policy = {
    ...defaultPrivacyControl(),
    excludedPaths: ["/repo/private"],
  };
  const gitInput = {
    source: "git" as const,
    app: "git",
    window: "/repo",
    type: "commit",
  };

  assert.equal(capturePolicyDecision(policy, {
    ...gitInput,
    payload: {
      sha: "abc1234",
      changes: {
        files: [
          "src/public.ts",
          { metadata: { new_path: "private/secret.txt" } },
        ],
      },
    },
  }).reason, "excluded_path");
  assert.equal(capturePolicyDecision(policy, {
    ...gitInput,
    payload: { files: ["src/../private/secret.txt"] },
  }).reason, "excluded_path", "relative traversal is normalized against the repo");
  const sharedFiles = ["private/shared-secret.txt"];
  assert.equal(capturePolicyDecision(policy, {
    ...gitInput,
    payload: { metadata: sharedFiles, files: sharedFiles },
  }).reason, "excluded_path", "shared nested objects are rescanned in path context");
  assert.equal(capturePolicyDecision(policy, {
    ...gitInput,
    payload: { files: ["private-copy/visible.txt"] },
  }).allowed, true, "an absolute excluded subtree uses path boundaries");
});

test("git privacy inspects staged diff paths before any inline blob is persisted", () => {
  const policyValue = {
    ...defaultPrivacyControl(),
    excludedPaths: ["/repo/private"],
  };
  const staged = {
    source: "git" as const,
    app: "git",
    window: "/repo",
    type: "staged_changed",
    payload: { stat: "2 files changed, 2 insertions(+)" },
  };
  const privateDiffs: Array<string | Uint8Array> = [
    " src/public.ts | 1 +\n private/secret.txt | 1 +\n 2 files changed, 2 insertions(+)",
    Buffer.from("diff --git a/src/public.ts b/private/secret file.txt\n--- a/src/public.ts\n+++ b/private/secret file.txt\n"),
    " src/{public.ts => ../private/renamed.ts} | 0",
    " private/secret.png | Bin 0 -> 12 bytes",
    "Binary files a/src/public.png and b/private/secret.png differ",
  ];
  for (const diff of privateDiffs) {
    assert.equal(capturePolicyDecision(policyValue, {
      ...staged,
      blobs: [{ kind: "diff" as const, data: diff }],
    }).reason, "excluded_path");
  }
  assert.equal(capturePolicyDecision(policyValue, {
    ...staged,
    blobs: [{ kind: "diff", data: " src/public.ts | 1 +" }],
  }).allowed, true);

  const store = openStore({ memory: true });
  try {
    const privacy = new PrivacyControlStore(undefined, policyValue);
    const returned = makeIngest(store, { privacy }).ingest({
      ...staged,
      blobs: [{
        kind: "diff",
        data: [
          "diff --git a/private/secret.txt b/private/secret.txt",
          "+++ b/private/secret.txt",
          "+api_key=sk-private0123456789",
        ].join("\n"),
      }],
    });
    assert.match(returned.id, /^suppressed_/);
    assert.equal(store.events.count(), 0);
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number }).n,
      0,
    );
  } finally {
    store.close();
  }
});

test("screen and accessibility window metadata enforce excluded paths without scanning OCR prose", () => {
  const policy = defaultPrivacyControl();
  const privateSecondaryDisplay = {
    source: "screen_video" as const,
    app: "Code",
    window: "main.ts — Code",
    type: "frame",
    payload: {
      displayIndex: 1,
      attribution: {
        visibleWindows: ["README.md — Preview", ".env — Code"],
      },
      ocrText: "ordinary editor content",
    },
    blobs: [{ kind: "image" as const, data: "unpersisted pixels" }],
  };
  assert.equal(
    capturePolicyDecision(policy, privateSecondaryDisplay).reason,
    "excluded_path",
  );
  assert.equal(capturePolicyDecision(policy, {
    source: "accessibility",
    app: "Code",
    window: ".ssh/config — Code",
    type: "focused_text_changed",
    payload: { title: "Editor", valueHash: "hash-only" },
  }).reason, "excluded_path");
  assert.equal(capturePolicyDecision(policy, {
    source: "accessibility",
    app: "Code",
    window: "main.ts — Code",
    type: "focused_text_changed",
    payload: {
      title: "credentials.json — Code",
      valueHash: "hash-only",
    },
  }).reason, "excluded_path");
  assert.equal(capturePolicyDecision(policy, {
    source: "screen_video",
    app: "Team Chat",
    window: "Project discussion",
    type: "frame",
    payload: {
      ocrText: "We should document how .env credentials work.",
      transcript: "arbitrary conversational text is not path metadata",
    },
  }).allowed, true);

  const store = openStore({ memory: true });
  try {
    const returned = makeIngest(store).ingest(privateSecondaryDisplay);
    assert.match(returned.id, /^suppressed_/);
    assert.equal(store.events.count(), 0);
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number }).n,
      0,
    );
  } finally {
    store.close();
  }
});

test("browser capture treats only file URLs as local paths and redacts obvious DOM secrets", () => {
  const policy = defaultPrivacyControl();
  const localFile = {
    source: "browser_dom" as const,
    app: "Chrome",
    window: "file:///Users/alice/project/%2Eenv",
    type: "page_loaded",
    payload: {
      url: "file:///Users/alice/project/%2Eenv",
      title: ".env — Chrome",
    },
    blobs: [{ kind: "text" as const, data: "PRIVATE_LOCAL_DOM" }],
  };
  assert.equal(capturePolicyDecision(policy, localFile).reason, "excluded_path");
  assert.equal(capturePolicyDecision(policy, {
    source: "browser_dom",
    app: "Chrome",
    window: "Documentation",
    type: "page_loaded",
    payload: { url: "https://example.test/docs/.env-guide" },
  }).allowed, true, "ordinary web URL paths are not local filesystem paths");

  const store = openStore({ memory: true });
  try {
    const ingest = makeIngest(store).ingest;
    const suppressed = ingest(localFile);
    assert.match(suppressed.id, /^suppressed_/);
    assert.equal(store.events.count(), 0);
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number }).n,
      0,
    );

    const secret = "browser-secret-abcdefghijklmnopqrstuvwxyz012345";
    const redacted = ingest({
      source: "browser_dom",
      app: "Chrome",
      window: "Local app",
      type: "console_error",
      payload: {
        url: "http://localhost:3000/",
        message: `request failed with Bearer ${secret}`,
      },
      blobs: [{
        kind: "text",
        data: `<pre>Authorization: Bearer ${secret}</pre>`,
      }],
    });
    assert.deepEqual(redacted.payload, {
      url: "http://localhost:3000/",
      message: "[redacted sensitive content]",
      contentRedacted: true,
    });
    assert.equal(store.blobs.getText(redacted.blobRefs[0]!), "[redacted sensitive content]");
    assert.doesNotMatch(JSON.stringify(store.events.range()), new RegExp(secret));

    const ordinaryDom = "<main>Study .env configuration without credential values.</main>";
    const ordinary = ingest({
      source: "browser_dom",
      app: "Chrome",
      window: "Environment guide",
      type: "page_loaded",
      payload: { url: "https://example.test/docs/.env-guide" },
      blobs: [{ kind: "text", data: ordinaryDom }],
    });
    assert.equal(store.blobs.getText(ordinary.blobRefs[0]!), ordinaryDom);
  } finally {
    store.close();
  }
});

test("obvious secrets in file and diff blobs are redacted without discarding ordinary diffs", () => {
  const store = openStore({ memory: true });
  try {
    const ingest = makeIngest(store).ingest;
    const secret = "sk-hardcodedsecret0123456789";
    const sensitiveDiff = [
      "diff --git a/src/config.ts b/src/config.ts",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      `+export const api_key = \"${secret}\";`,
    ].join("\n");
    const redacted = ingest({
      source: "git",
      app: "git",
      window: "/repo",
      type: "staged_changed",
      payload: { stat: "1 file changed" },
      blobs: [{ kind: "diff", data: sensitiveDiff }],
    });
    assert.equal(redacted.payload.contentRedacted, true);
    assert.equal(store.blobs.getText(redacted.blobRefs[0]!), "[redacted sensitive content]");

    const ordinaryDiff = [
      "diff --git a/src/math.ts b/src/math.ts",
      "--- a/src/math.ts",
      "+++ b/src/math.ts",
      "+export const answer = 42;",
    ].join("\n");
    const ordinary = ingest({
      source: "git",
      app: "git",
      window: "/repo",
      type: "staged_changed",
      payload: { stat: "1 file changed" },
      blobs: [{ kind: "diff", data: ordinaryDiff }],
    });
    assert.equal(store.blobs.getText(ordinary.blobRefs[0]!), ordinaryDiff);
    assert.doesNotMatch(JSON.stringify(store.events.range()), new RegExp(secret));
  } finally {
    store.close();
  }
});

test("terminal and audio secrets are redacted, and secret OCR drops its source pixels", () => {
  const store = openStore({ memory: true });
  try {
    const ingest = makeIngest(store).ingest;
    const secret = "sk-capturesecret0123456789";
    const terminal = ingest({
      source: "terminal",
      app: "iTerm2",
      window: "/repo",
      type: "command_run",
      payload: {
        cmd: `curl -H 'Bearer ${secret}' https://example.test`,
        cwd: "/repo",
        exitCode: 0,
      },
    });
    assert.deepEqual(terminal.payload, {
      cmd: "[redacted sensitive content]",
      cwd: "/repo",
      exitCode: 0,
      contentRedacted: true,
    });

    const audio = ingest({
      source: "audio",
      app: "Zoom",
      window: "mic",
      type: "transcript_segment",
      payload: { channel: "mic", text: `The API_KEY=${secret}` },
    });
    assert.deepEqual(audio.payload, {
      channel: "mic",
      text: "[redacted sensitive content]",
      contentRedacted: true,
    });

    const screen = ingest({
      source: "screen_video",
      app: "Code",
      window: "main.ts",
      type: "frame",
      payload: { ocrText: `API_KEY=${secret}`, displayIndex: 0 },
      blobs: [{ kind: "image", data: "pixels containing the visible secret" }],
    });
    assert.deepEqual(screen.payload, {
      ocrText: "[redacted sensitive content]",
      displayIndex: 0,
      contentRedacted: true,
    });
    assert.deepEqual(screen.blobRefs, []);
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number }).n,
      0,
    );

    const ordinary = ingest({
      source: "screen_video",
      app: "Code",
      window: "main.ts",
      type: "frame",
      payload: { ocrText: "ordinary editor text", displayIndex: 0 },
      blobs: [{ kind: "image", data: "ordinary pixels" }],
    });
    assert.equal(ordinary.blobRefs.length, 1);
    assert.doesNotMatch(JSON.stringify(store.events.range()), new RegExp(secret));
  } finally {
    store.close();
  }
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
