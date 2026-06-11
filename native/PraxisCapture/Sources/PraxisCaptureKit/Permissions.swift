import ApplicationServices
import CoreGraphics

/// TCC permission checks. The client launches regardless, but each tap is gated
/// on the permission it needs, so a partially-granted setup still yields data.
enum Permissions {
    static func accessibilityTrusted() -> Bool {
        AXIsProcessTrusted()
    }

    static func screenRecordingAllowed() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    @discardableResult
    static func requestScreenRecording() -> Bool {
        CGRequestScreenCaptureAccess()
    }
}
