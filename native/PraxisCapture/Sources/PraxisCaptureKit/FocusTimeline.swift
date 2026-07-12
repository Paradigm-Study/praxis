import AppKit

/// Focus tap: observes frontmost-application changes via NSWorkspace and emits
/// `app_focused` with the new window title. The reconstructor turns these into
/// `switched_app` actions and uses them to scope every other tap.
final class FocusTimeline {
    private let policy: NativePolicyChecking
    private var last: String?
    private var observer: NSObjectProtocol?

    init(policy: NativePolicyChecking) {
        self.policy = policy
    }

    func stop() {
        if let observer {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        observer = nil
    }

    func start() {
        let nc = NSWorkspace.shared.notificationCenter
        observer = nc.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main
        ) { [weak self] note in
            guard let self,
                  let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            else { return }
            let name = app.localizedName ?? app.bundleIdentifier ?? "unknown"
            guard self.policy.decision(
                source: .focusTimeline, app: name, window: nil, at: Date()
            ).allowed else { return }
            let window = AXSnapshot.frontWindowTitle(pid: app.processIdentifier) ?? name
            guard self.policy.decision(
                source: .focusTimeline, app: name, window: window, at: Date()
            ).allowed else { return }
            Emitter.shared.emit(
                source: "focus_timeline", app: name, window: window,
                type: "app_focused",
                payload: ["to": name, "from": self.last ?? ""]
            )
            self.last = name
        }

        if let app = NSWorkspace.shared.frontmostApplication {
            let name = app.localizedName ?? "unknown"
            guard policy.decision(
                source: .focusTimeline, app: name, window: nil, at: Date()
            ).allowed else { return }
            let window = AXSnapshot.frontWindowTitle(pid: app.processIdentifier) ?? name
            guard policy.decision(
                source: .focusTimeline, app: name, window: window, at: Date()
            ).allowed else { return }
            Emitter.shared.emit(
                source: "focus_timeline", app: name, window: window,
                type: "app_focused", payload: ["to": name]
            )
            last = name
        }
    }
}
