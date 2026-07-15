import Foundation
import CoreGraphics
import PraxisCaptureKit

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    precondition(condition(), "PraxisCaptureKit self-test failed: \(message)")
}

private func frame(_ ts: TimeInterval, byte: UInt8 = 0) -> ClipFrame {
    ClipFrame(data: Data([byte]), ts: ts)
}

var ring = ClipRing(capacity: 3)
for i in 0..<5 { ring.append(frame(Double(i))) }
expect(ring.orderedFrames.map(\.ts) == [2, 3, 4], "capacity keeps newest frames")
expect(ring.durationSeconds == 2, "duration uses oldest/newest timestamps")

var sparse = ClipRing(capacity: 360)
for i in 0...100 { sparse.append(frame(Double(i * 3))) }
sparse.removeFrames(olderThan: 210)
expect(sparse.orderedFrames.first?.ts == 210, "wall-clock trim removes old frames")
expect(sparse.orderedFrames.last?.ts == 300, "wall-clock trim retains newest frame")
expect(sparse.durationSeconds == 90, "sparse capture is bounded to 90 seconds")

let normalized = ClipMath.normalizeTimestamps([5, 5, 4, 6], minStep: 0.001)
expect(normalized.count == 4, "timestamp normalization preserves frame count")
for i in 1..<normalized.count {
    expect(normalized[i] > normalized[i - 1], "timestamps are strictly increasing")
}
expect(ClipMath.evenDimension(1921) == 1920, "odd video dimensions round down")

print("ClipRing self-test passed")

// MARK: - Native blob filesystem security

let blobFM = FileManager.default
let blobSecurityRoot = blobFM.temporaryDirectory
    .appendingPathComponent("praxis-blob-security-\(UUID().uuidString)")
let secureBlobDirectory = blobSecurityRoot.appendingPathComponent("praxis-frames")
defer { try? blobFM.removeItem(at: blobSecurityRoot) }
try! NativeBlobFileSecurity.prepareDirectory(at: secureBlobDirectory)
let directoryMode = (try! blobFM.attributesOfItem(atPath: secureBlobDirectory.path)[.posixPermissions]
    as! NSNumber).intValue
expect(directoryMode & 0o077 == 0, "native blob directory is owner-only")

let secureBlobURL = secureBlobDirectory
    .appendingPathComponent("12345678-1234-4234-8234-123456789ABC.png")
try! NativeBlobFileSecurity.atomicWrite(Data("private pixels".utf8), to: secureBlobURL)
let blobMode = (try! blobFM.attributesOfItem(atPath: secureBlobURL.path)[.posixPermissions]
    as! NSNumber).intValue
expect(blobMode & 0o077 == 0, "published native blob is owner-only")
expect((try! Data(contentsOf: secureBlobURL)) == Data("private pixels".utf8),
       "atomic native blob publication preserves bytes")

// Each writer needs its own staging pathname. Screen, audio, and clip producers
// can publish concurrently; a shared staging file would make one publication
// steal or delete another writer's bytes.
let concurrentWriteCount = 32
let concurrentWriteLock = NSLock()
var concurrentWriteFailures: [String] = []
let concurrentBlobURLs = (0..<concurrentWriteCount).map { index in
    secureBlobDirectory.appendingPathComponent(
        String(format: "%08X-1234-4234-8234-%012X.png", index + 1, index + 1)
    )
}
DispatchQueue.concurrentPerform(iterations: concurrentWriteCount) { index in
    let expected = Data("concurrent-private-pixels-\(index)".utf8)
    do {
        try NativeBlobFileSecurity.atomicWrite(expected, to: concurrentBlobURLs[index])
        let actual = try Data(contentsOf: concurrentBlobURLs[index])
        if actual != expected {
            concurrentWriteLock.lock()
            concurrentWriteFailures.append("writer \(index) published another writer's bytes")
            concurrentWriteLock.unlock()
        }
    } catch {
        concurrentWriteLock.lock()
        concurrentWriteFailures.append("writer \(index): \(error)")
        concurrentWriteLock.unlock()
    }
}
expect(concurrentWriteFailures.isEmpty,
       "concurrent native blob publications remain isolated: \(concurrentWriteFailures)")
