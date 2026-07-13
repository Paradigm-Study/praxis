import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeIngest } from "../src/capture/ingest.ts";
import { processNativeLine } from "../src/capture/sources/nativeBridge.ts";
import type { CaptureSourceStatus } from "../src/capture/source.ts";
import { freshStore } from "./helpers.ts";

const IMAGE_NAME = "12345678-1234-4234-8234-123456789abc.png";
const TEXT_NAME = "12345678-1234-4234-8234-123456789abc.txt";

function screenLine(path: string, kind = "image", source = "screen_video"): string {
  return JSON.stringify({
    ts: "2026-07-13T21:00:00.000Z",
    source,
    app: "Preview",
    window: "Reference.pdf",
    type: "frame",
    payload: { w: 100, h: 100 },
    blobFiles: [{ kind, path }],
  });
}

test("native channel readiness is routed out of band from evidence", () => {
  const store = freshStore();
  const statuses: CaptureSourceStatus[] = [];
  processNativeLine(
    JSON.stringify({
      ts: "2026-07-13T21:00:00.000Z",
      source: "capture_control",
      app: "Praxis",
      window: "Accessibility",
      type: "source_status",
      payload: {
        channel: "accessibility",
        status: "blocked",
        reason: "permission-not-granted",
      },
    }),
    makeIngest(store).ingest,
    (status) => statuses.push(status),
  );
  processNativeLine(
    JSON.stringify({
      source: "capture_control",
      app: "Praxis",
      window: "Screen Recording",
      type: "source_status",
      payload: { channel: "screen_recording", status: "ready" },
    }),
    makeIngest(store).ingest,
    (status) => statuses.push(status),
  );
  processNativeLine(
    JSON.stringify({
      source: "capture_control",
      app: "Praxis",
      window: "Microphone Audio",
      type: "source_status",
      payload: { channel: "audio_mic", status: "disabled", reason: "not-requested" },
    }),
    makeIngest(store).ingest,
    (status) => statuses.push(status),
  );

  assert.deepEqual(statuses, [
    {
      channel: "accessibility",
      status: "blocked",
      reason: "permission-not-granted",
    },
    { channel: "screen_recording", status: "ready" },
    { channel: "audio_mic", status: "disabled", reason: "not-requested" },
  ]);
  assert.equal(store.events.count(), 0, "readiness metadata is not captured as user evidence");
  store.close();
});

test("invalid native readiness metadata fails closed", () => {
  const store = freshStore();
  const statuses: CaptureSourceStatus[] = [];
  processNativeLine(
    JSON.stringify({
      source: "capture_control",
      app: "Praxis",
      window: "Accessibility",
      type: "source_status",
      payload: { channel: "accessibility", status: "definitely-ready" },
    }),
    makeIngest(store).ingest,
    (status) => statuses.push(status),
  );
  assert.deepEqual(statuses, []);
  assert.equal(store.events.count(), 0);
  store.close();
});

