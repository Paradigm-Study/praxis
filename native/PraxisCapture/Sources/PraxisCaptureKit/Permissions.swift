import ApplicationServices
import CoreGraphics

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
}