let stagingArtifacts = try! blobFM.contentsOfDirectory(
    at: secureBlobDirectory,
    includingPropertiesForKeys: nil
).filter { $0.lastPathComponent.hasPrefix(".praxis-") }
expect(stagingArtifacts.isEmpty, "concurrent native blob publications leave no staging files")

let staleBlobURL = secureBlobDirectory
    .appendingPathComponent("ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF.txt")
try! NativeBlobFileSecurity.atomicWrite(Data("stale".utf8), to: staleBlobURL)
try! blobFM.setAttributes(
    [.modificationDate: Date(timeIntervalSinceNow: -48 * 60 * 60)],
    ofItemAtPath: staleBlobURL.path
)
let outsideTarget = blobSecurityRoot.appendingPathComponent("must-survive.txt")
try! Data("keep".utf8).write(to: outsideTarget)
try! blobFM.setAttributes(
    [.modificationDate: Date(timeIntervalSinceNow: -48 * 60 * 60)],
    ofItemAtPath: outsideTarget.path
)
let linkedBlobURL = secureBlobDirectory
    .appendingPathComponent("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.txt")
let symlinkBlobURL = secureBlobDirectory
    .appendingPathComponent("BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB.txt")
try! blobFM.linkItem(at: outsideTarget, to: linkedBlobURL)
try! blobFM.createSymbolicLink(at: symlinkBlobURL, withDestinationURL: outsideTarget)
let staleRemoved = try! NativeBlobFileSecurity.removeStaleOwnedBlobs(
    in: secureBlobDirectory,
    olderThan: 24 * 60 * 60
)
expect(staleRemoved == 1, "stale cleanup removes only the single-link producer blob")
expect(!blobFM.fileExists(atPath: staleBlobURL.path), "stale producer blob was removed")
expect(blobFM.fileExists(atPath: linkedBlobURL.path), "stale cleanup preserves hard links")
expect(blobFM.fileExists(atPath: symlinkBlobURL.path), "stale cleanup preserves symlinks")
expect((try! Data(contentsOf: outsideTarget)) == Data("keep".utf8),
       "stale cleanup preserves arbitrary targets")

print("Native blob security self-test passed")

// MARK: - Multi-display attribution

let displayOne = CGRect(x: 0, y: 0, width: 1920, height: 1080)
let displayTwo = CGRect(x: 1920, y: 0, width: 1920, height: 1080)
let visibleWindows = [
    VisibleScreenWindow(
        app: "Xcode", title: "AudioCapture.swift",
        frame: CGRect(x: 100, y: 80, width: 1400, height: 900)
    ),
    VisibleScreenWindow(
        app: "Preview", title: "Reference.pdf",
        frame: CGRect(x: 2050, y: 100, width: 1500, height: 850)
    ),
]
let workingDisplay = ScreenFrameAttributor.attribute(
    displayFrame: displayOne, displayIndex: 0,
    frontmostApp: "Xcode", windows: visibleWindows
)
expect(workingDisplay.app == "Xcode", "frontmost app is attributed only on its real display")
expect(workingDisplay.window == "AudioCapture.swift", "frontmost window title is preserved")
expect(workingDisplay.kind == "frontmost-window", "frontmost geometry is explicit")
let referenceDisplay = ScreenFrameAttributor.attribute(
    displayFrame: displayTwo, displayIndex: 1,
    frontmostApp: "Xcode", windows: visibleWindows
)
expect(referenceDisplay.app == "Preview", "reference display uses its geometry-identified app")
expect(referenceDisplay.window == "Reference.pdf", "reference window title is preserved")
expect(referenceDisplay.kind == "reference-window", "secondary context is not labeled frontmost")
expect(referenceDisplay.visibleApps == ["Preview"], "reference display records bounded visible apps")

