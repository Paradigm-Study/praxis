import AppKit
import Foundation

/// Testable final fence immediately surrounding the pasteboard body read.
public enum ClipboardBodyFence {
    public static func read(
        policy: NativePolicyChecking,
        app: String,
        window: String,
        at: Date = Date(),
        acquireBody: () -> String?
    ) -> String? {
        guard policy.decision(
            source: .clipboard, app: app, window: window, at: at
        ).allowed else { return nil }
        return acquireBody()
    }
}

/// Native pasteboard poller. Crucially, policy and current app/window are
/// checked before `string(forType:)` reads the clipboard body. Denied changes
/// are baselined by changeCount so content copied while private/excluded cannot
/// leak after capture resumes.
final class ClipboardCapture {
    private let policy: NativePolicyChecking
    private var lastChangeCount: Int

    init(policy: NativePolicyChecking) {
        self.policy = policy
        self.lastChangeCount = NSPasteboard.general.changeCount
    }

    func poll() {
        let pasteboard = NSPasteboard.general
        let change = pasteboard.changeCount
        guard change != lastChangeCount else { return }

        let app = NSWorkspace.shared.frontmostApplication
        let appName = app?.localizedName ?? "unknown"
        guard policy.decision(
            source: .clipboard, app: appName, window: nil, at: Date()
        ).allowed,
        Permissions.accessibilityTrusted(),
        let app,
        let window = AXSnapshot.frontWindowTitle(pid: app.processIdentifier),
        policy.decision(
            source: .clipboard, app: appName, window: window, at: Date()
        ).allowed else {
            // Consume only the non-content generation marker.
            lastChangeCount = change
            return
        }

        // This is the first clipboard-body acquisition in the native path.
        guard let text = ClipboardBodyFence.read(
            policy: policy, app: appName, window: window,
            acquireBody: { pasteboard.string(forType: .string) }
        ), !text.isEmpty else {
            lastChangeCount = change
            return
        }
        lastChangeCount = change
        if text.count > 256, let data = text.data(using: .utf8) {
            let blob = Emitter.shared.writeBlob(data, kind: "text", ext: "txt")
            Emitter.shared.emit(
                source: "clipboard", app: appName, window: window,
                type: "clipboard_changed", payload: ["op": "copy", "length": text.count],
                blobFiles: blob.map { [$0] }
            )
        } else {
            Emitter.shared.emit(
                source: "clipboard", app: appName, window: window,
                type: "clipboard_changed", payload: ["op": "copy", "text": text]
            )
        }
    }
}
