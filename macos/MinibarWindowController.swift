// The minibar's AppKit shell: one borderless, floating, non-activating NSPanel
// that hosts MinibarView and a menu-bar NSStatusItem that mirrors capture state.
//
// This controller owns pixels, the real WebSocket task and AppKit configuration.
// It owns no product decisions: geometry comes from `NativeSurfaceGeometry`,
// status/timer/lines/controls come from `MinibarProjection`, connection and
// capture truth come from the shared `TransportClient`, and the only outbound
// frame it can produce is the existing `stopCapture` action.
//
// The browser remains the complete workspace. This surface never renders slides,
// never persists a meeting or transcript, and never becomes a second engine.

import AppKit
import Foundation

// MARK: - Saved frame

/// Saved frame memory. Deliberately the only thing this surface persists:
/// a window position is not meeting data.
///
/// Only the rect is stored. The host display is re-derived from the saved rect
/// by `NativeSurfaceGeometry.resolveFrame`, so persisting a display id would be
/// data nothing reads and nothing can keep true across a display change.
enum MinibarFrameStore {
    private static let key = "minibar.frame.v1"

    static func save(_ rect: SurfaceRect, defaults: UserDefaults = .standard) {
        defaults.set(
            ["x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height],
            forKey: key
        )
    }

    static func load(defaults: UserDefaults = .standard) -> SurfaceRect? {
        guard let raw = defaults.dictionary(forKey: key) as? [String: Double],
              let x = raw["x"], let y = raw["y"],
              let width = raw["width"], let height = raw["height"]
        else { return nil }
        return SurfaceRect(x: x, y: y, width: width, height: height)
    }
}

// MARK: - Screen bridge

enum MinibarScreens {
    /// AppKit screens as contract values. Coordinates are converted to a
    /// top-left origin space so the pure gutter/clamp rules read naturally.
    static func displays() -> [DisplayInfo] {
        let screens = NSScreen.screens
        guard let primary = screens.first else { return [] }
        let primaryTop = primary.frame.maxY
        let active = NSScreen.main
        return screens.enumerated().map { index, screen in
            let visible = screen.visibleFrame
            return DisplayInfo(
                id: index,
                frame: SurfaceRect(
                    x: Double(visible.minX),
                    y: Double(primaryTop - visible.maxY),
                    width: Double(visible.width),
                    height: Double(visible.height)
                ),
                isActive: screen == active
            )
        }
    }

    /// Convert a contract rect (top-left origin) back into AppKit coordinates.
    static func appKitRect(_ rect: SurfaceRect) -> NSRect {
        guard let primary = NSScreen.screens.first else {
            return NSRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height)
        }
        let primaryTop = primary.frame.maxY
        return NSRect(
            x: rect.x,
            y: primaryTop - rect.y - rect.height,
            width: rect.width,
            height: rect.height
        )
    }

    /// Convert an AppKit rect into a contract rect (top-left origin).
    static func contractRect(_ rect: NSRect) -> SurfaceRect {
        guard let primary = NSScreen.screens.first else {
            return SurfaceRect(
                x: Double(rect.minX), y: Double(rect.minY),
                width: Double(rect.width), height: Double(rect.height)
            )
        }
        let primaryTop = primary.frame.maxY
        return SurfaceRect(
            x: Double(rect.minX),
            y: Double(primaryTop - rect.maxY),
            width: Double(rect.width),
            height: Double(rect.height)
        )
    }
}

// MARK: - Panel

/// A borderless, non-activating panel. `canBecomeKey` is required so Stop can be
/// reached from the keyboard once the user actually interacts with the surface;
/// the panel still never activates the app on its own.
final class MinibarPanel: NSPanel {
    /// Escape handling. The panel forwards it; the decision (collapse, never
    /// stop a recording) lives in `MinibarMode`.
    var onEscape: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }
}

// MARK: - Controller

final class MinibarWindowController: NSObject, MinibarViewDelegate, NSWindowDelegate {
    /// Where the browser workspace lives; opened, never embedded.
    private let workspaceURL: URL
    private let policy = MinibarWindowPolicy()