final class ExcludeVisibleContextPolicy: NativePolicyChecking {
    func decision(
        source: NativePolicySource,
        app: String?,
        window: String?,
        at: Date
    ) -> NativePolicyDecision {
        if app == "Vault" || window?.contains("Private") == true {
            return .deny("excluded_visible_context")
        }
        return .allow
    }
}

let referenceWithExcludedWindow = ScreenFrameAttributor.attribute(
    displayFrame: displayTwo,
    displayIndex: 1,
    frontmostApp: "Xcode",
    windows: visibleWindows + [
        VisibleScreenWindow(
            app: "Vault", title: "Private credentials",
            frame: CGRect(x: 3400, y: 700, width: 300, height: 250)
        ),
    ]
)
expect(referenceWithExcludedWindow.app == "Preview",
       "largest geometry remains the reference attribution")
expect(referenceWithExcludedWindow.visibleApps.contains("Vault"),
       "smaller visible apps remain policy contexts")
var excludedReferenceAcquisitions = 0
if ScreenFrameAttributor.acquisitionAllowed(
    referenceWithExcludedWindow,
    policy: ExcludeVisibleContextPolicy()
) {
    excludedReferenceAcquisitions += 1
}
expect(excludedReferenceAcquisitions == 0,
       "an excluded secondary-display window blocks pixel acquisition")
let primaryWithExternalExclusion = ScreenFrameAttributor.attribute(
    displayFrame: displayOne,
    displayIndex: 0,
    frontmostApp: "Xcode",
    windows: visibleWindows,
    policyWindows: visibleWindows + [
        VisibleScreenWindow(
            app: "Vault", title: "Private credentials",
            frame: CGRect(x: 3400, y: 700, width: 300, height: 250)
        ),
    ]
)
expect(ScreenFrameAttributor.acquisitionAllowed(
    primaryWithExternalExclusion,
    policy: ExcludeVisibleContextPolicy()
), "an exclusion on display 2 does not suppress display 1")

print("Screen attribution self-test passed")

// A periodic timer can fire while a prior multi-display/OCR pass is awaiting.
// Exactly one caller may hold the pass permit, and every finish makes the next
// scheduled pass eligible again.
let capturePassGate = CapturePassGate()
expect(capturePassGate.tryBegin(), "first screen capture pass acquires the gate")
expect(!capturePassGate.tryBegin(), "overlapping screen capture pass is skipped")
capturePassGate.finish()
expect(capturePassGate.tryBegin(), "screen capture gate reopens after completion")
capturePassGate.finish()

let gateRace = CapturePassGate()
let gateRaceLock = NSLock()
var gateRaceWinners = 0
DispatchQueue.concurrentPerform(iterations: 32) { _ in
    if gateRace.tryBegin() {
        gateRaceLock.lock()
        gateRaceWinners += 1
        gateRaceLock.unlock()
    }
}
expect(gateRaceWinners == 1, "concurrent screen capture ticks admit exactly one pass")
gateRace.finish()
expect(gateRace.tryBegin(), "gate reopens after a concurrently acquired pass finishes")
gateRace.finish()

print("Screen capture overlap gate self-test passed")

let accessibilityReady = NativeReadiness.accessibility(trusted: true)
expect(accessibilityReady.status == "ready", "trusted Accessibility reports ready")
expect(accessibilityReady.reason == nil, "ready Accessibility has no blocking reason")
let accessibilityBlocked = NativeReadiness.accessibility(trusted: false)
expect(accessibilityBlocked.status == "blocked", "untrusted Accessibility reports blocked")
expect(accessibilityBlocked.reason == "permission-not-granted",
       "untrusted Accessibility reports an actionable reason")
