import Foundation

/// Versioned Node → Swift acquisition policy contract. The packaged app always
/// uses `.required`; `.developmentCompatibility` is an explicit escape hatch
/// for standalone tap development without a running Node policy publisher.
public enum NativePolicyMode: String {
    case required
    case developmentCompatibility = "development"
}

public enum NativePolicySource: String, Codable {
    case screenVideo = "screen_video"
    case accessibility
    case focusTimeline = "focus_timeline"
    case inputEvents = "input_events"
    case clipboard
    case audio
}

public struct NativePolicyDecision: Equatable {
    public let allowed: Bool
    public let reason: String?

    public static let allow = NativePolicyDecision(allowed: true, reason: nil)
    public static func deny(_ reason: String) -> NativePolicyDecision {
        NativePolicyDecision(allowed: false, reason: reason)
    }
}

public protocol NativePolicyChecking: AnyObject {
    func decision(source: NativePolicySource, app: String?, window: String?, at: Date) -> NativePolicyDecision
}

/// The one wrapper used at native acquisition call sites. Tests supply a deny
/// policy and a counting closure, proving the protected acquisition is not run.
public enum AcquisitionFence {
    @discardableResult
    public static func perform(
        policy: NativePolicyChecking,
        source: NativePolicySource,
        app: String? = nil,
        window: String? = nil,
        at: Date = Date(),
        acquire: () -> Void
    ) -> Bool {
        guard policy.decision(source: source, app: app, window: window, at: at).allowed else {
            return false
        }
        acquire()
        return true
    }
}

private struct NativeAcquisitionPolicy: Decodable {
    struct Resources: Decodable {
        let powerSource: String
        let suspended: Bool
        let batteryAware: Bool
    }

    let version: Int
    let publishedAt: String
    let expiresAt: String
    let privacyRevision: String
    let resourceRevision: String
    let mode: String
    let pausedUntil: String?
    let sources: [String: Bool]
    /// Informational cloud-egress consent; local acquisition is controlled by
    /// sources.screen_video and must not be conflated with observer egress.
    let cloudScreenshotEgressConsent: Bool
    let excludedApps: [String]
    let excludedWindows: [String]
    let resources: Resources
}

/// Loads the atomically-renamed policy on every decision. Capture frequency is
/// deliberately low and this avoids a stale permissive in-process cache after
/// pause/private/resource transitions.
public final class NativePolicyGate: NativePolicyChecking {
    public static let wireVersion = 1

    public let path: String
    public let mode: NativePolicyMode

    public init(path: String, mode: NativePolicyMode = .required) {
        self.path = path
        self.mode = mode
    }

    /// Environment-based construction for the standalone CLI. Compatibility
    /// is fail-open only when explicitly requested by mode or CLI flag.
    public static func fromEnvironment(
        developmentCompatibility: Bool = false,
        currentDirectory: String = FileManager.default.currentDirectoryPath
    ) -> NativePolicyGate {
        let env = ProcessInfo.processInfo.environment
        let path = env["PRAXIS_NATIVE_POLICY_PATH"]
            ?? URL(fileURLWithPath: env["PRAXIS_DATA_DIR"] ?? currentDirectory + "/data")
                .appendingPathComponent("native-acquisition-policy.json").path
        let dev = developmentCompatibility || env["PRAXIS_NATIVE_POLICY_MODE"] == "development"
        return NativePolicyGate(path: path, mode: dev ? .developmentCompatibility : .required)
    }

    public func decision(
        source: NativePolicySource,
        app: String? = nil,
        window: String? = nil,
        at now: Date = Date()
    ) -> NativePolicyDecision {
        let policy: NativeAcquisitionPolicy
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: path), options: [.uncached])
            policy = try JSONDecoder().decode(NativeAcquisitionPolicy.self, from: data)
        } catch {
            return invalid("policy_unavailable")
        }

        guard policy.version == Self.wireVersion,
              !policy.publishedAt.isEmpty,
              !policy.privacyRevision.isEmpty,
              !policy.resourceRevision.isEmpty,
              let expires = parseISO(policy.expiresAt),
              expires > now,
              policy.resources.powerSource == "ac" || policy.resources.powerSource == "battery"
        else { return invalid("policy_invalid_or_stale") }

        if policy.resources.suspended { return .deny("suspended") }
        if policy.mode == "private" { return .deny("private") }
        if policy.mode == "paused" {
            if policy.pausedUntil == nil { return .deny("paused") }
            guard let until = policy.pausedUntil.flatMap(parseISO) else {
                return invalid("policy_invalid_pause")
            }
            if until > now { return .deny("paused") }
        } else if policy.mode != "normal" {
            return invalid("policy_invalid_mode")
        }
        guard policy.sources[source.rawValue] == true else { return .deny("source_disabled") }
        if source == .screenVideo && policy.resources.batteryAware
            && policy.resources.powerSource == "battery" {
            return .deny("battery_screenshot")
        }
        if contains(app, any: policy.excludedApps) { return .deny("excluded_app") }
        if contains(window, any: policy.excludedWindows) { return .deny("excluded_window") }
        return .allow
    }

    private func invalid(_ reason: String) -> NativePolicyDecision {
        mode == .developmentCompatibility ? .allow : .deny(reason)
    }
}

private func contains(_ value: String?, any patterns: [String]) -> Bool {
    guard let value else { return false }
    let normalized = value.lowercased()
    return patterns.contains { !$0.isEmpty && normalized.contains($0.lowercased()) }
}

private func parseISO(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    return ISO8601DateFormatter().date(from: value)
}
