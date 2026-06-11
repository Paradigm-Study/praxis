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
    /// Re-emit an unchanged display at most this often.
    private let heartbeatSec: TimeInterval = 30
    private var lastHash: [CGDirectDisplayID: String] = [:]
    private var lastEmit: [CGDirectDisplayID: Date] = [:]
    private var lastOcr: [CGDirectDisplayID: [String]] = [:]

    func captureOnce() {
        Task {
            do {
                let content = try await SCShareableContent.current
                let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown"
                for (index, display) in content.displays.enumerated() {
                    await self.capture(display, index: index,
                                       totalDisplays: content.displays.count, app: app)
                }
            } catch {
                log("screen capture failed: \(error)")
            }
        }
    }

    private func capture(_ display: SCDisplay, index: Int,
                         totalDisplays: Int, app: String) async {
        do {
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.width = max(640, display.width / 2)
            config.height = max(400, display.height / 2)
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: config
            )
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
