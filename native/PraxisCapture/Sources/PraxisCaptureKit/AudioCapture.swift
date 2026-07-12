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
    private var systemTap: SystemAudioTap?
    private var micTap: MicTap?
    private let systemChunker: SpeechChunker
    private let micChunker: SpeechChunker

    public init(policy: NativePolicyChecking) {
        self.policy = policy
        self.systemChunker = SpeechChunker(channel: "system", policy: policy)
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
        if !allowed {
            systemChunker.discard()
            micChunker.discard()
        }
        if enableSystem, systemTap == nil {
            let tap = SystemAudioTap(chunker: systemChunker, policy: policy)
            systemTap = tap
            tap.start()
        } else if !enableSystem, let tap = systemTap {
            tap.stop(); systemTap = nil
        }
        if enableMic, micTap == nil {
            let tap = MicTap(chunker: micChunker, policy: policy)
            micTap = tap
            tap.start()
        } else if !enableMic, let tap = micTap {
            tap.stop(); micTap = nil
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

    init(channel: String, policy: NativePolicyChecking) {
        self.channel = channel
        self.policy = policy
        self.queue = DispatchQueue(label: "praxis.audio.\(channel)")
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        queue.async { self.appendLocked(buffer) }
    }

    func discard() {
        queue.async {
            self.buffers = []
            self.spanSec = 0
            self.silentSec = 0
            self.emittedPlaying = false
        }
    }

    private func appendLocked(_ buffer: AVAudioPCMBuffer) {
        let front = FrontmostTracker.shared.context
        guard policy.decision(
            source: .audio, app: front.app, window: front.window, at: Date()
        ).allowed else {
            buffers = []; spanSec = 0; silentSec = 0; emittedPlaying = false
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
        guard policy.decision(
            source: .audio, app: front.app, window: front.window, at: Date()
        ).allowed else { return }
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
        buffers = []; spanSec = 0; silentSec = 0
        guard !chunk.isEmpty else { return }
        Transcriber.shared.transcribe(chunk) { [channel] text, confidence, lang in
            guard let text, !text.isEmpty else { return }
            guard self.policy.decision(
                source: .audio, app: app, window: window, at: Date()
            ).allowed else { return }
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
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "praxis.audio.scstream")

    init(chunker: SpeechChunker, policy: NativePolicyChecking) {
        self.chunker = chunker
        self.policy = policy
        super.init()
    }

    func start() {
        let front = FrontmostTracker.shared.context
        guard policy.decision(
            source: .audio, app: front.app, window: front.window, at: Date()
        ).allowed,
        policy.decision(
            source: .screenVideo, app: front.app, window: front.window, at: Date()
        ).allowed else { return }
        Task {
            do {
                let content = try await SCShareableContent.current
                guard let display = content.displays.first else {
                    log("audio: no display for system tap"); return
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
                let s = SCStream(filter: filter, configuration: config, delegate: self)
                try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
                // SCStream has no audio-only mode; without a registered .screen
                // output it logs a dropped-frame error PER FRAME. Register one
                // and discard its frames.
                try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
                let current = FrontmostTracker.shared.context
                guard self.policy.decision(
                    source: .audio, app: current.app, window: current.window, at: Date()
                ).allowed,
                self.policy.decision(
                    source: .screenVideo, app: current.app, window: current.window, at: Date()
                ).allowed else { return }
                try await s.startCapture()
                stream = s
                log("audio: system-output tap started")
            } catch {
                log("audio: system tap failed to start: \(error)")
            }
        }
    }

    func stop() {
        let s = stream
        stream = nil
        Task { try? await s?.stopCapture() }
        log("audio: system-output tap stopped")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        let front = FrontmostTracker.shared.context
        guard policy.decision(
                source: .audio, app: front.app, window: front.window, at: Date()
              ).allowed,
              type == .audio, sampleBuffer.isValid,
              let pcm = AudioCaptureMath.pcmBuffer(from: sampleBuffer) else { return }
        chunker.append(pcm)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("audio: system tap stopped with error: \(error)")
        self.stream = nil
    }
}

// MARK: - Microphone tap (AVAudioEngine)

final class MicTap {
    private let chunker: SpeechChunker
    private let policy: NativePolicyChecking
    private var engine: AVAudioEngine?

    init(chunker: SpeechChunker, policy: NativePolicyChecking) {
        self.chunker = chunker
        self.policy = policy
    }

    func start() {
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            guard granted else { log("audio: microphone not granted"); return }
            DispatchQueue.main.async { self?.startEngine() }
        }
    }

    private func startEngine() {
        let front = FrontmostTracker.shared.context
        guard policy.decision(
            source: .audio, app: front.app, window: front.window, at: Date()
        ).allowed else { return }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else {
            log("audio: no usable mic input format"); return
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
            self.engine = engine
            log("audio: microphone tap started")
        } catch {
            log("audio: mic engine failed: \(error)")
        }
    }

    func stop() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        log("audio: microphone tap stopped")
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
