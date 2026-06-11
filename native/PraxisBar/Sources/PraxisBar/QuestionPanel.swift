import AppKit

/// Praxis-owned question surface: a floating glass card in the top-right of
/// the main screen with the agent's question, tappable options, and a free-text
/// field. It exists because system notifications proved unreliable in practice
/// — Focus/DND, screen sharing/mirroring, and 5-second banners on one display
/// all silently swallow them, and the agent's whole loop depends on answers.
/// A floating panel has none of those failure modes.
///
/// Visual language matches the Studio: real vibrancy glass (NSVisualEffectView,
/// behind-window blending), hairline borders, SF Pro hierarchy, one blue accent.
/// Borderless windows refuse key status by default, which silently kills the
/// free-text field (you can click it but never type). This panel stays
/// non-activating — it only takes key when the user clicks into it.
private final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class QuestionPanel: NSObject, NSWindowDelegate {
    static let shared = QuestionPanel()

    struct Q {
        let id: String
        let question: String
        let options: [String]
    }

    /// Called with (question, answerText) when the user answers.
    var onAnswer: ((Q, String) -> Void)?
    /// Called whenever the number of waiting questions changes (badge updates).
    var onQueueChange: ((Int) -> Void)?

    private var queue: [Q] = []
    private var current: Q?
    private var panel: NSPanel?
    private var textField: NSTextField?
    private var shownIds = Set<String>()

    var waitingCount: Int { queue.count + (current == nil ? 0 : 1) }

    func enqueue(_ q: Q) {
        DispatchQueue.main.async {
            guard !self.shownIds.contains(q.id) else { return }
            self.shownIds.insert(q.id)
            if self.current == nil {
                self.show(q)
            } else {
                self.queue.append(q)
            }
            self.onQueueChange?(self.waitingCount)
        }
    }

    /// The same question may also ride a system notification; if it was
    /// answered there, retract it here.
    func retract(id: String) {
        DispatchQueue.main.async {
            self.queue.removeAll { $0.id == id }
            if self.current?.id == id { self.advance() }
            self.onQueueChange?(self.waitingCount)
        }
    }

    // MARK: - Internals (main thread only)

    private func show(_ q: Q) {
        current = q
        let p = panel ?? makePanel()
        panel = p
        p.contentView = buildContent(q)
        p.layoutIfNeeded()
        position(p)
        p.alphaValue = 0
        p.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.22
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            p.animator().alphaValue = 1
        }
    }

    private func advance() {
        current = nil
        if queue.isEmpty {
            panel?.orderOut(nil)
        } else {
            show(queue.removeFirst())
        }
        onQueueChange?(waitingCount)
    }

    @objc private func optionTapped(_ sender: NSButton) {
        guard let q = current, sender.tag < q.options.count else { return }
        onAnswer?(q, q.options[sender.tag])
        advance()
    }

    @objc private func sendTapped(_: Any?) {
        guard let q = current,
              let text = textField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else { return }
        onAnswer?(q, text)
        advance()
    }

    @objc private func laterTapped(_: Any?) {
        // Not an answer — just get out of the way. The question stays pending
        // in the Studio; the badge keeps the count visible.
        if let q = current { queue.append(q) }
        current = nil
        panel?.orderOut(nil)
        onQueueChange?(waitingCount)
    }

    private func makePanel() -> NSPanel {
        let p = KeyablePanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 200),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: true)
        p.isFloatingPanel = true
        p.level = .floating
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.becomesKeyOnlyIfNeeded = true
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.isMovableByWindowBackground = true
        p.delegate = self
        return p
    }

    private func buildContent(_ q: Q) -> NSView {
        // Glass: vibrancy of whatever is behind the panel, dark HUD material.
        // Forced dark + a dim backing between blur and content: behind-window
        // vibrancy alone goes white-on-white over a light page, and the text
        // becomes unreadable. The dim keeps the refraction but guarantees
        // contrast regardless of what's behind.
        let glass = NSVisualEffectView()
        glass.material = .hudWindow
        glass.state = .active
        glass.blendingMode = .behindWindow
        glass.appearance = NSAppearance(named: .darkAqua)
        glass.wantsLayer = true
        glass.layer?.cornerRadius = 18
        glass.layer?.cornerCurve = .continuous
        glass.layer?.masksToBounds = true
        glass.layer?.borderWidth = 1
        glass.layer?.borderColor = NSColor.white.withAlphaComponent(0.16).cgColor

        let dim = NSView()
        dim.wantsLayer = true
        dim.layer?.backgroundColor = NSColor(red: 0.03, green: 0.04, blue: 0.06, alpha: 0.62).cgColor
        glass.addSubview(dim)
        dim.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            dim.topAnchor.constraint(equalTo: glass.topAnchor),
            dim.bottomAnchor.constraint(equalTo: glass.bottomAnchor),
            dim.leadingAnchor.constraint(equalTo: glass.leadingAnchor),
            dim.trailingAnchor.constraint(equalTo: glass.trailingAnchor),
        ])

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 18, bottom: 16, right: 18)

        // Header: glowing accent dot + tracked-out smallcaps wordmark.
        let head = NSStackView()
        head.orientation = .horizontal
        head.spacing = 7
        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.backgroundColor = NSColor.systemBlue.cgColor
        dot.layer?.cornerRadius = 3.5
        dot.layer?.shadowColor = NSColor.systemBlue.cgColor
        dot.layer?.shadowOpacity = 0.9
        dot.layer?.shadowRadius = 5
        dot.layer?.shadowOffset = .zero
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 7).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 7).isActive = true
        let brand = NSTextField(labelWithString: "PRAXIS · QUICK CHECK")
        brand.font = .systemFont(ofSize: 10, weight: .semibold)
        brand.textColor = NSColor.white.withAlphaComponent(0.45)
        if let f = brand.font {
            brand.attributedStringValue = NSAttributedString(
                string: "PRAXIS · QUICK CHECK",
                attributes: [.font: f, .kern: 1.6,
                             .foregroundColor: NSColor.white.withAlphaComponent(0.45)])
        }
        head.addArrangedSubview(dot)
        head.addArrangedSubview(brand)
        stack.addArrangedSubview(head)

        // The question, SF Pro at reading weight.
        let label = NSTextField(wrappingLabelWithString: q.question)
        label.font = .systemFont(ofSize: 13.5, weight: .medium)
        label.textColor = NSColor.white.withAlphaComponent(0.94)
        label.preferredMaxLayoutWidth = 384
        stack.addArrangedSubview(label)
        stack.setCustomSpacing(13, after: label)

        for (i, opt) in q.options.prefix(4).enumerated() {
            let b = GlassButton(title: opt, accent: false)
            b.target = self
            b.action = #selector(optionTapped(_:))
            b.tag = i
            stack.addArrangedSubview(b)
            b.widthAnchor.constraint(lessThanOrEqualToConstant: 384).isActive = true
        }
        if let last = stack.arrangedSubviews.last { stack.setCustomSpacing(13, after: last) }

        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 7

        // Free-text answer: a rounded glass well wrapping a borderless field.
        let well = NSView()
        well.wantsLayer = true
        well.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.3).cgColor
        well.layer?.cornerRadius = 14
        well.layer?.cornerCurve = .continuous
        well.layer?.borderWidth = 1
        well.layer?.borderColor = NSColor.white.withAlphaComponent(0.1).cgColor
        let tf = NSTextField(string: "")
        tf.placeholderString = "Type your own answer…"
        tf.font = .systemFont(ofSize: 12.5)
        tf.textColor = NSColor.white.withAlphaComponent(0.94)
        tf.isBezeled = false
        tf.drawsBackground = false
        tf.focusRingType = .none
        tf.target = self
        tf.action = #selector(sendTapped(_:)) // Enter sends
        textField = tf
        well.addSubview(tf)
        tf.translatesAutoresizingMaskIntoConstraints = false
        well.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            tf.leadingAnchor.constraint(equalTo: well.leadingAnchor, constant: 12),
            tf.trailingAnchor.constraint(equalTo: well.trailingAnchor, constant: -12),
            tf.centerYAnchor.constraint(equalTo: well.centerYAnchor),
            well.heightAnchor.constraint(equalToConstant: 28),
            well.widthAnchor.constraint(greaterThanOrEqualToConstant: 220),
        ])

        let send = GlassButton(title: "Send", accent: true)
        send.target = self
        send.action = #selector(sendTapped(_:))
        let later = GlassButton(title: "Later", accent: false, subdued: true)
        later.target = self
        later.action = #selector(laterTapped(_:))

        row.addArrangedSubview(well)
        row.addArrangedSubview(send)
        row.addArrangedSubview(later)
        stack.addArrangedSubview(row)

        glass.addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: glass.topAnchor),
            stack.bottomAnchor.constraint(equalTo: glass.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: glass.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: glass.trailingAnchor),
            glass.widthAnchor.constraint(equalToConstant: 420),
        ])
        return glass
    }

    private func position(_ p: NSPanel) {
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let f = screen.visibleFrame
        let size = p.contentView?.fittingSize ?? NSSize(width: 420, height: 200)
        p.setContentSize(size)
        let origin = NSPoint(
            x: f.maxX - size.width - 18,
            y: f.maxY - size.height - 18)
        p.setFrameOrigin(origin)
    }
}

