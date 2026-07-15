import AVFoundation
import AppKit
import Foundation
import ScreenCaptureKit
import Speech

/// Audio taps — the channel that closes the "perceptual why" gap for meetings
/// and media: who said what (mic) and what the machine played (system output).
///
/// Privacy stance, enforced structurally:
///   - OFF by default; each channel is a separate opt-in.
///   - Raw audio NEVER touches disk. Buffers live in memory only long enough to
///     run ON-DEVICE speech recognition; what's emitted is the transcript text
///     (`transcript_segment`) and coarse playback transitions (`playback_state`).
///   - Transcription is forced on-device (`requiresOnDeviceRecognition`) — no
///     audio or text leaves the machine through this path.
public final class AudioCapture: NSObject {
    private let policy: NativePolicyChecking
    private let onReadiness: (NativeSourceReadiness) -> Void
    private var systemTap: SystemAudioTap?
    private var micTap: MicTap?
    private let systemChunker: SpeechChunker
    private let micChunker: SpeechChunker

    public init(
        policy: NativePolicyChecking,
        onReadiness: @escaping (NativeSourceReadiness) -> Void = { _ in }
    ) {
        self.policy = policy
        self.onReadiness = onReadiness
        self.systemChunker = SpeechChunker(
            channel: "system", policy: policy, requiresScreenPolicy: true
        )
        self.micChunker = SpeechChunker(channel: "mic", policy: policy)
        super.init()
        // Warm the tracker from the main thread NOW — its first lazy touch
        // otherwise happens on the audio queue at speech onset, and the async
        // initial read loses the race, attributing the first span to "unknown".
        _ = FrontmostTracker.shared
    }

    /// Idempotently reconcile the running taps with the requested state.
    public func set(system: Bool, mic: Bool) {
        FrontmostTracker.shared.refresh()
        let front = FrontmostTracker.shared.context
        let allowed = policy.decision(
            source: .audio, app: front.app, window: front.window, at: Date()
        ).allowed
        // SCStream has no audio-only mode and necessarily produces a discarded
        // 2x2 video stream. Respect the local screen acquisition control too.
        let screenAllowed = policy.decision(
            source: .screenVideo, app: front.app, window: front.window, at: Date()
        ).allowed
        let enableSystem = system && allowed && screenAllowed
        let enableMic = mic && allowed
        // Disabling is synchronous at the chunk boundary: buffered audio and
        // in-flight transcription generations are invalidated before this
        // method returns, so a late recognizer callback cannot emit after opt-out.
        systemChunker.setEnabled(enableSystem)
        micChunker.setEnabled(enableMic)
        if enableSystem {
            if systemTap == nil {
                systemTap = SystemAudioTap(
                    chunker: systemChunker,
                    policy: policy,
                    onReadiness: onReadiness
                )
            }
            // Reconcile every policy tick. The tap owns single-flight and
            // bounded retry state, so a transient SCStream failure can recover.
            systemTap?.start()
        } else if let tap = systemTap {
            tap.stop(); systemTap = nil
            if system {
                onReadiness(NativeSourceReadiness(
                    channel: "audio_system", status: "unavailable",
                    reason: allowed ? "screen-capture-unavailable" : "capture-policy-blocked"
                ))
            }
        }
        if enableMic {
            if micTap == nil {
                micTap = MicTap(
                    chunker: micChunker,
                    policy: policy,
                    onReadiness: onReadiness
                )
            }
            // Reconcile on every policy tick. If the user grants Microphone
            // access while capture is already running, a previously blocked
            // tap can recover without restarting the app.
            micTap?.start()
        } else if !enableMic, let tap = micTap {
            tap.stop(); micTap = nil
            if mic {
                onReadiness(NativeSourceReadiness(
                    channel: "audio_mic", status: "unavailable",
                    reason: "capture-policy-blocked"
                ))
            }
        }
    }

    public func stop() { set(system: false, mic: false) }

    /// Ask for the audio permissions. Speech recognition is always needed for
    /// transcripts; the microphone prompt fires ONLY when the mic channel is
    /// requested (system-audio-only must never trigger a mic prompt). Safe to
    /// call repeatedly; prompts only fire while a state is .notDetermined.
    public static func requestPermissions(mic: Bool, completion: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { speech in
            guard mic else {
                log("audio permissions: speech=\(speech == .authorized)")
                completion(speech == .authorized)
                return
            }
            AVCaptureDevice.requestAccess(for: .audio) { micOk in
                log("audio permissions: speech=\(speech == .authorized) mic=\(micOk)")
                completion(speech == .authorized && micOk)
            }
        }
    }
}