let screenReady = NativeReadiness.screenRecording(allowed: true)
expect(screenReady.status == "ready", "Screen Recording grant reports ready")
let screenBlocked = NativeReadiness.screenRecording(allowed: false)
expect(screenBlocked.status == "blocked", "missing Screen Recording grant reports blocked")
let systemDisabled = NativeReadiness.systemAudio(
    requested: false,
    screenRecording: true,
    transcriptionStatus: "ready",
    transcriptionReason: nil
)
expect(systemDisabled.status == "disabled", "unrequested system audio stays explicitly disabled")
let systemBlocked = NativeReadiness.systemAudio(
    requested: true,
    screenRecording: false,
    transcriptionStatus: "ready",
    transcriptionReason: nil
)
expect(systemBlocked.reason == "screen-recording-permission-not-granted",
       "requested system audio reports its missing Screen Recording grant")
let microphoneBlocked = NativeReadiness.microphoneAudio(
    requested: true,
    microphoneAuthorization: "denied",
    transcriptionStatus: "ready",
    transcriptionReason: nil
)
expect(microphoneBlocked.status == "blocked", "requested microphone reports denied permission")
let microphoneUnavailable = NativeReadiness.microphoneAudio(
    requested: true,
    microphoneAuthorization: "authorized",
    transcriptionStatus: "unavailable",
    transcriptionReason: "no-on-device-model"
)
expect(microphoneUnavailable.status == "unavailable",
       "requested microphone reports a missing on-device model")
let microphoneReady = NativeReadiness.microphoneAudio(
    requested: true,
    microphoneAuthorization: "authorized",
    transcriptionStatus: "ready",
    transcriptionReason: nil
)
expect(microphoneReady.status == "ready", "requested microphone reports usable prerequisites")

print("Source readiness self-test passed")

// An async ScreenCaptureKit start must not outlive a user opt-out. Generation
// invalidation is also what lets the real tap retry transient failures without
// launching overlapping streams every 500ms policy reconciliation tick.
var audioLifecycle = AudioTapLifecycle()
let canceledAudioStart = audioLifecycle.requestStart(now: 0)!
expect(audioLifecycle.requestStart(now: 0) == nil,
       "audio lifecycle admits only one pending start")
audioLifecycle.cancel()
expect(!audioLifecycle.completeStart(canceledAudioStart, succeeded: true, now: 1),
       "a start completing after opt-out cannot install an orphan tap")
expect(!audioLifecycle.running, "canceled audio generation remains stopped")

let failedAudioStart = audioLifecycle.requestStart(now: 2)!
audioLifecycle.completeStart(
    failedAudioStart, succeeded: false, now: 2, retryBase: 1, retryMax: 2
)
expect(audioLifecycle.requestStart(now: 2.5) == nil,
       "failed audio starts respect their retry delay")
let secondAudioStart = audioLifecycle.requestStart(now: 3)!
audioLifecycle.completeStart(
    secondAudioStart, succeeded: false, now: 3, retryBase: 1, retryMax: 2
)
expect(audioLifecycle.requestStart(now: 4.9) == nil,
       "repeated audio failure uses bounded exponential backoff")
let recoveredAudioStart = audioLifecycle.requestStart(now: 5)!
expect(audioLifecycle.completeStart(recoveredAudioStart, succeeded: true, now: 5),
       "a later audio start can recover")
expect(audioLifecycle.running, "successful audio recovery is marked running")
audioLifecycle.cancel()

print("Audio tap lifecycle self-test passed")

// MARK: - Fail-closed native acquisition policy

final class DenyPolicy: NativePolicyChecking {
    func decision(source: NativePolicySource, app: String?, window: String?, at: Date) -> NativePolicyDecision {
        .deny("test")
    }
}

var acquisitionCalls = 0
let performed = AcquisitionFence.perform(
    policy: DenyPolicy(), source: .screenVideo, app: "Editor", window: "Document"
) {
    acquisitionCalls += 1
}
expect(!performed, "denied acquisition reports false")
expect(acquisitionCalls == 0, "denied policy never invokes the protected acquisition function")