/// A pill button drawn in the panel's glass language: hairline border, faint
/// fill, hover brighten. `accent` fills it Apple-blue (the primary action).
final class GlassButton: NSButton {
    private let accent: Bool
    private let subdued: Bool

    init(title: String, accent: Bool, subdued: Bool = false) {
        self.accent = accent
        self.subdued = subdued
        super.init(frame: .zero)
        self.title = title
        isBordered = false
        wantsLayer = true
        font = .systemFont(ofSize: 12, weight: accent ? .semibold : .regular)
        layer?.cornerRadius = 14
        layer?.cornerCurve = .continuous
        layer?.borderWidth = 1
        setColors(hover: false)

        // Vertical padding via intrinsic size; horizontal via title insets.
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 28).isActive = true

        let area = NSTrackingArea(
            rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self, userInfo: nil)
        addTrackingArea(area)
    }

    required init?(coder: NSCoder) { fatalError("unused") }

    override var intrinsicContentSize: NSSize {
        var s = super.intrinsicContentSize
        s.width += 26
        s.height = 28
        return s
    }

    private func setColors(hover: Bool) {
        let textColor: NSColor
        if accent {
            layer?.backgroundColor = NSColor.systemBlue
                .withAlphaComponent(hover ? 1.0 : 0.85).cgColor
            layer?.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor
            textColor = .white
        } else {
            layer?.backgroundColor = NSColor.white
                .withAlphaComponent(hover ? 0.14 : 0.07).cgColor
            layer?.borderColor = NSColor.white
                .withAlphaComponent(hover ? 0.28 : 0.12).cgColor
            textColor = NSColor.white.withAlphaComponent(subdued ? 0.55 : 0.9)
        }
        attributedTitle = NSAttributedString(
            string: title,
            attributes: [.font: font as Any, .foregroundColor: textColor])
    }

    override func mouseEntered(with event: NSEvent) { setColors(hover: true) }
    override func mouseExited(with event: NSEvent) { setColors(hover: false) }
}