// MARK: - Frontmost-app attribution

/// Audio has no window of its own; segments are attributed to the frontmost app
/// at the time the speech STARTED (a meeting stays attributed to Zoom even if
/// the user glances at Notes mid-sentence).
final class FrontmostTracker {
    static let shared = FrontmostTracker()
    private let lock = NSLock()
    private var name = "unknown"
    private var window = "unknown"

    private init() {
        if Thread.isMainThread {
            update()
        } else {
            DispatchQueue.main.async { self.update() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main
        ) { [weak self] _ in self?.update() }
    }

    private func update() {
        let app = NSWorkspace.shared.frontmostApplication
        let n = app?.localizedName ?? "unknown"
        let w = app.flatMap { AXSnapshot.frontWindowTitle(pid: $0.processIdentifier) } ?? n
        lock.lock(); name = n; window = w; lock.unlock()
    }

    func refresh() {
        if Thread.isMainThread { update() }
        else { DispatchQueue.main.async { self.update() } }
    }

    var current: String {
        lock.lock(); defer { lock.unlock() }
        return name
    }

    var context: (app: String, window: String) {
        lock.lock(); defer { lock.unlock() }
        return (name, window)
    }
}

// MARK: - VAD-gated chunking + on-device transcription

/// Accumulates PCM while sound is present; a stretch of silence (or a max span)
/// flushes the chunk through on-device speech recognition and emits the final
/// text. Batching on silence gives natural segment boundaries, and the
/// recognizer runs only when something was actually said — zero idle cost.
final class SpeechChunker {
    let channel: String
    private let policy: NativePolicyChecking
    private let requiresScreenPolicy: Bool
    private let queue: DispatchQueue
    /// RMS below this is silence. Tuned for normalized float PCM.
    private let silenceRMS: Float = 0.012
    private let flushSilenceSec = 1.4
    private let maxSpanSec = 25.0

    private var buffers: [AVAudioPCMBuffer] = []
    private var spanSec = 0.0
    private var silentSec = 0.0
    private var spanApp = "unknown"
    private var spanWindow = "unknown"
    private var emittedPlaying = false
    private var enabled = false
    private var generation: UInt64 = 0

    init(
        channel: String,
        policy: NativePolicyChecking,
        requiresScreenPolicy: Bool = false
    ) {
        self.channel = channel
        self.policy = policy
        self.requiresScreenPolicy = requiresScreenPolicy
        self.queue = DispatchQueue(label: "praxis.audio.\(channel)")
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        queue.async { self.appendLocked(buffer) }
    }

    /// Called from CaptureRunner's main-thread reconciliation path.
    /// Synchronous disable is deliberate: no buffered audio survives opt-out.
    func setEnabled(_ value: Bool) {
        queue.sync {
            guard self.enabled != value else { return }
            self.enabled = value
            self.generation &+= 1
            if !value { self.resetLocked() }
        }
    }

    func discard() {
        queue.sync {
            self.generation &+= 1
            self.resetLocked()
        }
    }

    private func resetLocked() {
        buffers = []
        spanSec = 0
        silentSec = 0
        emittedPlaying = false
    }

    private func appendLocked(_ buffer: AVAudioPCMBuffer) {
        guard enabled else { return }
        let front = FrontmostTracker.shared.context
        guard policyAllows(app: front.app, window: front.window) else {
            generation &+= 1
            resetLocked()
            return
        }
        let dur = Double(buffer.frameLength) / buffer.format.sampleRate
        let rms = AudioCaptureMath.rms(buffer)
        let audible = rms > silenceRMS

        // Coarse playback-state transitions are cheap, factual evidence of WHEN
        // sound was present. Hysteresis, not raw VAD: onset emits immediately,
        // but "stopped" waits out flushSilenceSec — otherwise the RMS dip
        // between two words emits a flicker of transitions per sentence.
        if audible && !emittedPlaying {
            emittedPlaying = true
            emitPlayback(true, level: rms)
        }

        if audible {
            if buffers.isEmpty {
                let front = FrontmostTracker.shared.context
                spanApp = front.app
                spanWindow = front.window
            }
            buffers.append(buffer)
            spanSec += dur
            silentSec = 0
            if spanSec >= maxSpanSec { flushLocked() }
        } else if !buffers.isEmpty {
            silentSec += dur
            buffers.append(buffer) // trailing context helps the recognizer
            spanSec += dur
            if silentSec >= flushSilenceSec {
                flushLocked()
                if emittedPlaying {
                    emittedPlaying = false
                    emitPlayback(false, level: rms)
                }
            }
        }
    }

