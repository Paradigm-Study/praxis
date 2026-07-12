import AVFoundation
import AppKit
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation

/// Rolling "last N seconds" screen-clip buffer.
///
/// The existing pipeline polls stills via `SCScreenshotManager` (see
/// ScreenCapture.swift) rather than running a continuous `SCStream`, so this
/// buffer is fed, not self-capturing: any producer — the current screenshot
/// timer, or a future `SCStreamOutput` video callback — pushes frames in via
/// `ingest(image:)` / `ingest(sampleBuffer:)`. Frames are re-encoded to JPEG
/// immediately so the ring holds small compressed blobs, never live
/// `CMSampleBuffer`s (holding those would starve ScreenCaptureKit's fixed
/// buffer pool and pin uncompressed BGRA memory — ~33 MB per 4K frame).
///
/// `persistClip(reason:)` renders the ring into a low-bitrate H.264 .mp4 in the
/// Emitter's blob temp dir and emits a `screen_clip` event over the existing
/// NDJSON contract, with the file referenced via `blobFiles` so the TypeScript
/// bridge offloads it into the blob store (read + delete) like screenshot PNGs.
///
/// Privacy: identical stance to screen frames — the clip is a local temp blob;
/// only a reference rides in the event, and blobs never serialize into
/// anything mesh-bound.
///
/// Memory bound: the ring caps at `seconds * fps` frames and drops the oldest
/// on overflow. At half-resolution JPEG (quality 0.6) a frame is typically
/// 50–250 KB, so the default 90 s × 4 fps = 360 frames stays in the tens of MB.

// MARK: - Pure ring logic (no AVFoundation / permissions — unit-testable)

/// One buffered frame: compressed image bytes + capture time (seconds since
/// reference date, so arithmetic needs no Date objects).
public struct ClipFrame {
    public let data: Data
    public let ts: TimeInterval
    public init(data: Data, ts: TimeInterval) {
        self.data = data
        self.ts = ts
    }
}

/// Fixed-capacity circular buffer. O(1) append; oldest frame is overwritten
/// once full. Kept as a plain struct so ring indexing / trimming / duration
/// math is testable without capture permissions.
public struct ClipRing {
    public let capacity: Int
    private var storage: [ClipFrame]
    /// Once full: index of the slot the NEXT append overwrites — which is also
    /// the index of the OLDEST frame currently held.
    private var writeIndex = 0

    public init(capacity: Int) {
        self.capacity = max(1, capacity)
        storage = []
        storage.reserveCapacity(self.capacity)
    }

    public var count: Int { storage.count }
    public var isEmpty: Bool { storage.isEmpty }
    public var totalBytes: Int { storage.reduce(0) { $0 + $1.data.count } }

    public mutating func append(_ frame: ClipFrame) {
        if storage.count < capacity {
            storage.append(frame)
        } else {
            storage[writeIndex] = frame
            writeIndex = (writeIndex + 1) % capacity
        }
    }

	/// Drop frames older than a wall-clock cutoff. Capacity alone is not a
	/// duration guarantee when the producer runs below the configured fps (the
	/// current screenshot source is ~0.33 fps), so ClipBuffer applies this on
	/// every ingest to keep the privacy window truly bounded in seconds.
	public mutating func removeFrames(olderThan cutoff: TimeInterval) {
		let kept = orderedFrames.filter { $0.ts >= cutoff }
		storage = kept.count <= capacity ? kept : Array(kept.suffix(capacity))
		writeIndex = 0
	}

    /// Frames oldest → newest, unwrapping the circular layout.
    public var orderedFrames: [ClipFrame] {
        guard storage.count == capacity, writeIndex > 0 else { return storage }
        return Array(storage[writeIndex...]) + Array(storage[..<writeIndex])
    }

    /// Wall-clock span covered by the buffered frames.
    public var durationSeconds: Double {
        let frames = orderedFrames
        guard frames.count > 1, let first = frames.first, let last = frames.last else { return 0 }
        return max(0, last.ts - first.ts)
    }

    public mutating func removeAll() {
        storage.removeAll(keepingCapacity: true)
        writeIndex = 0
    }
}

