import Foundation
import AppKit

/// Configuration for a capture session.
public struct CaptureOptions {
    public var frameInterval: Double
    public var axInterval: Double
    public var scrape: Bool
    /// Whether to fire the Screen-Recording system prompt when not yet granted.
    public var promptForScreen: Bool
    /// Audio is privacy-sensitive: each channel is a separate opt-in, both OFF
    /// by default. Only on-device transcripts are emitted — never raw audio.
    public var audioSystem: Bool
    public var audioMic: Bool

    public init(frameInterval: Double = 3.0, axInterval: Double = 2.0,
                scrape: Bool = true, promptForScreen: Bool = true,
                audioSystem: Bool = false, audioMic: Bool = false) {
        self.frameInterval = frameInterval
        self.axInterval = axInterval
        self.scrape = scrape
        self.promptForScreen = promptForScreen
        self.audioSystem = audioSystem
        self.audioMic = audioMic
    }
}

public struct PermissionState {
    public let accessibility: Bool
    public let screenRecording: Bool
}

/// Runs the focus / input / accessibility / screen taps and emits NDJSON.
///
/// The whole point of this being a library: the menu-bar app links it and calls
/// `start` IN-PROCESS, so the binary the user granted (Praxis.app) is the one
/// making the ScreenCaptureKit / CGEventTap / Accessibility calls. Ad-hoc-signed
/// nested helper binaries do NOT inherit the app's TCC grant, so running capture
/// as a child process never sees the permissions.
public final class CaptureRunner {
    private let opts: CaptureOptions
    private var focus: FocusTimeline?
    private var input: InputTap?
    private var screen: ScreenCapture?
    private var audio: AudioCapture?
    private var axTimer: Timer?
    private var frameTimer: Timer?

    public init(options: CaptureOptions = CaptureOptions()) {
        self.opts = options
    }

    /// Start the taps on the CURRENT run loop, emitting NDJSON to `output`.
    /// Returns the permission state observed at startup.
    @discardableResult
    public func start(output: FileHandle = .standardOutput) -> PermissionState {
        Emitter.shared.output = output

        let axOk = Permissions.accessibilityTrusted()
        let screenOk = Permissions.screenRecordingAllowed()
        log("starting (accessibility=\(axOk), screenRecording=\(screenOk))")
        if !axOk {
            log("Accessibility not granted — focus/input/AX limited.")
        }
        if !screenOk {
            if opts.promptForScreen { Permissions.requestScreenRecording() }
            log("Screen Recording not granted — frames disabled until granted.")
        }

        let f = FocusTimeline(); f.start(); focus = f
        let i = InputTap(); i.start(); input = i
        let s = ScreenCapture(); screen = s
        if opts.audioSystem || opts.audioMic {
            setAudio(system: opts.audioSystem, mic: opts.audioMic)
        }

        let scrape = opts.scrape
        axTimer = Timer.scheduledTimer(withTimeInterval: opts.axInterval, repeats: true) { _ in
            AXSnapshot.snapshotFocused()
            if scrape { ConversationScrape.scan() }
        }
        frameTimer = Timer.scheduledTimer(withTimeInterval: opts.frameInterval, repeats: true) { _ in
            if Permissions.screenRecordingAllowed() { s.captureOnce() }
        }

        return PermissionState(accessibility: axOk, screenRecording: screenOk)
    }

    public func stop() {
        axTimer?.invalidate(); axTimer = nil
        frameTimer?.invalidate(); frameTimer = nil
        input?.stop(); input = nil
        focus?.stop(); focus = nil
        audio?.stop(); audio = nil
        screen = nil
    }

    /// Toggle the audio taps live (the menu-bar app calls this without
    /// restarting capture). System audio rides the Screen Recording grant; the
    /// mic path requests its own permissions on first enable.
    public func setAudio(system: Bool, mic: Bool) {
        if system || mic {
            if audio == nil { audio = AudioCapture() }
            AudioCapture.requestPermissions(mic: mic) { ok in
                if !ok { log("audio: speech/mic permission incomplete — transcripts may be unavailable") }
            }
            audio?.set(system: system && Permissions.screenRecordingAllowed(), mic: mic)
        } else {
            audio?.stop(); audio = nil
        }
    }

    /// One-shot snapshot (smoke testing without a long-running loop).
    public func runOnce(output: FileHandle = .standardOutput) {
        Emitter.shared.output = output
        let screenOk = Permissions.screenRecordingAllowed()
        log("one-shot (accessibility=\(Permissions.accessibilityTrusted()), screenRecording=\(screenOk))")
        AXSnapshot.snapshotFocused()
        if opts.scrape { ConversationScrape.scan() }
        if screenOk { ScreenCapture().captureOnce() }
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
    }

    /// Verify the Vision OCR path on a rendered image — needs no permissions.
    /// Returns true if text was recognized.
    @discardableResult
    public static func selftestOCR() -> Bool {
        let sample = "submitted message how are we achieving exact action reconstruction"
        guard let img = renderTextImage(sample) else { log("render failed"); return false }
        let lines = OCR.recognize(img)
        log("OCR self-test input:  \(sample)")
        log("OCR self-test output: \(lines.joined(separator: " | "))")
        if let data = pngData(img) {
            let blob = Emitter.shared.writeBlob(data, kind: "image", ext: "png")
            Emitter.shared.emit(
                source: "screen_video", app: "selftest", window: "selftest", type: "frame",
                payload: ["ocrText": lines.joined(separator: "\n"), "w": 720, "h": 140],
                blobFiles: blob.map { [$0] }
            )
        }
        return !lines.isEmpty
    }
}