    private func emitPlayback(_ playing: Bool, level: Float) {
        let front = FrontmostTracker.shared.context
        guard policyAllows(app: front.app, window: front.window) else { return }
        Emitter.shared.emit(
            source: "audio", app: front.app,
            window: channel, type: "playback_state",
            payload: ["channel": channel, "playing": playing,
                      "level": Double(round(level * 1000) / 1000)]
        )
    }

    private func flushLocked() {
        let chunk = buffers
        let app = spanApp
        let window = spanWindow
        let chunkGeneration = generation
        buffers = []; spanSec = 0; silentSec = 0
        guard !chunk.isEmpty else { return }
        Transcriber.shared.transcribe(chunk) { [channel] text, confidence, lang in
            self.queue.async {
                guard self.enabled, self.generation == chunkGeneration,
                      let text, !text.isEmpty else { return }
                guard self.policyAllows(app: app, window: window) else { return }
                Emitter.shared.emit(
                    source: "audio", app: app, window: channel,
                    type: "transcript_segment",
                    payload: ["channel": channel, "text": text,
                              "conf": Double(round(confidence * 100) / 100),
                              "lang": lang ?? "unknown"]
                )
            }
        }
    }

    private func policyAllows(app: String, window: String) -> Bool {
        let now = Date()
        guard policy.decision(
            source: .audio, app: app, window: window, at: now
        ).allowed else { return false }
        return !requiresScreenPolicy || policy.decision(
            source: .screenVideo, app: app, window: window, at: now
        ).allowed
    }
}

/// On-device recognition. SFSpeechRecognizer is the floor (macOS 10.15+); it is
/// forced on-device so nothing leaves the machine. Locale model availability
/// varies — when on-device isn't supported we emit nothing rather than fall
/// back to Apple's servers.
///
/// Multilingual: one SFSpeechRecognizer understands ONE locale, so each chunk
/// RACES every on-device-capable candidate (system locale, English, Mandarin)
/// and the most confident reading wins — a wrong-language model produces
/// low-confidence gibberish, so confidence is a reliable language detector.
/// Candidates only become available once their dictation model is installed
/// (System Settings → Keyboard → Dictation).
final class Transcriber {
    static let shared = Transcriber()
    private let recognizers: [SFSpeechRecognizer]

    private init() {
        var seen = Set<String>()
        var found: [SFSpeechRecognizer] = []
        for id in [Locale.current.identifier, "en-US", "zh-CN"] {
            let norm = Locale(identifier: id).identifier(.bcp47)
            guard !seen.contains(norm) else { continue }
            seen.insert(norm)
            if let r = SFSpeechRecognizer(locale: Locale(identifier: id)),
               r.supportsOnDeviceRecognition {
                found.append(r)
            } else {
                log("audio: no on-device speech model for \(norm) — add it under System Settings → Keyboard → Dictation to transcribe that language")
            }
        }
        recognizers = found
        if found.isEmpty {
            log("audio: no on-device speech model at all — transcripts disabled (playback_state still emitted)")
        } else {
            log("audio: transcribing locales: \(found.map { $0.locale.identifier(.bcp47) }.joined(separator: ", "))")
        }
    }

