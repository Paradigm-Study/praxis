import ScreenCaptureKit
import CoreGraphics
import CryptoKit
import AppKit
import Foundation

/**
 * One permit for a whole asynchronous multi-display capture pass. Timer ticks
 * can arrive while ScreenCaptureKit or OCR is still working; serializing those
 * passes keeps the mutable per-display caches race-free without blocking the
 * main run loop.
 */
public final class CapturePassGate: @unchecked Sendable {
    private let lock = NSLock()
    private var inFlight = false

    public init() {}

    public func tryBegin() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !inFlight else { return false }
        inFlight = true
        return true
    }

    public func finish() {
        lock.lock()
        inFlight = false
        lock.unlock()
    }
}

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
    private let passGate = CapturePassGate()
    private var passTask: Task<Void, Never>?

    init(policy: NativePolicyChecking) {
        self.policy = policy
    }

    func captureOnce() {
        // One pass can take longer than the periodic timer on multi-display
        // desks. Skip this tick rather than racing the per-display caches.
        guard passGate.tryBegin() else { return }
        let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown"
        let started = AcquisitionFence.perform(
            policy: policy, source: .screenVideo, app: nil, window: nil
        ) {
            self.captureAllowed(frontApp: app)
        }
        if !started {
            passGate.finish()
            Task { await clipBuffer?.clear() }
        }
    }

    private func captureAllowed(frontApp: String) {
        passTask = Task {
            // This covers successful completion, every thrown ScreenCaptureKit
            // error, and cooperative task cancellation.
            defer { self.passGate.finish() }
            do {
                let content = try await SCShareableContent.current
                let policyWindows = content.windows.compactMap { window -> VisibleScreenWindow? in
                    guard window.isOnScreen else { return nil }
                    let app = window.owningApplication?.applicationName ?? "unknown"
                    return VisibleScreenWindow(
                        app: app,
                        title: window.title ?? app,
                        frame: window.frame
                    )
                }
                let windows = content.windows.compactMap { window -> VisibleScreenWindow? in
                    guard window.isOnScreen, window.windowLayer == 0,
                          let app = window.owningApplication?.applicationName else { return nil }
                    return VisibleScreenWindow(app: app, title: window.title ?? app, frame: window.frame)
                }
                for (index, display) in content.displays.enumerated() {
                    if Task.isCancelled { return }
                    await self.capture(display, index: index,
                                       totalDisplays: content.displays.count,
                                       frontApp: frontApp, windows: windows,
                                       policyWindows: policyWindows)
                }
            } catch {
                log("screen capture failed: \(error)")
            }
        }
    }

    func stop() {
        passTask?.cancel()
        passTask = nil
        Task { await clipBuffer?.clear() }
    }

    private func capture(_ display: SCDisplay, index: Int,
                         totalDisplays: Int, frontApp: String,
                         windows: [VisibleScreenWindow],
                         policyWindows: [VisibleScreenWindow]) async {
        do {
            let attribution = ScreenFrameAttributor.attribute(
                displayFrame: display.frame,
                displayIndex: index,
                frontmostApp: frontApp,
                windows: windows,
                policyWindows: policyWindows
            )
            // Re-read the leased policy for every geometry-matched window
            // immediately before pixel acquisition. Reference displays can
            // contain excluded content even when they are not frontmost.
            guard ScreenFrameAttributor.acquisitionAllowed(
                attribution, policy: policy, at: Date()
            ) else {
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
            guard !Task.isCancelled else {
                await clipBuffer?.clear()
                return
            }
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
            guard !Task.isCancelled else {
                await clipBuffer?.clear()
                return
            }
            let blob = Emitter.shared.writeBlob(data, kind: "image", ext: "png")
            Emitter.shared.emit(
                source: "screen_video", app: attribution.app,
                window: attribution.window,
                type: "frame",
                payload: [
                    "w": config.width, "h": config.height,
                    "ocrText": ocr.joined(separator: "\n"),
                    "lines": ocr.count,
                    "displayID": Int(display.displayID),
                    "displayIndex": index,
                    "displays": totalDisplays,
                    "changed": changed,
                    "attribution": attribution.kind,
                    "visibleApps": attribution.visibleApps,
                    "visibleWindows": attribution.visibleWindows,
                ],
                blobFiles: blob.map { [$0] }
            )
        } catch {
            log("screen capture failed for display \(index): \(error)")
        }
    }
}
