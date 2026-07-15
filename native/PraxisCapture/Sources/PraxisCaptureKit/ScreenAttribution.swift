import CoreGraphics
import Foundation

/// Geometry-only visible-window description, separated from ScreenCaptureKit
/// so multi-display attribution can be tested without capture permission.
public struct VisibleScreenWindow {
    public let app: String
    public let title: String
    public let frame: CGRect

    public init(app: String, title: String, frame: CGRect) {
        self.app = app
        self.title = title
        self.frame = frame
    }
}

public struct DisplayFrameAttribution {
    public let app: String
    public let window: String
    public let kind: String
    public let visibleApps: [String]
    public let visibleWindows: [String]
    public let visibleContexts: [VisibleScreenWindow]
}

public enum ScreenFrameAttributor {
    /// Attribute a display to the frontmost app only when one of that app's
    /// visible windows actually intersects this display. Other monitors are
    /// explicit reference context rather than falsely claiming foreground app.
    public static func attribute(
        displayFrame: CGRect,
        displayIndex: Int,
        frontmostApp: String,
        windows: [VisibleScreenWindow],
        policyWindows: [VisibleScreenWindow]? = nil
    ) -> DisplayFrameAttribution {
        let intersecting = { (candidates: [VisibleScreenWindow]) in
            candidates.compactMap { window -> (VisibleScreenWindow, CGFloat)? in
                let intersection = displayFrame.intersection(window.frame)
                guard !intersection.isNull, intersection.width > 1, intersection.height > 1 else {
                    return nil
                }
                return (window, intersection.width * intersection.height)
            }.sorted {
                if $0.1 != $1.1 { return $0.1 > $1.1 }
                if $0.0.app != $1.0.app { return $0.0.app < $1.0.app }
                return $0.0.title < $1.0.title
            }
        }
        let visible = intersecting(windows)
        let policyVisible = intersecting(policyWindows ?? windows)

        let apps = unique(visible.map { $0.0.app }, limit: 12)
        let titles = unique(visible.map { $0.0.title }, limit: 12)
        let contexts = policyVisible.map { $0.0 }
        if let front = visible.first(where: {
            $0.0.app.localizedCaseInsensitiveCompare(frontmostApp) == .orderedSame
        })?.0 {
            return DisplayFrameAttribution(
                app: front.app,
                window: front.title.isEmpty ? front.app : front.title,
                kind: "frontmost-window",
                visibleApps: apps,
                visibleWindows: titles,
                visibleContexts: contexts
            )
        }

        if let reference = visible.first?.0 {
            return DisplayFrameAttribution(
                app: reference.app,
                window: reference.title.isEmpty ? reference.app : reference.title,
                kind: "reference-window",
                visibleApps: apps,
                visibleWindows: titles,
                visibleContexts: contexts
            )
        }

        return DisplayFrameAttribution(
            app: "unattributed",
            window: "Display \(displayIndex + 1) reference context",
            kind: "unattributed-display",
            visibleApps: apps,
            visibleWindows: titles,
            visibleContexts: contexts
        )
    }

    /// Re-check every window whose pixels intersect this display immediately
    /// before capture. A display-level label must never hide an excluded app or
    /// window that remains visible elsewhere in the same screenshot.
    public static func acquisitionAllowed(
        _ attribution: DisplayFrameAttribution,
        policy: NativePolicyChecking,
        at: Date = Date()
    ) -> Bool {
        guard policy.decision(
            source: .screenVideo,
            app: attribution.app,
            window: attribution.window,
            at: at
        ).allowed else { return false }
        return attribution.visibleContexts.allSatisfy { context in
            policy.decision(
                source: .screenVideo,
                app: context.app,
                window: context.title,
                at: at
            ).allowed
        }
    }

    private static func unique(_ values: [String], limit: Int) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for value in values where !value.isEmpty {
            let key = value.lowercased()
            if seen.insert(key).inserted { out.append(value) }
            if out.count == limit { break }
        }
        return out
    }
}
