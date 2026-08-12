// The minibar's AppKit content view.
//
// This view draws a `MinibarViewModel` and forwards control activations. It
// makes no decisions: no status inference, no timer arithmetic, no transcript
// trimming, no geometry. Everything it renders comes from
// macos/MinibarProjection.swift, so the pixels can never disagree with the
// headless projection the tests verify.

import AppKit
import Foundation

/// What the view can ask the host to do. The vocabulary is closed and mirrors
/// `MinibarControl`: there is no Pause, no share, no meeting management.
protocol MinibarViewDelegate: AnyObject {
    func minibarViewDidActivate(_ control: MinibarControl)
}

final class MinibarView: NSVisualEffectView {
    weak var delegate: MinibarViewDelegate?

    private let statusGlyph = NSTextField(labelWithString: "")
    private let statusTitle = NSTextField(labelWithString: "")
    private let timerLabel = NSTextField(labelWithString: "")
    private let stopButton = NSButton()
    private let disclosureButton = NSButton()
    private let openWorkspaceButton = NSButton()
    private let transcriptStack = NSStackView()
    private let collapsedLine = NSTextField(labelWithString: "")
    private let statusPanel = NSView()
    private var activeLayoutConstraints: [NSLayoutConstraint] = []
    private var renderedMode: SurfaceMode?
    private var model: MinibarViewModel?

