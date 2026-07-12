# ClipBuffer integration notes (module: clip-buffer)

New file: `native/PraxisCapture/Sources/PraxisCaptureKit/ClipBuffer.swift`

`actor ClipBuffer(seconds: Int = 90, fps: Int = 4)` keeps a bounded ring of
JPEG-compressed frames (`capacity = seconds * fps`, oldest dropped) and
`persistClip(reason:)` encodes the ring into a low-bitrate H.264 `.mp4` in
`Emitter.shared.blobDir`, then emits over the existing NDJSON contract:

```json
{ "source": "screen_video", "type": "screen_clip",
  "payload": { "reason": "...", "path": "<mp4 path>", "durationSeconds": 12.5,
               "frames": 50, "w": 1280, "h": 800 },
  "blobFiles": [{ "kind": "video", "path": "<mp4 path>" }] }
```

The mp4 rides in `blobFiles`, so the TypeScript bridge offloads it into the
blob store (read + delete) exactly like screenshot PNGs. Nothing is wired into
the capture pipeline yet — the buffer is inert until the hookup below lands.

## 3-line hookup (integrator; guarded by `PRAXIS_CLIP_BUFFER=1`)

The existing pipeline polls stills via `SCScreenshotManager` (there is no live
`SCStream`), so the feed point is where `ScreenCapture` already has a
`CGImage` in hand. `ClipBuffer` also accepts `CMSampleBuffer` via
`ingest(sampleBuffer:)` for a future continuous `SCStreamOutput` path.

`Sources/PraxisCaptureKit/ScreenCapture.swift` (2 lines):

1. Add a property to `ScreenCapture`:
   ```swift
   var clipBuffer: ClipBuffer?
   ```
2. In `capture(_:index:totalDisplays:app:)`, immediately after
   `SCScreenshotManager.captureImage(...)` returns `image` — BEFORE the
   changed/stale guard, so the clip keeps rolling on frames the still-emitter
   skips. Main display only, so the writer sees stable dimensions:
   ```swift
   if index == 0, let clip = clipBuffer { await clip.ingest(image: image) }
   ```

`Sources/PraxisCaptureKit/CaptureRunner.swift` (1 line), in `start()` right
after `let s = ScreenCapture(); screen = s`:

```swift
if ProcessInfo.processInfo.environment["PRAXIS_CLIP_BUFFER"] == "1" { s.clipBuffer = ClipBuffer() }
```

Optionally, expose a trigger on `CaptureRunner` for future callers (hotkey,
error rules, boardroom raise):

```swift
public func persistClip(reason: String) { Task { await self.screen?.clipBuffer?.persistClip(reason: reason) } }
```

Nobody calls `persistClip` in v0 — the buffer just rolls; the trigger surface
is a follow-up.

### Effective frame rate

`CaptureRunner`'s default `frameInterval` is 3.0 s, so the buffer receives
~0.33 fps — well under the ClipBuffer's own 4 fps throttle. The ring then
covers a LONGER wall-clock window (360 frames x 3 s ≈ 18 min) rather than
90 s. If a true 90 s / 4 fps clip is wanted, lower `frameInterval` to 0.25
when the flag is on (screenshot-poll cost rises accordingly) or wait for the
`SCStream` path.

## Privacy

Same stance as screen frames: the clip is a local temp blob, only a reference
rides in the event, blobs never serialize into anything mesh-bound. Memory is
bounded by the frame cap; frames are stored JPEG-compressed (~50–250 KB each
at half-res), never as retained `CMSampleBuffer`s.

## Tests

Pure logic (ring indexing, trimming, wrap-around, timestamp normalization,
fps throttle, even-dimension math) is split into `ClipRing` / `ClipMath` and
covered by `native/PraxisCapture/Tests/PraxisCaptureKitTests/ClipRingTests.swift`
(swift-testing, 16 tests, all passing).

This machine has Command Line Tools only (no Xcode), which ships
`Testing.framework` but does not put it on the default search path, and has no
XCTest at all. Run the Swift tests with:

```sh
FW=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
LIB=/Library/Developer/CommandLineTools/Library/Developer/usr/lib
swift test --package-path native/PraxisCapture \
  -Xswiftc -F -Xswiftc $FW \
  -Xlinker -F -Xlinker $FW \
  -Xlinker -rpath -Xlinker $FW \
  -Xlinker -rpath -Xlinker $LIB
```

(With full Xcode installed, plain `swift test --package-path
native/PraxisCapture` works.)

The AVAssetWriter/capture runtime path cannot be exercised headless — it needs
Screen Recording TCC to produce real frames — so it is verified by compilation
plus the pure-logic tests it sits on.

## Package.swift change (flagging for review)

To make the test target possible, `native/PraxisCapture/Package.swift` was
bumped from `swift-tools-version:5.9` to `6.0` (swift-testing is invisible to
SwiftPM under 5.9). Every target pins `swiftSettings:
[.swiftLanguageMode(.v5)]`, so compile semantics are unchanged. Verified:
`npm run native:build` and `npm run bar:build` (PraxisBar depends on this
package) both green. If the integrator prefers zero Package.swift churn,
revert the tools-version bump and the `.testTarget` block and delete
`Tests/` — ClipBuffer.swift itself has no dependency on either.
