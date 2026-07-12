import ScreenCaptureKit
import CoreGraphics
import CryptoKit
import AppKit
import Foundation

/// Screen tap (ScreenCaptureKit): grabs a low-resolution frame of EVERY display
/// on demand (called on a low-FPS timer), so a multi-monitor desk is fully
/// visible — the reference doc on the external display is context too. PNGs go
/// to temp blobs; only references ride in the events. Needs Screen Recording.
///
/// OCR (~0.5s/frame) dominates the cost, and extra displays often sit static,
/// so each display is change-detected by content hash: unchanged frames skip
/// OCR and emission entirely, with a periodic heartbeat re-emit so a bounded
/// context window never goes blind on a static screen.
final class ScreenCapture {
    private let policy: NativePolicyChecking
    /// Optional rolling clip ring (PRAXIS_CLIP_BUFFER=1). Fed every polled
    /// frame of the main display so the clip keeps rolling even on frames the
    /// still-emitter skips; inert (nil) unless CaptureRunner opts in.
    var clipBuffer: ClipBuffer?
    /// Re-emit an unchanged display at most this often.
    private let heartbeatSec: TimeInterval = 30
    private var lastHash: [CGDirectDisplayID: String] = [:]
    private var lastEmit: [CGDirectDisplayID: Date] = [:]
    private var lastOcr: [CGDirectDisplayID: [String]] = [:]

    init(policy: NativePolicyChecking) {
        self.policy = policy
    }

    func captureOnce() {
        let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown"
        let started = AcquisitionFence.perform(
            policy: policy, source: .screenVideo, app: app, window: nil
        ) { [weak self] in
            self?.captureAllowed(frontApp: app)
        }
        if !started { Task { await clipBuffer?.clear() } }
    }

    private func captureAllowed(frontApp: String) {
        Task {
            do {
                let content = try await SCShareableContent.current
                // A display screenshot contains every visible window. If any
                // visible app/window is excluded, skip the entire frame rather
                // than allowing its pixels into ScreenCaptureKit output.
                for window in content.windows where window.isOnScreen {
                    let app = window.owningApplication?.applicationName ?? "unknown"
                    let title = window.title ?? app
                    guard self.policy.decision(
                        source: .screenVideo, app: app, window: title, at: Date()
                    ).allowed else {
                        await self.clipBuffer?.clear()
                        return
                    }
                }
                for (index, display) in content.displays.enumerated() {
                    await self.capture(display, index: index,
                                       totalDisplays: content.displays.count, app: frontApp)
                }
            } catch {
                log("screen capture failed: \(error)")
            }
        }
    }

    private func capture(_ display: SCDisplay, index: Int,
                         totalDisplays: Int, app: String) async {
        do {
            // Re-read the leased policy immediately before pixel acquisition.
            guard policy.decision(
                source: .screenVideo, app: app, window: nil, at: Date()
            ).allowed else {
                await clipBuffer?.clear()
                return
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.width = max(640, display.width / 2)
            config.height = max(400, display.height / 2)
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: config
            )
            // Feed the rolling clip BEFORE the changed/stale guard so it keeps
            // rolling on frames the still-emitter skips. Main display only —
            // the clip writer needs stable dimensions.
            if index == 0, let clip = clipBuffer { await clip.ingest(image: image) }
            guard let data = pngData(image) else { return }

            let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            let changed = hash != lastHash[display.displayID]
            let stale = Date().timeIntervalSince(lastEmit[display.displayID] ?? .distantPast)
                >= heartbeatSec
            guard changed || stale else { return }
            lastHash[display.displayID] = hash
            lastEmit[display.displayID] = Date()

            // OCR the frame at capture time so visible text becomes evidence —
            // but only when the content actually changed; heartbeats reuse the
            // cached text so a static display never loses its words.
            let ocr = changed ? OCR.recognize(image) : (lastOcr[display.displayID] ?? [])
            if changed { lastOcr[display.displayID] = ocr }
            let blob = Emitter.shared.writeBlob(data, kind: "image", ext: "png")
            Emitter.shared.emit(
                source: "screen_video", app: app, window: app,
                type: "frame",
                payload: [
                    "w": config.width, "h": config.height,
                    "ocrText": ocr.joined(separator: "\n"),
                    "lines": ocr.count,
                    "displayID": Int(display.displayID),
                    "displayIndex": index,
                    "displays": totalDisplays,
                    "changed": changed,
                ],
                blobFiles: blob.map { [$0] }
            )
        } catch {
            log("screen capture failed for display \(index): \(error)")
        }
    }
}