    /// Minimum pointer/keyboard target, from the accessibility contract.
    private static let targetSide: CGFloat = 44
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }

    // MARK: - Construction

    private func build() {
        // This is real AppKit material over the desktop, not a painted claim of
        // transparency. A fixed dark appearance keeps text and controls legible
        // across arbitrary wallpaper while the material supplies ambient depth.
        material = .hudWindow
        blendingMode = .behindWindow
        state = .active
        appearance = NSAppearance(named: .vibrantDark)
        wantsLayer = true
        layer?.cornerRadius = 16
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.white.withAlphaComponent(0.16).cgColor
        layer?.masksToBounds = true

        statusGlyph.font = .monospacedSystemFont(ofSize: 13, weight: .semibold)
        statusGlyph.textColor = .labelColor
        statusTitle.font = .systemFont(ofSize: 13, weight: .semibold)
        statusTitle.textColor = .labelColor
        timerLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
        timerLabel.textColor = .secondaryLabelColor

        // The timer and the transcript are never live regions: an ambient
        // surface must not announce on every tick.
        timerLabel.setAccessibilityElement(false)

        configure(stopButton, control: .stop)
        configure(disclosureButton, control: .disclosure)
        configure(openWorkspaceButton, control: .openWorkspace)

        transcriptStack.orientation = .vertical
        transcriptStack.alignment = .leading
        transcriptStack.distribution = .fillEqually
        transcriptStack.spacing = 6
        transcriptStack.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        transcriptStack.wantsLayer = true
        transcriptStack.layer?.cornerRadius = 10
        transcriptStack.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.18).cgColor
        transcriptStack.layer?.borderWidth = 0.5
        transcriptStack.layer?.borderColor = NSColor.white.withAlphaComponent(0.10).cgColor
        transcriptStack.setAccessibilityElement(false)
        transcriptStack.translatesAutoresizingMaskIntoConstraints = false

        // Expanded mode uses a quiet status card opposite the transcript card.
        // It is material layering, not another capability or state source.
        statusPanel.wantsLayer = true
        statusPanel.layer?.cornerRadius = 10
        statusPanel.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.12).cgColor
        statusPanel.layer?.borderWidth = 0.5
        statusPanel.layer?.borderColor = NSColor.white.withAlphaComponent(0.08).cgColor
        statusPanel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(statusPanel)
        addSubview(transcriptStack)

        // Collapsed line: the one latest/provisional sentence stays inline.
        collapsedLine.font = .systemFont(ofSize: 12)
        collapsedLine.textColor = .secondaryLabelColor
        collapsedLine.lineBreakMode = .byTruncatingTail
        collapsedLine.maximumNumberOfLines = 1
        collapsedLine.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        for view in [statusGlyph, statusTitle, timerLabel, collapsedLine] {
            view.translatesAutoresizingMaskIntoConstraints = false
        }
        configureLayout(for: .collapsed)

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    private func configure(_ button: NSButton, control: MinibarControl) {
        button.bezelStyle = .rounded
        button.font = .systemFont(ofSize: 12, weight: .medium)
        if control == .stop {
            button.bezelColor = .systemRed
            button.contentTintColor = .white
        }
        button.target = self
        button.tag = MinibarView.tag(for: control)
        button.action = #selector(controlActivated(_:))
        button.translatesAutoresizingMaskIntoConstraints = false
        // Target size stays at least 44x44 in both dimensions.
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: MinibarView.targetSide),
            button.heightAnchor.constraint(equalToConstant: MinibarView.targetSide),
        ])
    }

    private func detach(_ view: NSView) {
        if let stack = view.superview as? NSStackView {
            stack.removeArrangedSubview(view)
        }
        view.removeFromSuperview()
    }

    /// Reparents the same semantic elements into one of two explicit layouts.
    /// Expanded coordinates come from the pure contract, so intrinsic content
    /// widths cannot pull the composition to one edge of the panel.
    private func configureLayout(for mode: SurfaceMode) {
        guard renderedMode != mode else { return }
        NSLayoutConstraint.deactivate(activeLayoutConstraints)
        activeLayoutConstraints = []
        for view in [statusGlyph, statusTitle, timerLabel, collapsedLine,
                     stopButton, disclosureButton, openWorkspaceButton] {
            detach(view)
        }

        let constraints: [NSLayoutConstraint]
        switch mode {
        case .collapsed:
            statusPanel.isHidden = true
            transcriptStack.isHidden = true
            for view in [statusGlyph, statusTitle, collapsedLine, timerLabel,
                         stopButton, disclosureButton] {
                addSubview(view)
            }
            statusTitle.font = .systemFont(ofSize: 13, weight: .semibold)
            timerLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
            constraints = [
                statusGlyph.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
                statusGlyph.centerYAnchor.constraint(equalTo: centerYAnchor),
                statusTitle.leadingAnchor.constraint(equalTo: statusGlyph.trailingAnchor, constant: 8),
                statusTitle.centerYAnchor.constraint(equalTo: centerYAnchor),
                disclosureButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
                disclosureButton.centerYAnchor.constraint(equalTo: centerYAnchor),
                stopButton.trailingAnchor.constraint(equalTo: disclosureButton.leadingAnchor, constant: -8),
                stopButton.centerYAnchor.constraint(equalTo: centerYAnchor),
                timerLabel.trailingAnchor.constraint(equalTo: stopButton.leadingAnchor, constant: -8),
                timerLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
                collapsedLine.leadingAnchor.constraint(equalTo: statusTitle.trailingAnchor, constant: 8),
                collapsedLine.trailingAnchor.constraint(lessThanOrEqualTo: timerLabel.leadingAnchor, constant: -8),
                collapsedLine.centerYAnchor.constraint(equalTo: centerYAnchor),
            ]

        case .expanded:
            let layout = MinibarLayout.expanded
            statusPanel.isHidden = false
            transcriptStack.isHidden = false
            for view in [statusGlyph, statusTitle, timerLabel, stopButton] {
                statusPanel.addSubview(view)
            }
            addSubview(disclosureButton)
            addSubview(openWorkspaceButton)
            statusTitle.font = .systemFont(ofSize: 15, weight: .semibold)
            timerLabel.font = .monospacedDigitSystemFont(ofSize: 28, weight: .medium)

            constraints = [
                statusPanel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: layout.status.x),
                statusPanel.topAnchor.constraint(equalTo: topAnchor, constant: layout.status.y),
                statusPanel.widthAnchor.constraint(equalToConstant: layout.status.width),
                statusPanel.heightAnchor.constraint(equalToConstant: layout.status.height),
                statusGlyph.leadingAnchor.constraint(equalTo: statusPanel.leadingAnchor, constant: 14),
                statusGlyph.topAnchor.constraint(equalTo: statusPanel.topAnchor, constant: 16),
                statusTitle.leadingAnchor.constraint(equalTo: statusGlyph.trailingAnchor, constant: 8),
                statusTitle.centerYAnchor.constraint(equalTo: statusGlyph.centerYAnchor),
                timerLabel.leadingAnchor.constraint(equalTo: statusPanel.leadingAnchor, constant: 14),
                timerLabel.topAnchor.constraint(equalTo: statusTitle.bottomAnchor, constant: 14),
                stopButton.leadingAnchor.constraint(equalTo: statusPanel.leadingAnchor, constant: 12),
                stopButton.trailingAnchor.constraint(equalTo: statusPanel.trailingAnchor, constant: -12),
                stopButton.bottomAnchor.constraint(equalTo: statusPanel.bottomAnchor, constant: -12),
                transcriptStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: layout.transcript.x),
                transcriptStack.topAnchor.constraint(equalTo: topAnchor, constant: layout.transcript.y),
                transcriptStack.widthAnchor.constraint(equalToConstant: layout.transcript.width),
                transcriptStack.heightAnchor.constraint(equalToConstant: layout.transcript.height),
                disclosureButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: layout.actions.x),
                disclosureButton.centerYAnchor.constraint(
                    equalTo: topAnchor,
                    constant: layout.actions.y + layout.actions.height / 2
                ),
                openWorkspaceButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
                openWorkspaceButton.centerYAnchor.constraint(equalTo: disclosureButton.centerYAnchor),
                disclosureButton.trailingAnchor.constraint(equalTo: openWorkspaceButton.leadingAnchor, constant: -8),
                disclosureButton.widthAnchor.constraint(equalTo: openWorkspaceButton.widthAnchor),
            ]
        }
        activeLayoutConstraints = constraints
        NSLayoutConstraint.activate(constraints)
        renderedMode = mode
    }

    private static func tag(for control: MinibarControl) -> Int {
        switch control {
        case .stop: return 1
        case .disclosure: return 2
        case .openWorkspace: return 3
        }
    }

    private static func control(for tag: Int) -> MinibarControl? {
        switch tag {
        case 1: return .stop
        case 2: return .disclosure
        case 3: return .openWorkspace
        default: return nil
        }
    }

    // MARK: - Rendering

    /// Render one projected view model. Called on every projection change.
    func render(_ model: MinibarViewModel) {
        self.model = model
        configureLayout(for: model.mode)

        statusGlyph.stringValue = model.glyph
        statusTitle.stringValue = model.title
        timerLabel.stringValue = model.timer ?? ""
        timerLabel.isHidden = model.timer == nil

        setAccessibilityLabel(model.accessibility.label)
        // Status is spoken, never color-only. The label is published on EVERY
        // render so the value is always correct on demand; the announcement -
        // the part VoiceOver interrupts the operator with - is posted only when
        // the projection says this is a real status change, so a one-second
        // timer tick never re-speaks a state already heard (DESIGN 9.12).
        statusTitle.setAccessibilityLabel(model.accessibility.statusAnnouncement)
        statusTitle.setAccessibilityValue(model.accessibility.statusAnnouncement)
        if model.accessibility.announces {
            NSAccessibility.post(
                element: statusTitle,
                notification: .announcementRequested,
                userInfo: [
                    .announcement: model.accessibility.statusAnnouncement,
                    // Polite: the operator is never interrupted mid-sentence.
                    .priority: NSAccessibilityPriorityLevel.medium.rawValue,
                ]
            )
        }

        for button in [stopButton, disclosureButton, openWorkspaceButton] {
            button.isHidden = true
        }
        for control in model.controls {
            guard let button = self.button(for: control.id) else { continue }
            button.isHidden = false
            button.isEnabled = control.enabled
            button.title = control.label
            button.setAccessibilityLabel(control.label)
            // A disabled control states WHY, so it is never an unexplained dead
            // target for a VoiceOver user.
            button.setAccessibilityHelp(control.help)
        }

        // Collapsed draws its single line inline; expanded uses the bounded
        // right-hand transcript region from the pure layout contract.
        let collapsed = model.mode == .collapsed
        collapsedLine.isHidden = !collapsed
        collapsedLine.stringValue = collapsed ? (model.lines.first.map(text(for:)) ?? "") : ""
        collapsedLine.alphaValue = model.lines.first?.provisional == true ? 0.7 : 1
        renderTranscript(collapsed ? [] : model.lines)
        needsDisplay = true
    }

    private func button(for control: MinibarControl) -> NSButton? {
        switch control {
        case .stop: return stopButton
        case .disclosure: return disclosureButton
        case .openWorkspace: return openWorkspaceButton
        }
    }

    private func renderTranscript(_ lines: [MinibarLine]) {
        for view in transcriptStack.arrangedSubviews {
            transcriptStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for line in lines {
            let label = NSTextField(labelWithString: text(for: line))
            label.font = .systemFont(ofSize: 12)
            label.textColor = line.provisional ? .tertiaryLabelColor : .secondaryLabelColor
            label.lineBreakMode = .byTruncatingTail
            label.maximumNumberOfLines = 1
            // Provisional text is distinguished by more than color.
            label.alphaValue = line.provisional ? 0.7 : 1
            transcriptStack.addArrangedSubview(label)
        }
    }

    /// Speaker identity is never color-only: it is rendered as text when the
    /// server actually provides it, and omitted when it does not.
    private func text(for line: MinibarLine) -> String {
        let body = line.provisional ? "\(line.text)…" : line.text
        guard let speaker = line.speaker else { return body }
        return "화자 \(speaker) · \(body)"
    }

    // MARK: - Events

    @objc private func controlActivated(_ sender: NSButton) {
        guard let control = MinibarView.control(for: sender.tag) else { return }
        delegate?.minibarViewDidActivate(control)
    }

    /// The visible Stop control, so a user-started capture can focus it.
    var stopControl: NSView { stopButton }

}