let fm = FileManager.default
let policyDir = fm.temporaryDirectory.appendingPathComponent("praxis-policy-\(UUID().uuidString)")
try fm.createDirectory(at: policyDir, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: policyDir) }
let policyURL = policyDir.appendingPathComponent("native-acquisition-policy.json")
let now = Date()
let iso: ISO8601DateFormatter = {
    let value = ISO8601DateFormatter()
    value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return value
}()

func policyJSON(
    mode: String = "normal",
    pausedUntil: Date? = nil,
    expiresAt: Date? = nil,
    disabled: String? = nil,
    power: String = "ac",
    suspended: Bool = false,
    batteryAware: Bool = true,
    excludedPaths: [String] = [".env", ".ssh", "credentials", ".pem", ".key"]
) -> [String: Any] {
    var sources: [String: Bool] = [
        "screen_video": true,
        "accessibility": true,
        "focus_timeline": true,
        "input_events": true,
        "clipboard": true,
        "audio": true,
    ]
    if let disabled { sources[disabled] = false }
    var value: [String: Any] = [
        "version": 1,
        "publishedAt": iso.string(from: now),
        "expiresAt": iso.string(from: expiresAt ?? now.addingTimeInterval(60)),
        "privacyRevision": iso.string(from: now),
        "resourceRevision": iso.string(from: now),
        "mode": mode,
        "sources": sources,
        "cloudScreenshotEgressConsent": false,
        "excludedApps": ["Vault"],
        "excludedWindows": ["Private Window"],
        "excludedPaths": excludedPaths,
        "resources": [
            "powerSource": power,
            "suspended": suspended,
            "batteryAware": batteryAware,
        ],
    ]
    if let pausedUntil { value["pausedUntil"] = iso.string(from: pausedUntil) }
    return value
}

func writePolicy(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    try! data.write(to: policyURL, options: [.atomic])
}

let required = NativePolicyGate(path: policyURL.path, mode: .required)
let developmentMissing = NativePolicyGate(
    path: policyDir.appendingPathComponent("missing.json").path,
    mode: .developmentCompatibility
)
expect(!required.decision(source: .accessibility, at: now).allowed,
       "required mode denies a missing policy")
expect(developmentMissing.decision(source: .accessibility, at: now).allowed,
       "explicit development compatibility permits a missing publisher")

writePolicy(policyJSON())
expect(required.decision(source: .screenVideo, app: "Editor", at: now).allowed,
       "local screenshots are allowed by screen_video even when cloud egress consent is false")
expect(required.decision(source: .accessibility, app: "Editor", at: now).allowed,
       "normal accessibility acquisition is allowed")
expect(!required.decision(source: .accessibility, app: "Vault App", at: now).allowed,
       "excluded app denies before accessibility content")
expect(!required.decision(source: .accessibility, app: "Editor", window: "Private Window 1", at: now).allowed,
       "excluded window denies before accessibility content")
let excludedAXPath = required.decision(
    source: .accessibility,
    app: "Visual Studio Code",
    window: "project/.env — Visual Studio Code",
    at: now
)
expect(!excludedAXPath.allowed && excludedAXPath.reason == "excluded_path",
       "excluded path in an editor title denies before AX text extraction")

let externalEnvAttribution = ScreenFrameAttributor.attribute(
    displayFrame: displayTwo,
    displayIndex: 1,
    frontmostApp: "Xcode",
    windows: [
        VisibleScreenWindow(
            app: "Preview", title: "Reference.pdf",
            frame: CGRect(x: 2050, y: 100, width: 1200, height: 800)
        ),
    ],
    policyWindows: [
        VisibleScreenWindow(
            app: "Preview", title: "Reference.pdf",
            frame: CGRect(x: 2050, y: 100, width: 1200, height: 800)
        ),
        VisibleScreenWindow(
            app: "Visual Studio Code", title: "secrets/.env — workspace",
            frame: CGRect(x: 3300, y: 650, width: 400, height: 260)
        ),
    ]
)
expect(!ScreenFrameAttributor.acquisitionAllowed(
    externalEnvAttribution,
    policy: required,
    at: now
), "an excluded path in a secondary-display window denies pixels before acquisition")