public enum ClipMath {
    /// Frame-rate throttle: accept a frame only if at least ~1/fps elapsed
    /// since the last accepted one (small tolerance so a timer firing a hair
    /// early is not dropped).
    public static func shouldAccept(now: TimeInterval, lastAccepted: TimeInterval,
                                    fps: Int) -> Bool {
        guard fps > 0 else { return true }
        let minInterval = (1.0 / Double(fps)) * 0.95
        return now - lastAccepted >= minInterval
    }

    /// Rebase timestamps to zero and force them strictly increasing —
    /// AVAssetWriter rejects non-monotonic presentation times, and polled
    /// captures can produce duplicate or out-of-order stamps under load.
    public static func normalizeTimestamps(_ raw: [TimeInterval],
                                           minStep: TimeInterval = 0.001) -> [TimeInterval] {
        guard let first = raw.first else { return [] }
        var out: [TimeInterval] = []
        out.reserveCapacity(raw.count)
        var prev = -TimeInterval.infinity
        for ts in raw {
            var t = ts - first
            if t <= prev { t = prev + minStep }
            out.append(t)
            prev = t
        }
        return out
    }

    /// H.264 requires even pixel dimensions.
    public static func evenDimension(_ v: Int) -> Int { max(2, v - (v % 2)) }
}

// MARK: - Actor