test("native blobs cannot read or delete an arbitrary file outside the producer temp directory", () => {
  const temp = mkdtempSync(join(tmpdir(), "praxis-native-blob-boundary-"));
  const blobDir = join(temp, "praxis-frames");
  const arbitrary = join(temp, IMAGE_NAME);
  mkdirSync(blobDir, { mode: 0o700 });
  writeFileSync(arbitrary, "do not acquire or delete");
  const store = freshStore();
  try {
    processNativeLine(screenLine(arbitrary), makeIngest(store).ingest, undefined, { blobDir });

    assert.equal(readFileSync(arbitrary, "utf8"), "do not acquire or delete");
    assert.deepEqual(store.events.range()[0]?.blobRefs, []);
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS count FROM blobs").get() as { count: number }).count),
      0,
    );
  } finally {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("native blob symlinks and hard links are rejected without deleting their targets", () => {
  const temp = mkdtempSync(join(tmpdir(), "praxis-native-blob-links-"));
  const blobDir = join(temp, "praxis-frames");
  const target = join(temp, "private-reference.png");
  const symlink = join(blobDir, IMAGE_NAME);
  const hardLink = join(blobDir, "abcdefab-cdef-4abc-8def-abcdefabcdef.png");
  mkdirSync(blobDir, { mode: 0o700 });
  writeFileSync(target, "target bytes");
  symlinkSync(target, symlink, "file");
  linkSync(target, hardLink);
  const store = freshStore();
  try {
    processNativeLine(screenLine(symlink), makeIngest(store).ingest, undefined, { blobDir });
    processNativeLine(screenLine(hardLink), makeIngest(store).ingest, undefined, { blobDir });

    assert.equal(readFileSync(target, "utf8"), "target bytes");
    assert.equal(existsSync(symlink), true, "rejected symlink is not unlinked");
    assert.equal(existsSync(hardLink), true, "rejected hard link is not unlinked");
    assert.equal(store.events.range().every((event) => event.blobRefs.length === 0), true);
  } finally {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("native bridge accepts a bounded producer-owned temp blob and removes only that file", () => {
  const temp = mkdtempSync(join(tmpdir(), "praxis-native-blob-valid-"));
  const blobDir = join(temp, "praxis-frames");
  const blobPath = join(blobDir, IMAGE_NAME);
  mkdirSync(blobDir, { mode: 0o700 });
  writeFileSync(blobPath, "validated image bytes", { mode: 0o600 });
  const store = freshStore();
  try {
    processNativeLine(screenLine(blobPath), makeIngest(store).ingest, undefined, { blobDir });

    const event = store.events.range()[0]!;
    assert.equal(event.blobRefs.length, 1);
    assert.equal(store.blobs.getText(event.blobRefs[0]!), "validated image bytes");
    assert.equal(existsSync(blobPath), false);
  } finally {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("native source-kind mismatches fail closed and never consume the referenced file", () => {
  const temp = mkdtempSync(join(tmpdir(), "praxis-native-blob-kind-"));
  const blobDir = join(temp, "praxis-frames");
  const blobPath = join(blobDir, TEXT_NAME);
  mkdirSync(blobDir, { mode: 0o700 });
  writeFileSync(blobPath, "not a screen image", { mode: 0o600 });
  const store = freshStore();
  try {
    processNativeLine(screenLine(blobPath, "text"), makeIngest(store).ingest, undefined, { blobDir });
    assert.equal(readFileSync(blobPath, "utf8"), "not a screen image");
    assert.deepEqual(store.events.range()[0]?.blobRefs, []);

    processNativeLine(
      screenLine(blobPath, "text", "filesystem"),
      makeIngest(store).ingest,
      undefined,
      { blobDir },
    );
    assert.equal(store.events.count(), 1, "non-native event sources are rejected at the bridge");
    assert.equal(existsSync(blobPath), true);
  } finally {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("native bridge rejects a producer temp blob above its kind-specific size bound", () => {
  const temp = mkdtempSync(join(tmpdir(), "praxis-native-blob-size-"));
  const blobDir = join(temp, "praxis-frames");
  const blobPath = join(blobDir, TEXT_NAME);
  mkdirSync(blobDir, { mode: 0o700 });
  writeFileSync(blobPath, "x", { mode: 0o600 });
  truncateSync(blobPath, 8 * 1024 * 1024 + 1);
  const store = freshStore();
  try {
    processNativeLine(
      screenLine(blobPath, "text", "clipboard"),
      makeIngest(store).ingest,
      undefined,
      { blobDir },
    );
    assert.deepEqual(store.events.range()[0]?.blobRefs, []);
    assert.equal(existsSync(blobPath), true, "an unvalidated oversized path is never unlinked");
  } finally {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("native bridge requires 0700 producer directories and 0600 blob files", () => {
  const temp = mkdtempSync(join(tmpdir(), "praxis-native-blob-permissions-"));
  const blobDir = join(temp, "praxis-frames");
  const blobPath = join(blobDir, IMAGE_NAME);
  mkdirSync(blobDir, { mode: 0o700 });
  writeFileSync(blobPath, "permission-sensitive pixels", { mode: 0o600 });
  const store = freshStore();
  try {
    chmodSync(blobDir, 0o755);
    processNativeLine(screenLine(blobPath), makeIngest(store).ingest, undefined, { blobDir });
    assert.equal(existsSync(blobPath), true);
    assert.deepEqual(store.events.range()[0]?.blobRefs, []);

    chmodSync(blobDir, 0o700);
    chmodSync(blobPath, 0o640);
    processNativeLine(screenLine(blobPath), makeIngest(store).ingest, undefined, { blobDir });
    assert.equal(existsSync(blobPath), true);
    assert.deepEqual(store.events.range()[1]?.blobRefs, []);
  } finally {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("native privacy preflight runs before bytes and cleans only a validated producer temp", () => {
  const temp = mkdtempSync(join(tmpdir(), "praxis-native-blob-private-"));
  const blobDir = join(temp, "praxis-frames");
  const blobPath = join(blobDir, IMAGE_NAME);
  mkdirSync(blobDir, { mode: 0o700 });
  writeFileSync(blobPath, "private pixels", { mode: 0o600 });
  const store = freshStore();
  let preflights = 0;
  try {
    processNativeLine(screenLine(blobPath), makeIngest(store).ingest, undefined, {
      blobDir,
      canAcquire: () => {
        preflights += 1;
        return false;
      },
    });

    assert.equal(preflights, 1);
    assert.deepEqual(store.events.range()[0]?.blobRefs, []);
    assert.equal(existsSync(blobPath), false, "validated denied pixels do not linger in temp storage");
  } finally {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