    private var transport = TransportClient()
    private var projection = MinibarProjection()
    private var presentation = MinibarPresentationState()
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private let endpoint: URL
    private var reconnectTimer: Timer?
    private var renderTimer: Timer?
    private var statusItem: NSStatusItem?

    private let panel: MinibarPanel
    private let contentView: MinibarView

    init(port: Int) {
        endpoint = URL(string: TransportEndpoint.webSocketURL(port: port))!
        workspaceURL = URL(string: "http://localhost:\(port)/")!

        let size = SurfaceMode.collapsed.size
        contentView = MinibarView(
            frame: NSRect(x: 0, y: 0, width: size.width, height: size.height)
        )
        panel = MinibarPanel(
            contentRect: NSRect(x: 0, y: 0, width: size.width, height: size.height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        super.init()

        panel.contentView = contentView
        panel.isFloatingPanel = policy.floating
        panel.level = .floating
        panel.hidesOnDeactivate = policy.hidesOnDeactivate
        panel.isMovableByWindowBackground = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = policy.joinsAllSpaces
            ? [.canJoinAllSpaces, .fullScreenAuxiliary]
            : [.fullScreenAuxiliary]
        panel.delegate = self
        panel.setAccessibilityLabel("Meeting Slides 미니바")
        panel.onEscape = { [weak self] in self?.handleEscape() }
        contentView.delegate = self

        applyFrame(for: projection.mode)
    }

    // MARK: - Lifecycle

    /// Show the surface. `origin` decides whether the app may take OS focus:
    /// calendar-triggered capture must never steal it.
    func present(origin: CaptureOrigin) {
        applyPresentation(presentation.handle(.present), origin: origin)
    }

    private func applyPresentation(
        _ effect: MinibarPresentationEffect,
        origin: CaptureOrigin
    ) {
        switch effect {
        case .hide:
            panel.orderOut(nil)
        case .show:
            let plan = MinibarActivation.plan(origin: origin)
            guard plan.showsSurface else { return }
            if plan.activatesApp {
                panel.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                if plan.focusesStop { panel.makeFirstResponder(contentView.stopControl) }
            } else {
                panel.orderFrontRegardless()
            }
            render()
        }
    }

    func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = MinibarStatus.connecting.glyph
        item.button?.setAccessibilityLabel("Meeting Slides")
        item.button?.target = self
        item.button?.action = #selector(statusItemActivated)
        statusItem = item
    }

    @objc private func statusItemActivated() {
        // A menu-bar click is a direct user interaction, so focus may follow
        // when restoring. Visibility truth stays here rather than in NSPanel.
        applyPresentation(presentation.handle(.toggle), origin: .user)
    }

    func connect() {
        let session = URLSession(configuration: .default)
        self.session = session
        let task = session.webSocketTask(with: endpoint)
        socket = task
        task.resume()
        receiveNext()
        apply(transport.handle(.opened))
        startRenderTimer()
    }

    /// The last authoritative capture truth from the server. Used only to decide
    /// whether quitting needs confirmation; never to infer product state.
    var isCapturing: Bool {
        transport.projection.capture.phase.requiresQuitProtection
    }

    func stopConnection() {
        renderTimer?.invalidate()
        renderTimer = nil
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        session?.invalidateAndCancel()
        session = nil
    }

    // MARK: - Transport

    private func receiveNext() {
        socket?.receive { [weak self] result in
            guard let self else { return }
            DispatchQueue.main.async {
                switch result {
                case let .success(message):
                    if case let .string(payload) = message { self.ingest(payload) }
                    if case let .data(data) = message,
                       let payload = String(data: data, encoding: .utf8) {
                        self.ingest(payload)
                    }
                    self.receiveNext()
                case .failure:
                    self.apply(self.transport.handle(.closed))
                }
            }
        }
    }

    private func ingest(_ payload: String) {
        let before = transport.projection.decodeFailures
        apply(transport.handle(.received(payload)))
        let failed = transport.projection.decodeFailures > before
        projection.ingest(payload, transportDecodeFailed: failed)
        if !failed, let event = try? NativeSurfaceDecoder.decode(payload),
           case .capture = event {
            projection.applyCapture(transport.projection.capture)
        }
        render()
    }

    /// Perform the effects the pure transport asked for. `send` is the only path
    /// that puts a frame on the wire, so Stop can never be duplicated here.
    private func apply(_ effects: [TransportEffect]) {
        for effect in effects {
            switch effect {
            case let .send(frame):
                socket?.send(.string(frame)) { _ in }
            case let .scheduleReconnect(afterSeconds):
                scheduleReconnect(afterSeconds)
            }
        }
        render()
    }

    private func scheduleReconnect(_ seconds: Double) {
        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) {
            [weak self] _ in
            guard let self else { return }
            self.socket?.cancel()
            let task = self.session?.webSocketTask(with: self.endpoint)
            self.socket = task
            task?.resume()
            self.receiveNext()
            self.apply(self.transport.handle(.opened))
        }
    }