public actor ClipBuffer {
    public let seconds: Int
    public let fps: Int

    private var ring: ClipRing
    private var lastAccepted: TimeInterval = -.infinity
    private let jpegQuality: Float = 0.6
    private let ciContext = CIContext(options: [.cacheIntermediates: false])

    public init(seconds: Int = 90, fps: Int = 4) {
        self.seconds = max(1, seconds)
        self.fps = max(1, fps)
        self.ring = ClipRing(capacity: self.seconds * self.fps)
    }

    public var frameCount: Int { ring.count }
    public var bufferedSeconds: Double { ring.durationSeconds }

    /// Drop buffered pixels immediately when acquisition becomes disallowed.
    public func clear() {
        ring.removeAll()
        lastAccepted = -.infinity
    }

    // MARK: Feeding

    /// Feed a frame from the existing screenshot path (ScreenCapture already
    /// has a CGImage in hand). Throttled to the configured fps; compressed to
    /// JPEG before entering the ring so memory stays bounded.
    public func ingest(image: CGImage, at date: Date = Date()) {
        let now = date.timeIntervalSinceReferenceDate
        guard ClipMath.shouldAccept(now: now, lastAccepted: lastAccepted, fps: fps) else { return }
        guard let data = Self.jpegData(image, quality: jpegQuality) else { return }
        lastAccepted = now
        ring.removeFrames(olderThan: now - Double(seconds))
        ring.append(ClipFrame(data: data, ts: now))
    }

    /// Feed a frame from an `SCStreamOutput` video callback (future continuous
    /// path). Converts the pixel buffer to CGImage and reuses `ingest(image:)`.
    /// The sample buffer is fully consumed here — nothing retains it.
    public func ingest(sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferIsValid(sampleBuffer),
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ci = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        // Stream PTS is host-clock based; map to wall time via "now" — frame
        // spacing is what matters for the clip, not absolute epoch.
        _ = pts
        ingest(image: cg, at: Date())
    }

    // MARK: Persisting

    /// Encode the current ring into a low-bitrate H.264 .mp4 in the Emitter's
    /// blob dir and emit a `screen_clip` event. Returns the written URL, or
    /// nil if the buffer was empty / encoding failed (failure is logged, never
    /// thrown — capture must not crash over a clip).
    @discardableResult
    public func persistClip(reason: String) async -> URL? {
        let frames = ring.orderedFrames
        guard !frames.isEmpty else {
            log("clip: persist requested (\(reason)) but buffer is empty")
            return nil
        }
        guard let firstImage = Self.decodeJpeg(frames[0].data) else {
            log("clip: could not decode first frame")
            return nil
        }
        let width = ClipMath.evenDimension(firstImage.width)
        let height = ClipMath.evenDimension(firstImage.height)
        let url = Emitter.shared.blobDir
            .appendingPathComponent(UUID().uuidString + ".mp4")

        do {
            try await Self.writeMp4(frames: frames, width: width, height: height,
                                    to: url, ciContext: ciContext)
        } catch {
            log("clip: mp4 write failed: \(error)")
            try? FileManager.default.removeItem(at: url)
            return nil
        }

        let duration = ring.durationSeconds
        let app = FrontmostTracker.shared.current
        Emitter.shared.emit(
            source: "screen_video", app: app, window: app,
            type: "screen_clip",
            payload: [
                "reason": reason,
                "path": url.path,
                "durationSeconds": duration,
                "frames": frames.count,
                "w": width, "h": height,
            ],
            blobFiles: [["kind": "video", "path": url.path]]
        )
        log("clip: persisted \(frames.count) frames (\(String(format: "%.1f", duration))s) reason=\(reason)")
        return url
    }

    // MARK: - Encoding helpers (static: no actor state)

    static func jpegData(_ cg: CGImage, quality: Float) -> Data? {
        let rep = NSBitmapImageRep(cgImage: cg)
        return rep.representation(using: .jpeg,
                                  properties: [.compressionFactor: NSNumber(value: quality)])
    }

    static func decodeJpeg(_ data: Data) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, nil)
    }

    /// Offline H.264 encode of the frame sequence. Low bitrate on purpose —
    /// clips are context evidence, not screencasts.
    static func writeMp4(frames: [ClipFrame], width: Int, height: Int,
                         to url: URL, ciContext: CIContext) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 1_000_000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264MainAutoLevel,
                AVVideoAllowFrameReorderingKey: false,
            ],
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
            ]
        )
        guard writer.canAdd(input) else { throw ClipError.writerSetup }
        writer.add(input)
        guard writer.startWriting() else {
            throw writer.error ?? ClipError.writerSetup
        }
        writer.startSession(atSourceTime: .zero)

        let times = ClipMath.normalizeTimestamps(frames.map { $0.ts })
        for (i, frame) in frames.enumerated() {
            guard let image = decodeJpeg(frame.data) else { continue }
            guard let pb = makePixelBuffer(from: image, width: width, height: height,
                                           pool: adaptor.pixelBufferPool,
                                           ciContext: ciContext) else { continue }
            // Offline write: poll readiness instead of requestMediaDataWhenReady —
            // simpler, and a few ms of sleep is irrelevant off the capture path.
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            let t = CMTime(seconds: times[i], preferredTimescale: 600)
            if !adaptor.append(pb, withPresentationTime: t) {
                throw writer.error ?? ClipError.appendFailed
            }
        }
        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed {
            throw writer.error ?? ClipError.writerFailed
        }
    }

    /// Render a CGImage into a BGRA pixel buffer, aspect-fit (frames can change
    /// size mid-buffer when displays change; the writer's dimensions are fixed
    /// by the first frame).
    static func makePixelBuffer(from image: CGImage, width: Int, height: Int,
                                pool: CVPixelBufferPool?,
                                ciContext: CIContext) -> CVPixelBuffer? {
        var pb: CVPixelBuffer?
        if let pool {
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
        }
        if pb == nil {
            CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA,
                                [kCVPixelBufferCGImageCompatibilityKey: true,
                                 kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary,
                                &pb)
        }
        guard let buffer = pb else { return nil }

        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let ctx = CGContext(
            data: CVPixelBufferGetBaseAddress(buffer),
            width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                | CGBitmapInfo.byteOrder32Little.rawValue
        ) else { return nil }

        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let scale = min(Double(width) / Double(image.width),
                        Double(height) / Double(image.height))
        let w = Double(image.width) * scale
        let h = Double(image.height) * scale
        let rect = CGRect(x: (Double(width) - w) / 2, y: (Double(height) - h) / 2,
                          width: w, height: h)
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: rect)
        return buffer
    }

    enum ClipError: Error {
        case writerSetup
        case appendFailed
        case writerFailed
    }
}