var legacyPolicy = policyJSON()
legacyPolicy.removeValue(forKey: "excludedPaths")
writePolicy(legacyPolicy)
expect(required.decision(
    source: .accessibility,
    app: "Editor",
    window: "ordinary document",
    at: now
).allowed, "additive excludedPaths field remains compatible with older wire-v1 snapshots")

writePolicy(policyJSON(disabled: "input_events"))
expect(!required.decision(source: .inputEvents, at: now).allowed,
       "native source toggle is enforced")
writePolicy(policyJSON(disabled: "screen_video"))
expect(!required.decision(source: .screenVideo, at: now).allowed,
       "local screen acquisition is disabled by its source toggle")
expect(required.decision(source: .audio, at: now).allowed,
       "the audio source remains independently enabled")
writePolicy(policyJSON(mode: "private"))
expect(!required.decision(source: .clipboard, at: now).allowed, "private mode denies all content")
var privateAcquisitionCalls = 0
AcquisitionFence.perform(policy: required, source: .accessibility, app: "Editor", at: now) {
    privateAcquisitionCalls += 1
}
expect(privateAcquisitionCalls == 0,
       "a real decoded private policy does not invoke the accessibility acquisition")
var clipboardBodyReads = 0
let deniedClipboardBody = ClipboardBodyFence.read(
    policy: required, app: "Editor", window: "Document", at: now
) {
    clipboardBodyReads += 1
    return "private clipboard body"
}
expect(deniedClipboardBody == nil, "private policy returns no clipboard body")
expect(clipboardBodyReads == 0, "private policy never invokes the clipboard body reader")
writePolicy(policyJSON(mode: "paused", pausedUntil: now.addingTimeInterval(60)))
expect(!required.decision(source: .accessibility, at: now).allowed, "active timed pause denies")
writePolicy(policyJSON(mode: "paused", pausedUntil: now.addingTimeInterval(-1)))
expect(required.decision(source: .accessibility, at: now).allowed, "expired timed pause resumes")
writePolicy(policyJSON(suspended: true))
expect(!required.decision(source: .audio, at: now).allowed, "suspend denies all acquisition")
writePolicy(policyJSON(power: "battery"))
expect(!required.decision(source: .screenVideo, at: now).allowed,
       "battery-aware mode denies pixel acquisition")
expect(required.decision(source: .accessibility, at: now).allowed,
       "battery-aware mode preserves cheap local accessibility")
writePolicy(policyJSON(expiresAt: now.addingTimeInterval(-1)))
expect(!required.decision(source: .accessibility, at: now).allowed, "stale lease fails closed")
var unknownVersion = policyJSON()
unknownVersion["version"] = 99
writePolicy(unknownVersion)
expect(!required.decision(source: .accessibility, at: now).allowed,
       "unknown policy version fails closed")
try Data("{broken".utf8).write(to: policyURL, options: [.atomic])
expect(!required.decision(source: .accessibility, at: now).allowed, "corrupt policy fails closed")

print("Native acquisition policy self-test passed")

expect(SensitiveContentFilter.looksSensitive("api_key=sk-supersecretvalue1234567890"),
       "API key-shaped clipboard text is sensitive")
expect(SensitiveContentFilter.looksSensitive("Bearer abcdefghijklmnopqrstuvwxyz012345"),
       "bearer clipboard text is sensitive")
expect(SensitiveContentFilter.looksSensitive("aB3dE5fG7hJ9kLmN2pQrS4tUvW6xY8z0"),
       "standalone high-entropy clipboard values fail closed")
expect(!SensitiveContentFilter.looksSensitive("ordinary project status text"),
       "ordinary prose is retained")

print("Sensitive content filter self-test passed")
