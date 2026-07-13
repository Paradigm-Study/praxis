import ApplicationServices
import AppKit

/// Accessibility tap: reads the focused element of the frontmost app — its role,
/// value (for text fields), and title. Emits `focused_text_changed` when a text
/// field's value changes and `ui_snapshot` otherwise. Needs Accessibility TCC.
enum AXSnapshot {
    private static var lastValue: String?

    /// Title of the focused window of a given process (used to label focus events).
    static func frontWindowTitle(pid: pid_t) -> String? {
        let appEl = AXUIElementCreateApplication(pid)
        var win: AnyObject?
        guard AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &win) == .success,
              let w = win else { return nil }
        return copyString(w as! AXUIElement, kAXTitleAttribute)
    }

    static func snapshotFocused(policy: NativePolicyChecking) {
        let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown"
        // Global/source/app policy is checked before the first AX read.
        guard policy.decision(source: .accessibility, app: app, window: nil, at: Date()).allowed else {
            return
        }
        let window = NSWorkspace.shared.frontmostApplication
            .flatMap { frontWindowTitle(pid: $0.processIdentifier) } ?? app
        AcquisitionFence.perform(
            policy: policy, source: .accessibility, app: app, window: window
        ) {
            snapshotAllowed(app: app, window: window)
        }
    }

    private static func snapshotAllowed(app: String, window: String) {
        let sys = AXUIElementCreateSystemWide()
        var focused: AnyObject?
        guard AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let el = focused else { return }
        let element = el as! AXUIElement

        let role = copyString(element, kAXRoleAttribute) ?? ""
        let subrole = copyString(element, kAXSubroleAttribute) ?? ""
        // Inspect non-content attributes first. Secure/protected fields must
        // never have AXValue read at all.
        if isProtected(element, role: role, subrole: subrole) { return }
        let value = copyString(element, kAXValueAttribute)
        let title = copyString(element, kAXTitleAttribute)
        // An empty field often reports its placeholder as the value — skip those
        // so the reconstructor doesn't treat "Type / for commands" as user input.
        let placeholder = copyString(element, kAXPlaceholderValueAttribute)
        if role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox" {
            guard let v = value, v != lastValue,
                  !SensitiveContentFilter.looksSensitive(v) else { return }
            let trimmed = v.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || v == placeholder { return } // empty composer
            lastValue = v
            Emitter.shared.emit(
                source: "accessibility", app: app, window: window,
                type: "focused_text_changed",
                payload: ["role": "textfield", "value": v]
            )
        } else {
            Emitter.shared.emit(
                source: "accessibility", app: app, window: window,
                type: "ui_snapshot",
                payload: ["focusedRole": role, "title": title ?? ""]
            )
        }
    }

    static func copyString(_ el: AXUIElement, _ attr: String) -> String? {
        var v: AnyObject?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
        return v as? String
    }

    static func isProtected(_ element: AXUIElement, role: String? = nil, subrole: String? = nil) -> Bool {
        let roleValue = (role ?? copyString(element, kAXRoleAttribute) ?? "").lowercased()
        let subroleValue = (subrole ?? copyString(element, kAXSubroleAttribute) ?? "").lowercased()
        if roleValue.contains("secure") || subroleValue.contains("secure") { return true }
        var protected: AnyObject?
        if AXUIElementCopyAttributeValue(element, "AXProtectedContent" as CFString, &protected) == .success,
           let value = protected as? Bool {
            return value
        }
        return false
    }
}