    func transcribe(_ chunk: [AVAudioPCMBuffer],
                    done: @escaping (String?, Float, String?) -> Void) {
        guard !recognizers.isEmpty,
              SFSpeechRecognizer.authorizationStatus() == .authorized else {
            done(nil, 0, nil)
            return
        }
        let group = DispatchGroup()
        var results: [(text: String, conf: Float, lang: String)] = []
        let lock = NSLock()

        for recognizer in recognizers {
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.requiresOnDeviceRecognition = true
            request.shouldReportPartialResults = false
            for b in chunk { request.append(b) }
            request.endAudio()
            group.enter()
            var finished = false
            recognizer.recognitionTask(with: request) { result, error in
                if let error, result == nil {
                    // Silence/noise chunks error out — only log real failures.
                    let msg = error.localizedDescription
                    if !msg.localizedCaseInsensitiveContains("no speech") {
                        log("audio: recognition failed (\(recognizer.locale.identifier)): \(msg)")
                    }
                    if !finished { finished = true; group.leave() }
                    return
                }
                guard let result, result.isFinal else { return }
                let t = result.bestTranscription
                let confs = t.segments.map { $0.confidence }
                let avg = confs.isEmpty ? 0 : confs.reduce(0, +) / Float(confs.count)
                if !t.formattedString.isEmpty {
                    lock.lock()
                    results.append((t.formattedString, avg,
                                    recognizer.locale.identifier(.bcp47)))
                    lock.unlock()
                }
                if !finished { finished = true; group.leave() }
            }
        }

        group.notify(queue: .global(qos: .utility)) {
            // Highest confidence wins; longer text breaks ties (a wrong-language
            // model often recognizes only a fragment).
            let best = results.max {
                ($0.conf, $0.text.count) < ($1.conf, $1.text.count)
            }
            done(best?.text, best?.conf ?? 0, best?.lang)
        }
    }
}

// MARK: - System-output tap (ScreenCaptureKit)

/// Captures what the Mac is PLAYING via SCStream's audio output. Rides the same
/// Screen Recording TCC grant the frame tap already holds. Video is configured
/// to the minimum the API allows and its frames are discarded unread.
final class SystemAudioTap: NSObject, SCStreamOutput, SCStreamDelegate {
    private let chunker: SpeechChunker
    private let policy: NativePolicyChecking
    private let onReadiness: (NativeSourceReadiness) -> Void
    private let stateLock = NSLock()
    private var lifecycle = AudioTapLifecycle()
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "praxis.audio.scstream")

    init(
        chunker: SpeechChunker,
        policy: NativePolicyChecking,
        onReadiness: @escaping (NativeSourceReadiness) -> Void
    ) {
        self.chunker = chunker
        self.policy = policy
        self.onReadiness = onReadiness
        super.init()
    }

    func start() {
        guard policyAllowsStart() else { return }
        stateLock.lock()
        let token = lifecycle.requestStart(now: Date.timeIntervalSinceReferenceDate)
        stateLock.unlock()
        guard let token else { return }
        onReadiness(NativeSourceReadiness(
            channel: "audio_system", status: "unavailable", reason: "tap-starting"
        ))
        Task { [weak self] in await self?.startStream(token: token) }
    }

    func stop() {
        stateLock.lock()
        lifecycle.cancel()
        let activeStream = stream
        stream = nil
        stateLock.unlock()
        chunker.discard()
        let s = activeStream
        Task { try? await s?.stopCapture() }
        log("audio: system-output tap stopped")
    }

    private func startStream(token: UInt64) async {
        do {
            let content = try await SCShareableContent.current
            guard startIsCurrent(token) else { return }
            guard let display = content.displays.first else {
                failStart(token, reason: "no-display")
                return
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.sampleRate = 48_000
            config.channelCount = 1
            // Minimal video: SCStream requires a video config, but nothing
            // reads these frames — the real screen tap stays on its own timer.
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            let candidate = SCStream(filter: filter, configuration: config, delegate: self)
            try candidate.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
            // SCStream has no audio-only mode; without a registered .screen
            // output it logs a dropped-frame error PER FRAME. Register one
            // and discard its frames.
            try candidate.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            guard startIsCurrent(token) else { return }
            guard policyAllowsStart() else {
                failStart(token, reason: "capture-policy-blocked")
                return
            }
            try await candidate.startCapture()
            guard policyAllowsStart() else {
                try? await candidate.stopCapture()
                failStart(token, reason: "capture-policy-blocked")
                return
            }

            // Stream installation and desired-state completion share one lock
            // with stop(). Either stop takes the candidate, or this stale task
            // rejects it and shuts it down; there is no orphan window.
            let accepted = installStartedStream(candidate, token: token)
            guard accepted else {
                try? await candidate.stopCapture()
                return
            }
            onReadiness(NativeSourceReadiness(
                channel: "audio_system", status: "ready", reason: nil
            ))
            log("audio: system-output tap started")
        } catch {
            failStart(token, reason: "tap-start-failed")
            log("audio: system tap failed to start: \(error)")
        }
    }

    private func startIsCurrent(_ token: UInt64) -> Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        return lifecycle.acceptsStart(token)
    }

