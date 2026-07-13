import Foundation
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
    batteryAware: Bool = true
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
