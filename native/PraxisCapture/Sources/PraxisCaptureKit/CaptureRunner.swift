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
    private let policy: NativePolicyChecking
    private var focus: FocusTimeline?
    private var input: InputTap?
    private var screen: ScreenCapture?
    private var audio: AudioCapture?
    private var clipboard: ClipboardCapture?
    private var axTimer: Timer?
    private var frameTimer: Timer?
    private var policyTimer: Timer?
    private var clipboardTimer: Timer?
    private var requestedAudioSystem = false
    private var requestedAudioMic = false

    public init(
        options: CaptureOptions = CaptureOptions(),
        policy: NativePolicyChecking = NativePolicyGate.fromEnvironment()
    ) {
        self.opts = options
        self.policy = policy
        self.requestedAudioSystem = options.audioSystem
        self.requestedAudioMic = options.audioMic
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

        let f = FocusTimeline(policy: policy); f.start(); focus = f
        let i = InputTap(policy: policy); i.start(); input = i
        let s = ScreenCapture(policy: policy); screen = s
        let c = ClipboardCapture(policy: policy); clipboard = c
        // Opt-in rolling clip ring (default OFF): only holds JPEG frames in a
        // bounded buffer; nothing is persisted until persistClip is called.
        if ProcessInfo.processInfo.environment["PRAXIS_CLIP_BUFFER"] == "1" { s.clipBuffer = ClipBuffer() }
        if opts.audioSystem || opts.audioMic {
            setAudio(system: opts.audioSystem, mic: opts.audioMic)
        }

        let scrape = opts.scrape
        axTimer = Timer.scheduledTimer(withTimeInterval: opts.axInterval, repeats: true) { _ in
            AXSnapshot.snapshotFocused(policy: self.policy)
            if scrape { ConversationScrape.scan(policy: self.policy) }
        }
        frameTimer = Timer.scheduledTimer(withTimeInterval: opts.frameInterval, repeats: true) { _ in
            if Permissions.screenRecordingAllowed() { s.captureOnce() }
        }
        // Reconcile long-lived audio taps and clip memory promptly after an
        // atomic policy transition, independent of the slower frame cadence.
        policyTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            self.reconcilePolicy()
        }
        clipboardTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            c.poll()
        }

        return PermissionState(accessibility: axOk, screenRecording: screenOk)
    }

    public func stop() {
        axTimer?.invalidate(); axTimer = nil
        frameTimer?.invalidate(); frameTimer = nil
        policyTimer?.invalidate(); policyTimer = nil
        clipboardTimer?.invalidate(); clipboardTimer = nil
        input?.stop(); input = nil
        focus?.stop(); focus = nil
        audio?.stop(); audio = nil
        clipboard = nil
        screen = nil
    }

    /// Toggle the audio taps live (the menu-bar app calls this without
    /// restarting capture). System audio rides the Screen Recording grant; the
    /// mic path requests its own permissions on first enable.
    public func setAudio(system: Bool, mic: Bool) {
        requestedAudioSystem = system
        requestedAudioMic = mic
        if system || mic {
            let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown"
            guard policy.decision(source: .audio, app: app, window: nil, at: Date()).allowed else {
                audio?.stop()
                return
            }
            if audio == nil {
                audio = AudioCapture(policy: policy)
                // Speech authorization is shared by both channels. MicTap owns
                // the microphone request so a pending/changed TCC decision can
                // be retried by the regular reconciliation loop.
                AudioCapture.requestPermissions(mic: false) { ok in
                    if !ok { log("audio: speech permission incomplete — transcripts may be unavailable") }
                }
            }
            audio?.set(system: system && Permissions.screenRecordingAllowed(), mic: mic)
        } else {
            audio?.stop(); audio = nil
        }
    }

    /// Flush the rolling clip ring (if enabled) to an mp4 blob + NDJSON event.
    /// No-op unless PRAXIS_CLIP_BUFFER=1 armed the buffer. Fire-and-forget:
    /// future trigger surfaces (hotkey, error rules, boardroom raise) call this.
    public func persistClip(reason: String) {
        let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown"
        guard policy.decision(source: .screenVideo, app: app, window: nil, at: Date()).allowed else {
            Task { [weak self] in await self?.screen?.clipBuffer?.clear() }
            return
        }
        Task { [weak self] in
            guard let self,
                  self.policy.decision(
                    source: .screenVideo, app: app, window: nil, at: Date()
                  ).allowed else { return }
            await self.screen?.clipBuffer?.persistClip(reason: reason)
        }
    }

    /// One-shot snapshot (smoke testing without a long-running loop).
    public func runOnce(output: FileHandle = .standardOutput) {
        Emitter.shared.output = output
        let screenOk = Permissions.screenRecordingAllowed()
        log("one-shot (accessibility=\(Permissions.accessibilityTrusted()), screenRecording=\(screenOk))")
        AXSnapshot.snapshotFocused(policy: policy)
        if opts.scrape { ConversationScrape.scan(policy: policy) }
        if screenOk { ScreenCapture(policy: policy).captureOnce() }
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
    }

    private func reconcilePolicy() {
        if requestedAudioSystem || requestedAudioMic {
            setAudio(system: requestedAudioSystem, mic: requestedAudioMic)
        }
        let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown"
        if !policy.decision(source: .screenVideo, app: app, window: nil, at: Date()).allowed {
            Task { [weak self] in await self?.screen?.clipBuffer?.clear() }
        }
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
