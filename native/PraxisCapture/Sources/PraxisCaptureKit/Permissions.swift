import ApplicationServices
import AVFoundation
import CoreGraphics
import Speech

public struct OnDeviceTranscriptionState {
    public let status: String
    public let reason: String?
    public let locales: [String]
}

/// TCC permission checks. The client launches regardless, but each tap is gated
/// on the permission it needs, so a partially-granted setup still yields data.
public enum Permissions {
    public static func accessibilityTrusted() -> Bool {
        AXIsProcessTrusted()
    }

    public static func screenRecordingAllowed() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    @discardableResult
    public static func requestScreenRecording() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    @discardableResult
    public static func requestAccessibility() -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
            as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    public static func microphoneAuthorization() -> String {
        authorizationName(AVCaptureDevice.authorizationStatus(for: .audio))
    }

    public static func speechRecognitionAuthorization() -> String {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: "authorized"
        case .denied: "denied"
        case .restricted: "restricted"
        case .notDetermined: "not-determined"
        @unknown default: "unknown"
        }
    }

    /// Public APIs expose model support and recognizer availability separately.
    /// A locale can support on-device recognition while Dictation is disabled,
    /// so never treat a non-empty locale list alone as transcription readiness.
    public static func onDeviceTranscriptionState() -> OnDeviceTranscriptionState {
        var seen = Set<String>()
        let recognizers = [Locale.current.identifier, "en-US", "zh-CN"].compactMap { identifier -> SFSpeechRecognizer? in
            let normalized = Locale(identifier: identifier).identifier(.bcp47)
            guard !seen.contains(normalized) else { return nil }
            seen.insert(normalized)
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: identifier)),
                  recognizer.supportsOnDeviceRecognition else { return nil }
            return recognizer
        }
        let locales = recognizers.map { $0.locale.identifier(.bcp47) }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            break
        case .notDetermined:
            return OnDeviceTranscriptionState(
                status: "unavailable", reason: "speech-permission-not-determined", locales: locales
            )
        case .denied:
            return OnDeviceTranscriptionState(
                status: "unavailable", reason: "speech-permission-denied", locales: locales
            )
        case .restricted:
            return OnDeviceTranscriptionState(
                status: "unavailable", reason: "speech-permission-restricted", locales: locales
            )
        @unknown default:
            return OnDeviceTranscriptionState(
                status: "unavailable", reason: "speech-permission-unknown", locales: locales
            )
        }
        guard !recognizers.isEmpty else {
            return OnDeviceTranscriptionState(
                status: "unavailable", reason: "no-on-device-model", locales: []
            )
        }
        guard recognizers.contains(where: { $0.isAvailable }) else {
            return OnDeviceTranscriptionState(
                status: "unavailable", reason: "recognizer-unavailable", locales: locales
            )
        }
        return OnDeviceTranscriptionState(status: "ready", reason: nil, locales: locales)
    }

    private static func authorizationName(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized: "authorized"
        case .denied: "denied"
        case .restricted: "restricted"
        case .notDetermined: "not-determined"
        @unknown default: "unknown"
        }
    }
}
