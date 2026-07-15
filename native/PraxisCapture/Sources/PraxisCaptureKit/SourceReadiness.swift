import Foundation

/// Metadata-only producer readiness sent beside (never as) captured evidence.
public struct NativeSourceReadiness: Equatable {
    public let channel: String
    public let status: String
    public let reason: String?

    public var payload: [String: Any] {
        var value: [String: Any] = ["channel": channel, "status": status]
        if let reason { value["reason"] = reason }
        return value
    }
}

public enum NativeReadiness {
    public static func accessibility(trusted: Bool) -> NativeSourceReadiness {
        NativeSourceReadiness(
            channel: "accessibility",
            status: trusted ? "ready" : "blocked",
            reason: trusted ? nil : "permission-not-granted"
        )
    }

    public static func screenRecording(allowed: Bool) -> NativeSourceReadiness {
        NativeSourceReadiness(
            channel: "screen_recording",
            status: allowed ? "ready" : "blocked",
            reason: allowed ? nil : "permission-not-granted"
        )
    }

    public static func systemAudio(
        requested: Bool,
        screenRecording: Bool,
        transcriptionStatus: String?,
        transcriptionReason: String?
    ) -> NativeSourceReadiness {
        guard requested else {
            return NativeSourceReadiness(
                channel: "audio_system", status: "disabled", reason: "not-requested"
            )
        }
        guard screenRecording else {
            return NativeSourceReadiness(
                channel: "audio_system",
                status: "blocked",
                reason: "screen-recording-permission-not-granted"
            )
        }
        return audioTranscription(
            channel: "audio_system",
            status: transcriptionStatus,
            reason: transcriptionReason
        )
    }

    public static func microphoneAudio(
        requested: Bool,
        microphoneAuthorization: String?,
        transcriptionStatus: String?,
        transcriptionReason: String?
    ) -> NativeSourceReadiness {
        guard requested else {
            return NativeSourceReadiness(
                channel: "audio_mic", status: "disabled", reason: "not-requested"
            )
        }
        guard microphoneAuthorization == "authorized" else {
            return NativeSourceReadiness(
                channel: "audio_mic",
                status: "blocked",
                reason: "microphone-permission-\(microphoneAuthorization ?? "unknown")"
            )
        }
        return audioTranscription(
            channel: "audio_mic",
            status: transcriptionStatus,
            reason: transcriptionReason
        )
    }

    private static func audioTranscription(
        channel: String,
        status: String?,
        reason: String?
    ) -> NativeSourceReadiness {
        guard status == "ready" else {
            let detail = reason ?? "transcription-unavailable"
            let blocked = detail.hasPrefix("speech-permission-")
            return NativeSourceReadiness(
                channel: channel,
                status: blocked ? "blocked" : "unavailable",
                reason: detail
            )
        }
        return NativeSourceReadiness(channel: channel, status: "ready", reason: nil)
    }
}
