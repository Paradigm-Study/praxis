import CoreGraphics
import AppKit

/// Input tap (CGEventTap): observes key-down and mouse-down *timing*. For
/// privacy it emits only submit/save/copy/paste-relevant keys (Enter, Cmd-…,
/// Tab/Esc/etc.) and click coordinates — never raw typed text. The actual draft
/// content comes from the Accessibility tap, not keylogging.
final class InputTap {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?

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
            userInfo: nil
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
}

/// C-compatible callback (no captured context allowed).
private func inputTapCallback(
    proxy: CGEventTapProxy, type: CGEventType, event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown"

    if type == .keyDown {
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags
        var mods: [String] = []
        if flags.contains(.maskCommand) { mods.append("cmd") }
        if flags.contains(.maskShift) { mods.append("shift") }
        if flags.contains(.maskAlternate) { mods.append("alt") }
        if flags.contains(.maskControl) { mods.append("ctrl") }

        let key = keyName(for: code)
        // Privacy: only report meaningful control keys, not raw typing.
        let meaningful = key == "Enter" || !mods.isEmpty ||
            ["Tab", "Escape", "Backspace", "Space"].contains(key)
        if meaningful {
            Emitter.shared.emit(
                source: "input_events", app: app, window: app,
                type: "key_down", payload: ["key": key, "mods": mods]
            )
        }
    } else if type == .leftMouseDown {
        let loc = event.location
        Emitter.shared.emit(
            source: "input_events", app: app, window: app,
            type: "mouse_click", payload: ["x": Int(loc.x), "y": Int(loc.y)]
        )
    }
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