    private func installStartedStream(_ candidate: SCStream, token: UInt64) -> Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        let accepted = lifecycle.completeStart(
            token, succeeded: true, now: Date.timeIntervalSinceReferenceDate
        )
        if accepted { stream = candidate }
        return accepted
    }

    private func failStart(_ token: UInt64, reason: String) {
        stateLock.lock()
        let current = lifecycle.acceptsStart(token)
        if current {
            lifecycle.completeStart(
                token, succeeded: false, now: Date.timeIntervalSinceReferenceDate
            )
        }
        stateLock.unlock()
        if current {
            onReadiness(NativeSourceReadiness(
                channel: "audio_system", status: "unavailable", reason: reason
            ))
        }
    }

    private func policyAllowsStart() -> Bool {
        let front = FrontmostTracker.shared.context
        return policy.decision(
            source: .audio, app: front.app, window: front.window, at: Date()
        ).allowed && policy.decision(
            source: .screenVideo, app: front.app, window: front.window, at: Date()
        ).allowed
    }

    private func streamIsActive(_ candidate: SCStream) -> Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        return lifecycle.running && stream === candidate
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard streamIsActive(stream), policyAllowsStart(),
              type == .audio, sampleBuffer.isValid,
              let pcm = AudioCaptureMath.pcmBuffer(from: sampleBuffer) else { return }
        chunker.append(pcm)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("audio: system tap stopped with error: \(error)")
        stateLock.lock()
        let wasActive = self.stream === stream && lifecycle.running
        if wasActive {
            self.stream = nil
            lifecycle.stoppedUnexpectedly(now: Date.timeIntervalSinceReferenceDate)
        }
        stateLock.unlock()
        if wasActive {
            chunker.discard()
            onReadiness(NativeSourceReadiness(
                channel: "audio_system", status: "unavailable", reason: "tap-stopped"
            ))
        }
    }
}

// MARK: - Microphone tap (AVAudioEngine)

final class MicTap {
    private let chunker: SpeechChunker
    private let policy: NativePolicyChecking
    private let onReadiness: (NativeSourceReadiness) -> Void
    private var engine: AVAudioEngine?
    private var lifecycle = AudioTapLifecycle()
    private var lastReportedAuthorization: AVAuthorizationStatus?

    init(
        chunker: SpeechChunker,
        policy: NativePolicyChecking,
        onReadiness: @escaping (NativeSourceReadiness) -> Void
    ) {
        self.chunker = chunker
        self.policy = policy
        self.onReadiness = onReadiness
    }

