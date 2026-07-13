import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilesystemSource,
  ignoredFilesystemPath,
} from "../src/capture/sources/filesystem.ts";
import type { EventSink, RawEventInput } from "../src/capture/source.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 180));
const collect = (events: RawEventInput[]): EventSink => (event) => {
  events.push(event);
  return event as unknown as ReturnType<EventSink>;
};

test("filesystem silently baselines existing files, then emits their real edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "praxis-filesystem-baseline-"));
  const target = join(root, "src", "example.ts");
  mkdirSync(join(root, "src"));
  writeFileSync(target, "export const value = 1;\n");
  let notify: ((filename: string | Buffer | null) => void) | undefined;
  const events: RawEventInput[] = [];
  const source = new FilesystemSource({
    root,
    watchTree: (_root, callback) => {
      notify = callback;
      return { close() {} };
    },
  });
  try {
    source.start(collect(events));
    notify!("src/example.ts");
    await settle();
    assert.equal(events.length, 0, "an unchanged first callback is baseline noise");

    writeFileSync(target, "export const value = 2;\n");
    notify!("src/example.ts");
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "file_changed");
    assert.equal(events[0]!.payload?.changeKind, "modified");
    assert.equal(events[0]!.payload?.workspaceRoot, root);
    assert.equal(events[0]!.blobs?.some((blob) => blob.kind === "diff"), true);
  } finally {
    source.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a newly created file is an edit, never an opened-file observation", async () => {
  const root = mkdtempSync(join(tmpdir(), "praxis-filesystem-created-"));
  let notify: ((filename: string | Buffer | null) => void) | undefined;
  const events: RawEventInput[] = [];
  const source = new FilesystemSource({
    root,
    watchTree: (_root, callback) => {
      notify = callback;
      return { close() {} };
    },
  });
  try {
    source.start(collect(events));
    writeFileSync(join(root, "new.ts"), "export {};\n");
    notify!("new.ts");
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "file_changed");
    assert.equal(events[0]!.payload?.changeKind, "created");
  } finally {
    source.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated build and release trees are filtered by path segment", async () => {
  assert.equal(ignoredFilesystemPath("dist/app.js"), true);
  assert.equal(ignoredFilesystemPath("release/mac/Paradigm.app/index.js"), true);
  assert.equal(ignoredFilesystemPath("build/output.js"), true);
  assert.equal(ignoredFilesystemPath("src/distribution.ts"), false);
  assert.equal(ignoredFilesystemPath("src/release-notes.ts"), false);

  const root = mkdtempSync(join(tmpdir(), "praxis-filesystem-generated-"));
  mkdirSync(join(root, "release"));
  writeFileSync(join(root, "release", "artifact.js"), "generated");
  let notify: ((filename: string | Buffer | null) => void) | undefined;
  const events: RawEventInput[] = [];
  const source = new FilesystemSource({
    root,
    watchTree: (_root, callback) => {
      notify = callback;
      return { close() {} };
    },
  });
  try {
    source.start(collect(events));
    notify!("release/artifact.js");
    await settle();
    assert.equal(events.length, 0);
  } finally {
    source.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem denial cannot replay blocked file contents after resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "praxis-filesystem-private-gap-"));
  const target = join(root, "notes.ts");
  writeFileSync(target, "export const publicBefore = true;\n");
  let notify: ((filename: string | Buffer | null) => void) | undefined;
  let allowed = true;
  let bodyReads = 0;
  const events: RawEventInput[] = [];
  const source = new FilesystemSource({
    root,
    canAcquire: () => allowed,
    readText: (fd, maxBytes) => {
      bodyReads += 1;
      const buffer = Buffer.alloc(maxBytes);
      const bytes = readSync(fd, buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytes).toString("utf8");
    },
    watchTree: (_root, callback) => {
      notify = callback;
      return { close() {} };
    },
  });
  try {
    source.start(collect(events));

    allowed = false;
    writeFileSync(target, "BLOCKED_FILE_BODY_MUST_NOT_REPLAY\n");
    notify!("notes.ts");
    await settle();
    assert.equal(bodyReads, 0, "denied callback never opens or reads the file body");
    assert.equal(events.length, 0);

    allowed = true;
    writeFileSync(target, "BLOCKED_FILE_BODY_MUST_NOT_REPLAY\nvisible after resume one\n");
    notify!("notes.ts");
    await settle();
    assert.equal(events.length, 0, "first allowed callback is a silent privacy baseline");

    writeFileSync(
      target,
      "BLOCKED_FILE_BODY_MUST_NOT_REPLAY\nvisible after resume one\nvisible after resume two\n",
    );
    notify!("notes.ts");
    await settle();
    assert.equal(events.length, 1);
    assert.doesNotMatch(JSON.stringify(events[0]), /BLOCKED_FILE_BODY_MUST_NOT_REPLAY/);
    assert.equal(events[0]!.blobs?.some((blob) => blob.kind === "file"), false);
    assert.match(String(events[0]!.blobs?.find((blob) => blob.kind === "diff")?.data), /visible after resume two/);
  } finally {
    source.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("evicting a privacy baseline cannot turn blocked file text into additions", async () => {
  const root = mkdtempSync(join(tmpdir(), "praxis-filesystem-private-eviction-"));
  const target = join(root, "notes.ts");
  writeFileSync(target, "public before\n");
  let notify: ((filename: string | Buffer | null) => void) | undefined;
  let allowed = true;
  const events: RawEventInput[] = [];
  const source = new FilesystemSource({
    root,
    maxSnapshots: 1,
    canAcquire: () => allowed,
    watchTree: (_root, callback) => {
      notify = callback;
      return { close() {} };
    },
  });
  try {
    source.start(collect(events));
    allowed = false;
    writeFileSync(target, "BLOCKED_EVICTED_BODY\n");
    notify!("notes.ts");
    await settle();

    allowed = true;
    writeFileSync(target, "BLOCKED_EVICTED_BODY\nvisible one\n");
    notify!("notes.ts");
    await settle();
    assert.equal(events.length, 0);

    writeFileSync(join(root, "other.ts"), "other body\n");
    notify!("other.ts");
    await settle();
    events.length = 0;

    writeFileSync(target, "BLOCKED_EVICTED_BODY\nvisible one\nvisible two\n");
    notify!("notes.ts");
    await settle();
    assert.equal(events.length, 0, "an evicted tainted baseline is silently restored");

    writeFileSync(
      target,
      "BLOCKED_EVICTED_BODY\nvisible one\nvisible two\nvisible three\n",
    );
    notify!("notes.ts");
    await settle();
    assert.equal(events.length, 1);
    assert.doesNotMatch(JSON.stringify(events[0]), /BLOCKED_EVICTED_BODY/);
    assert.match(String(events[0]?.blobs?.[0]?.data), /visible three/);
  } finally {
    source.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
