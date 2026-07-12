import ApplicationServices
import AppKit

/// Universal conversation tap. Instead of a proxy per app, this walks the
/// focused window's Accessibility tree and emits any *newly-appeared* text as
/// `conversation_bubble_added` — so "what you sent / what came back" is captured
/// for ANY chat UI (ChatGPT web, Claude desktop, Cursor, Discord, iMessage…)
/// with zero per-app code. Role is intentionally omitted; the reconstructor
/// infers "user" generically by matching the text against the recent draft.
///
/// Each app is *baselined* on first sight (existing on-screen text is recorded
/// but not emitted), so only messages that arrive afterward become bubbles.
enum ConversationScrape {
    private static var seenByApp: [String: Set<Int>] = [:]
    private static var primed: Set<String> = []
    private static let minLen = 8
    private static let maxNodes = 12000 // web/Electron trees are deep
    private static let maxEmitPerTick = 12
    private static var enhanced: Set<pid_t> = []

    static func scan(policy: NativePolicyChecking) {
        guard AXIsProcessTrusted() else { return }
        guard let app = NSWorkspace.shared.frontmostApplication else { return }
        let appName = app.localizedName ?? "unknown"
        // Do not touch the app's AX tree until global/source/app policy allows it.
        guard policy.decision(source: .accessibility, app: appName, window: nil, at: Date()).allowed else {
            return
        }
        let pid = app.processIdentifier
        let axApp = AXUIElementCreateApplication(pid)

        // Chrome and Electron apps (Claude, Cursor, Discord, Slack…) don't build
        // their accessibility tree until an assistive client asks for it. Setting
        // these flags once per app forces them to expose web/Electron content —
        // without this the focused-window walk finds almost no message text.
        if !enhanced.contains(pid) {
            enhanced.insert(pid)
            AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            return // let the tree build; capture on the next tick (also baselines)
        }

        var winRef: AnyObject?
        guard AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &winRef) == .success,
              let win = winRef else { return }
        let window = win as! AXUIElement
        let windowTitle = AXSnapshot.copyString(window, kAXTitleAttribute) ?? appName
        guard policy.decision(
            source: .accessibility, app: appName, window: windowTitle, at: Date()
        ).allowed else { return }

        var texts: [String] = []
        var budget = maxNodes
        collect(window, into: &texts, budget: &budget)

        var seen = seenByApp[appName] ?? []
        var fresh: [String] = []
        for raw in texts {
            let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.count < minLen { continue }
            let key = t.hashValue
            if seen.contains(key) { continue }
            seen.insert(key)
            fresh.append(t)
        }
        if seen.count > 8000 { seen = Set(seen.suffix(4000)) } // bound memory
        seenByApp[appName] = seen

        // First time we see this app: baseline only, emit nothing.
        if !primed.contains(appName) {
            primed.insert(appName)
            return
        }

        for t in fresh.prefix(maxEmitPerTick) {
            Emitter.shared.emit(
                source: "accessibility", app: appName, window: windowTitle,
                type: "conversation_bubble_added",
                payload: ["text": t]
            )
        }
    }

    private static func collect(_ el: AXUIElement, into out: inout [String], budget: inout Int) {
        if budget <= 0 { return }
        budget -= 1
        let role = AXSnapshot.copyString(el, kAXRoleAttribute) ?? ""
        if role == "AXStaticText" || role == "AXTextArea" {
            if let v = AXSnapshot.copyString(el, kAXValueAttribute), !v.isEmpty {
                out.append(v)
            } else if let t = AXSnapshot.copyString(el, kAXTitleAttribute), !t.isEmpty {
                out.append(t)
            }
        }
        var kids: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kids) == .success,
           let arr = kids as? [AXUIElement] {
            for child in arr { collect(child, into: &out, budget: &budget) }
        }
    }
}