    func start() {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.start() }
            return
        }
        if let existing = engine, !existing.isRunning {
            existing.inputNode.removeTap(onBus: 0)
            existing.stop()
            engine = nil
            lifecycle.stoppedUnexpectedly(now: Date.timeIntervalSinceReferenceDate)
            chunker.discard()
            onReadiness(NativeSourceReadiness(
                channel: "audio_mic", status: "unavailable", reason: "tap-stopped"
            ))
        }
        guard engine == nil,
              let token = lifecycle.requestStart(now: Date.timeIntervalSinceReferenceDate)
        else { return }
        onReadiness(NativeSourceReadiness(
            channel: "audio_mic", status: "unavailable", reason: "tap-starting"
        ))

        let authorization = AVCaptureDevice.authorizationStatus(for: .audio)
        switch authorization {
        case .authorized:
            lastReportedAuthorization = nil
            startEngine(token: token)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    guard self.lifecycle.acceptsStart(token) else { return }
                    if granted {
                        self.startEngine(token: token)
                    } else {
                        self.reportBlockedAuthorization(.denied)
                        self.failStart(token: token, status: "blocked",
                                       reason: "microphone-permission-denied")
                    }
                }
            }
        case .denied, .restricted:
            reportBlockedAuthorization(authorization)
            failStart(
                token: token,
                status: "blocked",
                reason: "microphone-permission-\(Permissions.microphoneAuthorization())"
            )
        @unknown default:
            reportBlockedAuthorization(authorization)
            failStart(token: token, status: "blocked", reason: "microphone-permission-unknown")
        }
    }

    private func startEngine(token: UInt64) {
        guard lifecycle.acceptsStart(token), engine == nil else { return }
        let front = FrontmostTracker.shared.context
        guard policy.decision(
            source: .audio, app: front.app, window: front.window, at: Date()
        ).allowed else {
            failStart(token: token, status: "unavailable", reason: "capture-policy-blocked")
            return
        }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else {
            failStart(token: token, status: "unavailable", reason: "no-usable-input")
            log("audio: no usable mic input format")
            return
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            // The engine reuses the tap buffer after the block returns; copy
            // before the chunker holds it across its async queue.
            guard let self else { return }
            let front = FrontmostTracker.shared.context
            guard self.policy.decision(
                source: .audio, app: front.app, window: front.window, at: Date()
            ).allowed else { return }
            guard let copy = AudioCaptureMath.copy(buffer) else { return }
            self.chunker.append(copy)
        }
        do {
            try engine.start()
            guard lifecycle.completeStart(
                token, succeeded: true, now: Date.timeIntervalSinceReferenceDate
            ) else {
                input.removeTap(onBus: 0)
                engine.stop()
                return
            }
            self.engine = engine
            onReadiness(NativeSourceReadiness(
                channel: "audio_mic", status: "ready", reason: nil
            ))
            log("audio: microphone tap started")
        } catch {
            input.removeTap(onBus: 0)
            failStart(token: token, status: "unavailable", reason: "tap-start-failed")
            log("audio: mic engine failed: \(error)")
        }
    }

    func stop() {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.stop() }
            return
        }
        lifecycle.cancel()
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        chunker.discard()
        log("audio: microphone tap stopped")
    }

    private func failStart(token: UInt64, status: String, reason: String) {
        guard lifecycle.acceptsStart(token) else { return }
        lifecycle.completeStart(
            token, succeeded: false, now: Date.timeIntervalSinceReferenceDate
        )
        onReadiness(NativeSourceReadiness(
            channel: "audio_mic", status: status, reason: reason
        ))
    }

    private func reportBlockedAuthorization(_ authorization: AVAuthorizationStatus) {
        guard lastReportedAuthorization != authorization else { return }
        lastReportedAuthorization = authorization
        log("audio: microphone permission \(Permissions.microphoneAuthorization())")
    }
}

// MARK: - Buffer math

enum AudioCaptureMath {
    /// CMSampleBuffer (SCStream audio) → AVAudioPCMBuffer. DEEP COPY on purpose:
    /// the sample buffer's memory is only valid inside the stream handler, and
    /// the chunker holds buffers for seconds before transcription.
    static func pcmBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let desc = sampleBuffer.formatDescription else { return nil }
        let format = AVAudioFormat(cmAudioFormatDescription: desc)
        let frames = AVAudioFrameCount(sampleBuffer.numSamples)
        guard frames > 0,
              let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        pcm.frameLength = frames
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer, at: 0, frameCount: Int32(frames), into: pcm.mutableAudioBufferList)
        return status == noErr ? pcm : nil
    }

    /// Deep copy for buffers whose memory the producer reuses (mic tap).
    static func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard buffer.frameLength > 0,
              let out = AVAudioPCMBuffer(pcmFormat: buffer.format,
                                         frameCapacity: buffer.frameLength) else { return nil }
        out.frameLength = buffer.frameLength
        let src = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let dst = UnsafeMutableAudioBufferListPointer(out.mutableAudioBufferList)
        for i in 0..<min(src.count, dst.count) {
            guard let s = src[i].mData, let d = dst[i].mData else { continue }
            let bytes = min(src[i].mDataByteSize, dst[i].mDataByteSize)
            memcpy(d, s, Int(bytes))
            dst[i].mDataByteSize = bytes
        }
        return out
    }

    static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return 0 }
        if let data = buffer.floatChannelData {
            var sum: Float = 0
            let samples = data[0]
            for i in 0..<frames { sum += samples[i] * samples[i] }
            return sqrt(sum / Float(frames))
        }
        if let data = buffer.int16ChannelData {
            var sum: Float = 0
            let samples = data[0]
            for i in 0..<frames {
                let v = Float(samples[i]) / Float(Int16.max)
                sum += v * v
            }
            return sqrt(sum / Float(frames))
        }
        return 0
    }
}
