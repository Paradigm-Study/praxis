import { test } from "node:test";
import assert from "node:assert/strict";
import { freshStore } from "./helpers.ts";
import { makeIngest } from "../src/capture/ingest.ts";
import { buildBundle, renderBundle } from "../src/observer/bundle.ts";

// Distinct, valid PNG payloads (magic bytes + a tag byte).
const png = (tag: number) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag, 0, 0]);

test("multi-display bundle: newest frame of EVERY display leads the images", () => {
  const store = freshStore();
  const ingest = makeIngest(store);
  const frame = (
    ts: string,
    displayIndex: number,
    displayID: number,
    ocrText: string,
    tag: number,
  ) =>
    ingest.ingest({
      source: "screen_video",
      app: "Figma",
      window: "Figma",
      type: "frame",
      ts,
      payload: { ocrText, lines: 1, displayID, displayIndex, displays: 2, changed: true },
      blobs: [{ kind: "image", data: png(tag) }],
    });

  // Tick 1: both displays. Tick 2: only the main display changed (the external
  // one is static — change detection means no new event for it).
  const mainOld = frame("2026-06-08T12:00:00.000Z", 0, 1, "main screen old", 1);
  const external = frame("2026-06-08T12:00:00.100Z", 1, 2, "external reference doc", 2);
  const mainNew = frame("2026-06-08T12:00:03.000Z", 0, 1, "main screen new", 3);

  const bundle = buildBundle(store, { includeImages: true, windowSeconds: 60 });
  const images = bundle.frameImages ?? [];
  assert.equal(images.length, 3, "all frames present");

  // The leading images must cover BOTH displays: newest main frame + the
  // external display's frame — NOT two frames of the same screen.
  const lead = images.slice(0, 2).map((i) => i.hash).sort();
  const want = [mainNew.blobRefs[0]!, external.blobRefs[0]!].sort();
  assert.deepEqual(lead, want, "first two images = newest frame per display");
  assert.equal(images[2]!.hash, mainOld.blobRefs[0], "older history follows");

  // OCR text is tagged with its screen so the model knows where words live.
  assert.ok(bundle.frameText.some((t) => t === "[display 2] external reference doc"));
  assert.ok(bundle.frameText.some((t) => t === "[display 1] main screen new"));
  assert.match(renderBundle(bundle), /\[display 2\] external reference doc/);
});

test("single-display frames keep untagged OCR text", () => {
  const store = freshStore();
  const ingest = makeIngest(store);
  ingest.ingest({
    source: "screen_video",
    app: "Code",
    window: "Code",
    type: "frame",
    ts: "2026-06-08T12:00:00.000Z",
    payload: { ocrText: "just one screen", lines: 1, displayID: 1, displayIndex: 0, displays: 1 },
    blobs: [{ kind: "image", data: png(9) }],
  });
  const bundle = buildBundle(store, { windowSeconds: 60 });
  assert.deepEqual(bundle.frameText, ["just one screen"]);
});

test("native display attribution tells the observer active versus reference context", () => {
  const store = freshStore();
  const ingest = makeIngest(store);
  ingest.ingest({
    source: "screen_video",
    app: "Preview",
    window: "Architecture.pdf",
    type: "frame",
    ts: "2026-06-08T12:00:00.000Z",
    payload: {
      ocrText: "consumer readiness notes",
      displayID: 2,
      displayIndex: 1,
      displays: 2,
      attribution: "reference-window",
      visibleApps: ["Preview", "Safari"],
    },
    blobs: [{ kind: "image", data: png(10) }],
  });
  const bundle = buildBundle(store, { windowSeconds: 60 });
  assert.deepEqual(bundle.frameText, [
    "[display 2 of 2; context reference-window; attributed app Preview; window Architecture.pdf; visible apps Preview, Safari] consumer readiness notes",
  ]);
  assert.match(renderBundle(bundle), /reference-display text is context, not user action/);
});