    // MARK: - Rendering

    /// The timer is re-projected once a second from the server's `startedAt`.
    /// This is a render tick, not a stopwatch: it never advances any state.
    private func startRenderTimer() {
        renderTimer?.invalidate()
        renderTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.render()
        }
    }

    private func render() {
        // `render` (not `view`) commits the announcement, so the one-second timer
        // above cannot re-speak an unchanged status on every tick.
        let model = projection.render(
            connection: transport.projection.connection,
            capture: transport.projection.capture,
            now: Date().timeIntervalSince1970 * 1000
        )
        contentView.render(model)
        statusItem?.button?.title = model.glyph
        statusItem?.button?.setAccessibilityLabel("Meeting Slides — \(model.title)")
    }

    // MARK: - Controls

    func minibarViewDidActivate(_ control: MinibarControl) {
        switch control {
        case .stop:
            apply(transport.handle(.stopActivated))
        case .disclosure:
            setMode(MinibarMode.next(from: projection.mode, event: .toggleDisclosure))
        case .openWorkspace:
            NSWorkspace.shared.open(workspaceURL)
        }
    }

    /// Escape collapses an expanded panel and never stops a recording.
    private func handleEscape() {
        setMode(MinibarMode.next(from: projection.mode, event: .escape))
    }

    private func setMode(_ mode: SurfaceMode) {
        guard mode != projection.mode else { return }
        projection.setMode(mode)
        applyFrame(for: mode)
        render()
    }

    // MARK: - Geometry

    /// Resolve and apply the panel frame through the shared contract rules.
    private func applyFrame(for mode: SurfaceMode) {
        let displays = MinibarScreens.displays()
        let saved = MinibarFrameStore.load()
        guard
            let resolved = try? NativeSurfaceGeometry.resolveFrame(
                mode: mode, savedFrame: saved, displays: displays
            )
        else {
            // No usable display information: keep the current frame rather than
            // moving the surface somewhere unverifiable.
            return
        }

        let plan = MinibarMotion.plan(
            reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        )
        let target = MinibarScreens.appKitRect(resolved.rect)
        if plan.animates {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = plan.durationSeconds
                panel.animator().setFrame(target, display: true)
            }
        } else {
            panel.setFrame(target, display: true)
        }

        // Resize is allowed only while expanded. The contract size is the frame:
        // a collapsed panel is pinned to it so content can never grow the window.
        panel.styleMask = policy.resizable(in: mode)
            ? [.borderless, .nonactivatingPanel, .resizable]
            : [.borderless, .nonactivatingPanel]
        panel.contentMinSize = target.size
        panel.contentMaxSize = policy.resizable(in: mode)
            ? NSSize(
                width: CGFloat.greatestFiniteMagnitude,
                height: CGFloat.greatestFiniteMagnitude
            )
            : target.size
        MinibarFrameStore.save(resolved.rect)
    }

    // MARK: - NSWindowDelegate

    func windowDidMove(_ notification: Notification) {
        MinibarFrameStore.save(MinibarScreens.contractRect(panel.frame))
    }

    func windowDidResize(_ notification: Notification) {
        MinibarFrameStore.save(MinibarScreens.contractRect(panel.frame))
    }
}
