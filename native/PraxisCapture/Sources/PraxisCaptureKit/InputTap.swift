import CoreGraphics
import AppKit

/// Input tap (CGEventTap): observes key-down and mouse-down *timing*. For
/// privacy it emits only submit/save/copy/paste-relevant keys (Enter, Cmd-…,
/// Tab/Esc/etc.) and click coordinates — never raw typed text. The actual draft
/// content comes from the Accessibility tap, not keylogging.
final class InputTap {
    private let policy: NativePolicyChecking
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?

    init(policy: NativePolicyChecking) {
        self.policy = policy
    }

    func start() {
        let mask: CGEventMask =
            CGEventMask(1 << CGEventType.keyDown.rawValue) |
            CGEventMask(1 << CGEventType.leftMouseDown.rawValue)

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: inputTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            log("could not create event tap (needs Accessibility permission)")
            return
        }
        self.tap = tap
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        self.source = src
        CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        log("input tap installed")
    }

    func stop() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes) }
        tap = nil
        source = nil
    }

    fileprivate func handle(type: CGEventType, event: CGEvent) {
        let app = NSWorkspace.shared.frontmostApplication
        let appName = app?.localizedName ?? "unknown"
        guard policy.decision(
            source: .inputEvents, app: appName, window: nil, at: Date()
        ).allowed else { return }
        let window = app.flatMap { AXSnapshot.frontWindowTitle(pid: $0.processIdentifier) } ?? appName
        guard policy.decision(
            source: .inputEvents, app: appName, window: window, at: Date()
        ).allowed else { return }

        if type == .keyDown {
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            let flags = event.flags
            var mods: [String] = []
            if flags.contains(.maskCommand) { mods.append("cmd") }
            if flags.contains(.maskShift) { mods.append("shift") }
            if flags.contains(.maskAlternate) { mods.append("alt") }
            if flags.contains(.maskControl) { mods.append("ctrl") }

            let key = keyName(for: code)
            let meaningful = key == "Enter" || !mods.isEmpty ||
                ["Tab", "Escape", "Backspace", "Space"].contains(key)
            if meaningful {
                Emitter.shared.emit(
                    source: "input_events", app: appName, window: window,
                    type: "key_down", payload: ["key": key, "mods": mods]
                )
            }
        } else if type == .leftMouseDown {
            let loc = event.location
            Emitter.shared.emit(
                source: "input_events", app: appName, window: window,
                type: "mouse_click", payload: ["x": Int(loc.x), "y": Int(loc.y)]
            )
        }
    }
}

/// C-compatible callback (no captured context allowed).
private func inputTapCallback(
    proxy: CGEventTapProxy, type: CGEventType, event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let refcon else { return Unmanaged.passUnretained(event) }
    Unmanaged<InputTap>.fromOpaque(refcon).takeUnretainedValue().handle(type: type, event: event)
    return Unmanaged.passUnretained(event)
}

private func keyName(for code: Int64) -> String {
    switch code {
    case 36, 76: return "Enter"
    case 48: return "Tab"
    case 49: return "Space"
    case 51: return "Backspace"
    case 53: return "Escape"
    case 0: return "a"
    case 1: return "s"
    case 8: return "c"
    case 9: return "v"
    case 7: return "x"
    case 6: return "z"
    default: return "key_\(code)"
    }
}
