// Pure minibar projection for the Meeting Slides macOS ambient surface.
//
// The AppKit shell (MinibarWindowController / MinibarView) owns pixels and
// events. Every decision it renders is made here: which explicit status the
// surface is in, what the truthful title and non-color glyph are, what the timer
// reads from the server's `startedAt`, which bounded transcript rows may show,
// which controls exist, when Stop may emit its single existing command, whether
// an activation may take OS focus, and how long a mode transition may animate.
//
// Foundation only: no AppKit, no window, no socket, no clock. `now` is always an
// injected value, so the surface can be projected deterministically from a
// headless process.
//
// This module is a *projection* of the one Bun session. It keeps at most three
// finalized rows plus one provisional row so the ambient surface can render;
// that bounded window is a viewport, never a meeting store, and an authoritative
// idle snapshot clears it.

import Foundation

// MARK: - Transcript subset

/// One transcript row as the ambient surface projects it. `speaker` is never
/// invented: absent stays absent.
public struct MinibarLine: Equatable {
    public let text: String
    public let ts: Double
    public let speaker: Int?
    public let provisional: Bool

    public init(text: String, ts: Double, speaker: Int?, provisional: Bool) {
        self.text = text
        self.ts = ts
        self.speaker = speaker
        self.provisional = provisional
    }
}

/// The transcript messages the minibar observes, on top of the capture/status
/// subset already decoded by `NativeSurfaceDecoder`.
public enum MinibarTranscriptEvent: Equatable {
    case line(MinibarLine)
    case caption(MinibarLine)
    case snapshot([MinibarLine])
}

/// How many finalized rows the expanded surface may show. Mirrors
/// `MINIBAR_LINE_LIMIT` in `public/transcript-state.ts`; both surfaces project
/// the same bounded window of the same server truth.
public let minibarLineLimit = 3

/// Bounded transcript viewport. Holds at most `minibarLineLimit` finalized rows
/// plus the single provisional row.
public struct MinibarTranscript: Equatable {
    public private(set) var finalized: [MinibarLine] = []
    public private(set) var provisional: MinibarLine?

    public init() {}

    public mutating func apply(_ event: MinibarTranscriptEvent) {
        switch event {
        case let .line(entry):
            // A finalized sentence supersedes the provisional row it grew from.
            provisional = nil
            finalized.append(entry)
            if finalized.count > minibarLineLimit {
                finalized.removeFirst(finalized.count - minibarLineLimit)
            }

        case let .caption(entry):
            provisional = entry.text.isEmpty ? nil : entry

        case let .snapshot(entries):
            // An authoritative snapshot replaces the viewport outright, so a
            // reconnect can never duplicate rows it already showed.
            provisional = nil
            finalized = Array(entries.suffix(minibarLineLimit))
        }
    }

    /// An authoritative idle snapshot ends the meeting for this surface: the
    /// ambient control holds no transcript between meetings.
    public mutating func clear() {
        finalized = []
        provisional = nil
    }

    /// Rows for a mode, newest last. Collapsed shows one row and prefers the
    /// provisional caption; expanded shows up to three finals plus the caption.
    public func rows(for mode: SurfaceMode) -> [MinibarLine] {
        switch mode {
        case .collapsed:
            if let provisional { return [provisional] }
            guard let latest = finalized.last else { return [] }
            return [latest]
        case .expanded:
            var rows = finalized
            if let provisional { rows.append(provisional) }
            return rows
        }
    }
}

/// Decoder for the transcript subset. Anything malformed is a typed failure that
/// leaves the current viewport untouched.
public enum MinibarTranscriptDecoder {
    public static func decode(_ payload: String) throws -> MinibarTranscriptEvent? {
        guard let data = payload.data(using: .utf8) else { throw DecodeFailure.malformedPayload }
        guard
            let parsed = try? JSONSerialization.jsonObject(with: data, options: []),
            let object = parsed as? [String: Any],
            let type = object["type"] as? String
        else { throw DecodeFailure.malformedPayload }

        switch type {
        case "line":
            return .line(try entry(from: object, provisional: false))
        case "caption":
            return .caption(try entry(from: object, provisional: true))
        case "transcript":
            guard let rawEntries = object["entries"] as? [Any] else {
                throw DecodeFailure.malformedPayload
            }
            let entries = try rawEntries.map { raw -> MinibarLine in
                guard let item = raw as? [String: Any] else { throw DecodeFailure.malformedPayload }
                return try entry(from: item, provisional: false)
            }
            return .snapshot(entries)
        default:
            return nil
        }
    }

    private static func entry(from object: [String: Any], provisional: Bool) throws -> MinibarLine {
        guard let text = object["text"] as? String else { throw DecodeFailure.malformedPayload }
        guard let ts = object["ts"] as? NSNumber else { throw DecodeFailure.malformedPayload }
        var speaker: Int?
        if let raw = object["speaker"], !(raw is NSNull) {
            guard let number = raw as? NSNumber else { throw DecodeFailure.malformedPayload }
            speaker = number.intValue
        }
        return MinibarLine(
            text: text, ts: ts.doubleValue, speaker: speaker, provisional: provisional
        )
    }
}

// MARK: - Explicit status

/// Every state the ambient surface can truthfully be in. Nothing is inferred
/// from text content or view visibility.
public enum MinibarStatus: String, Equatable {
    case connecting
    case idle
    case starting
    case live
    case stopping
    case switchingModel = "switching-model"
    case reconnecting
    case error

    /// Non-color cue. Status is never conveyed by color alone.
    public var glyph: String {
        switch self {
        case .connecting: return "…"
        case .idle: return "○"
        case .starting: return "◔"
        case .live: return "●"
        case .stopping: return "◼"
        case .switchingModel: return "⇄"
        case .reconnecting: return "↻"
        case .error: return "!"
        }
    }

    /// Korean product copy, one distinct title per state.
    public var title: String {
        switch self {
        case .connecting: return "연결 중"
        case .idle: return "대기 중"
        case .starting: return "녹음 준비 중"
        case .live: return "녹음 중"
        case .stopping: return "녹음 종료 중"
        case .switchingModel: return "모델 전환 중"
        case .reconnecting: return "연결 끊김 — 재연결 중"
        case .error: return "오류"
        }
    }
}

// MARK: - Controls

public enum MinibarControl: String, Equatable, CaseIterable {
    case stop
    case disclosure
    case openWorkspace
    case close

    /// The complete, closed control vocabulary. There is no Pause, no share,
    /// no meeting management: those live in the browser workspace. Close hides
    /// this ambient surface without stopping capture or quitting the app.
    public static var vocabulary: [String] { allCases.map(\.rawValue) }
}

public struct MinibarControlState: Equatable {
    public let id: MinibarControl
    public let enabled: Bool
    public let label: String
    /// Why this control is in its current state, in the operator's language.
    ///
    /// A disabled control that gives no reason is an unexplained dead target:
    /// the native counterpart of the browser contract's "disabled reasons stay
    /// in `title`/`aria-label`" rule (DESIGN 9.11/9.12). It is never empty, so
    /// the AppKit shell never has to invent copy for a state it did not decide.
    public let help: String

    public init(id: MinibarControl, enabled: Bool, label: String, help: String) {
        self.id = id
        self.enabled = enabled
        self.label = label
        self.help = help
    }
}

// MARK: - Motion

public enum MinibarMotion {
    /// Mode transition budget from the design contract (§9.6, 200ms).
    public static let transitionSeconds: Double = 0.2

    public struct Plan: Equatable {
        public let durationSeconds: Double
        public let animates: Bool
    }

    /// Reduced motion removes the transition entirely rather than shortening it.
    public static func plan(reduceMotion: Bool) -> Plan {
        reduceMotion
            ? Plan(durationSeconds: 0, animates: false)
            : Plan(durationSeconds: transitionSeconds, animates: true)
    }
}

// MARK: - Activation policy

/// Why the surface is being shown. Calendar-triggered capture must never steal
/// OS focus; a user action on this machine may.
public enum CaptureOrigin: String, Equatable {
    case user
    case automatic
}

public struct ActivationPlan: Equatable {
    public let showsSurface: Bool
    public let activatesApp: Bool
    public let focusesStop: Bool
}

public enum MinibarActivation {
    /// `userInteracted` marks a later direct interaction with the surface, which
    /// converts an ambient automatic capture into a focusable one.
    public static func plan(origin: CaptureOrigin, userInteracted: Bool = false) -> ActivationPlan {
        let takesFocus = origin == .user || userInteracted
        return ActivationPlan(
            showsSurface: true, activatesApp: takesFocus, focusesStop: takesFocus
        )
    }
}

// MARK: - Window policy

/// What the AppKit shell must configure. Kept here so the panel cannot quietly
/// drift from the contract and so it is assertable without a GUI session.
public struct MinibarWindowPolicy: Equatable {
    public let borderless = true
    public let floating = true
    public let nonActivating = true
    public let hidesOnDeactivate = false
    public let joinsAllSpaces = true
    /// The Dock identity of the app is unchanged by the minibar.
    public let dockIdentityChanged = false
    /// Pointer movement required before a drag begins.
    public let dragThreshold: Double = 4

    public init() {}

    public func resizable(in mode: SurfaceMode) -> Bool { mode == .expanded }
}

// MARK: - Mode transitions

public enum MinibarModeEvent: Equatable {
    case toggleDisclosure
    case escape
}

public enum MinibarMode {
    /// Escape collapses an expanded panel and is otherwise a no-op. Escape never
    /// stops a recording, so no outbound action is ever produced here.
    public static func next(from mode: SurfaceMode, event: MinibarModeEvent) -> SurfaceMode {
        switch event {
        case .toggleDisclosure:
            return mode == .collapsed ? .expanded : .collapsed
        case .escape:
            return .collapsed
        }
    }
}

// MARK: - Accessibility

public struct MinibarAccessibility: Equatable {
    public let role = "group"
    public let label = "Meeting Slides 미니바"
    public let statusAnnouncement: String
    /// The timer and the provisional caption are never live regions.
    public let timerIsLiveRegion = false
    public let transcriptIsLiveRegion = false
    public let minimumTargetSize = SurfaceSize(width: 44, height: 44)
    public let focusOrder: [String]
    /// True only on the render where `statusAnnouncement` differs from the one
    /// this surface last spoke.
    ///
    /// The AppKit shell re-renders on every projection change, including every
    /// one-second timer tick. Republishing the status label on each render makes
    /// VoiceOver speak "녹음 중" once per second forever, which is the native
    /// form of the duplicate-announcement defect DESIGN 9.12 forbids. The
    /// decision therefore lives here, beside the state it is about, instead of
    /// being re-derived by the view.
    public let announces: Bool

    public init(statusAnnouncement: String, focusOrder: [String], announces: Bool) {
        self.statusAnnouncement = statusAnnouncement
        self.focusOrder = focusOrder
        self.announces = announces
    }
}

// MARK: - Expanded layout

/// Exact 560x220 progressive-disclosure composition in the same top-left
/// coordinate space as `SurfaceRect`. The left region carries capture status
/// and Stop; the right region carries bounded transcript content and the two
/// disclosure actions. AppKit consumes these values instead of relying on
/// intrinsic stack widths, which previously packed the entire HUD to the right.
public struct MinibarExpandedLayout: Equatable {
    public let surface: SurfaceRect
    public let content: SurfaceRect
    public let status: SurfaceRect
    public let transcript: SurfaceRect
    public let actions: SurfaceRect
    public let columnGap: Double
    public let rowGap: Double
}

public enum MinibarLayout {
    public static let expanded = MinibarExpandedLayout(
        surface: SurfaceRect(x: 0, y: 0, width: 560, height: 220),
        content: SurfaceRect(x: 12, y: 12, width: 536, height: 196),
        status: SurfaceRect(x: 12, y: 12, width: 176, height: 196),
        transcript: SurfaceRect(x: 200, y: 12, width: 348, height: 140),
        actions: SurfaceRect(x: 200, y: 160, width: 348, height: 48),
        columnGap: 12,
        rowGap: 8
    )
}

// MARK: - View model

/// Everything the AppKit shell draws, derived from transport + transcript state.
public struct MinibarViewModel: Equatable {
    public let mode: SurfaceMode
    public let status: MinibarStatus
    public let glyph: String
    public let title: String
    /// `nil` when the server has given no `startedAt`: no invented timer.
    public let timer: String?
    /// The authoritative capture phase, retained even while reconnecting.
    public let capturePhase: CapturePhase
    public let lines: [MinibarLine]
    public let controls: [MinibarControlState]
    /// Machine reason for the most recent decode failure, when the surface is
    /// in `error`.
    public let errorReason: String?
    public let accessibility: MinibarAccessibility

    public var size: SurfaceSize { mode.size }
}

/// Formats elapsed recording time from the server's `startedAt`. There is no
/// native stopwatch: `now` is always supplied by the caller.
public enum MinibarTimer {
    public static func text(startedAt: Double?, now: Double) -> String? {
        guard let startedAt else { return nil }
        let elapsed = Swift.max(0, (now - startedAt) / 1000)
        let total = Int(elapsed.rounded(.down))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }
        return String(format: "%02d:%02d", minutes, seconds)
    }
}

/// The projection itself: transport state in, view model out.
public struct MinibarProjection {
    public private(set) var mode: SurfaceMode
    public private(set) var transcript = MinibarTranscript()
    /// Set only by an authoritative capture snapshot; a transport drop never
    /// clears it, so reconnecting keeps the known capture truth.
    private var hydrated = false
    private var lastDecodeFailure: DecodeFailure?
    /// Cleared by the next well-formed server message.
    private var errorSticky = false
    /// Payloads this surface rejected. Counted here rather than reusing the
    /// transport's counter, because the two modules observe different subsets:
    /// a `line` with a wrongly typed field is outside the transport's subset but
    /// is a real rejection for the minibar, and neither may hide the other.
    public private(set) var decodeFailures = 0
    /// The last announcement this surface actually spoke. `nil` until the first
    /// one, so the first resolved state is announced rather than swallowed.
    private var lastSpokenAnnouncement: String?

    public init(mode: SurfaceMode = .collapsed) {
        self.mode = mode
    }

    public mutating func setMode(_ next: SurfaceMode) { mode = next }

    public mutating func handleMode(_ event: MinibarModeEvent) {
        mode = MinibarMode.next(from: mode, event: event)
    }

    /// Feed a raw server payload. Capture/status decoding stays in the shared
    /// `NativeSurfaceDecoder`; only the transcript subset is decoded here.
    /// Returns nothing: failures are recorded, never thrown at the shell.
    public mutating func ingest(_ payload: String, transportDecodeFailed: Bool) {
        if transportDecodeFailed {
            lastDecodeFailure = .malformedPayload
            errorSticky = true
            decodeFailures += 1
            return
        }
        do {
            if let event = try MinibarTranscriptDecoder.decode(payload) {
                transcript.apply(event)
                errorSticky = false
                lastDecodeFailure = nil
            }
        } catch let failure as DecodeFailure {
            lastDecodeFailure = failure
            errorSticky = true
            decodeFailures += 1
        } catch {
            lastDecodeFailure = .malformedPayload
            errorSticky = true
            decodeFailures += 1
        }
    }

    /// Apply an authoritative capture snapshot from the server.
    public mutating func applyCapture(_ capture: CaptureProjection) {
        hydrated = true
        errorSticky = false
        lastDecodeFailure = nil
        if capture.phase == .idle { transcript.clear() }
    }

    /// Project the current view model.
    ///
    /// `connection` and `capture` come from the shared `TransportProjection`, so
    /// the minibar and the launcher can never disagree about the one session.
    ///
    /// Pure: this never records what was spoken, so `announces` describes what
    /// WOULD be announced if this model were rendered. A caller that actually
    /// renders must use `render(connection:capture:now:)`, which commits the
    /// announcement exactly once.
    public func view(
        connection: ConnectionState,
        capture: CaptureProjection,
        now: Double
    ) -> MinibarViewModel {
        let status = self.status(connection: connection, capture: capture)
        let timer = MinibarTimer.text(startedAt: capture.startedAt, now: now)
        let controls = self.controls(status: status, capture: capture)
        let reason = status == .error ? lastDecodeFailure?.rawValue : nil
        let announcement = self.announcement(status: status, reason: reason)
        return MinibarViewModel(
            mode: mode,
            status: status,
            glyph: status.glyph,
            title: status.title,
            timer: timer,
            capturePhase: capture.phase,
            lines: transcript.rows(for: mode),
            controls: controls,
            errorReason: reason,
            accessibility: MinibarAccessibility(
                statusAnnouncement: announcement,
                focusOrder: controls.map(\.id.rawValue),
                announces: announcement != lastSpokenAnnouncement
            )
        )
    }

    /// Project the current view model AND commit its announcement.
    ///
    /// This is what the AppKit shell calls: the next render of an unchanged
    /// status reports `announces == false`, so a per-second timer tick can never
    /// re-speak a state the operator already heard.
    public mutating func render(
        connection: ConnectionState,
        capture: CaptureProjection,
        now: Double
    ) -> MinibarViewModel {
        let model = view(connection: connection, capture: capture, now: now)
        if model.accessibility.announces {
            lastSpokenAnnouncement = model.accessibility.statusAnnouncement
        }
        return model
    }

    /// What the status region says. An error carries its machine reason with it,
    /// so the failure is actionable in the surface rather than only in a log
    /// (DESIGN 9.13).
    private func announcement(status: MinibarStatus, reason: String?) -> String {
        guard let reason, status == .error else { return status.title }
        return "\(status.title) — \(reason)"
    }

    /// Status resolution order: an unresolved transport wins over capture phase,
    /// because the surface must not claim a phase it cannot currently confirm.
    /// The underlying capture truth is still carried in the view model.
    private func status(
        connection: ConnectionState,
        capture: CaptureProjection
    ) -> MinibarStatus {
        switch connection {
        case .connecting:
            return hydrated ? phaseStatus(capture.phase) : .connecting
        case .reconnecting:
            return .reconnecting
        case .online:
            if errorSticky { return .error }
            return hydrated ? phaseStatus(capture.phase) : .connecting
        }
    }

    private func phaseStatus(_ phase: CapturePhase) -> MinibarStatus {
        switch phase {
        case .idle: return .idle
        case .starting: return .starting
        case .capturing: return .live
        case .stopping: return .stopping
        case .switchingModel: return .switchingModel
        }
    }

    /// Stop is always present and always truthful: enabled only when there is a
    /// live capture this surface can actually stop over an open socket.
    private func controls(
        status: MinibarStatus,
        capture: CaptureProjection
    ) -> [MinibarControlState] {
        let stoppable = (status == .live || status == .starting)
        // The exact machine reason a disabled Stop is disabled. Each branch names
        // a real, distinct condition rather than one generic apology.
        let stopHelp: String
        if stoppable {
            stopHelp = "진행 중인 녹음을 중지합니다"
        } else {
            switch status {
            case .reconnecting: stopHelp = "연결이 끊겨 중지 요청을 보낼 수 없습니다"
            case .connecting: stopHelp = "앱 서버에 연결하는 중입니다"
            case .stopping: stopHelp = "이미 녹음을 종료하는 중입니다"
            case .switchingModel: stopHelp = "모델을 전환하는 중입니다"
            case .error: stopHelp = "서버 상태를 확인할 수 없습니다"
            default: stopHelp = "중지할 녹음이 없습니다"
            }
        }
        var controls: [MinibarControlState] = [
            MinibarControlState(
                id: .stop, enabled: stoppable, label: "녹음 중지", help: stopHelp
            ),
            MinibarControlState(
                id: .disclosure,
                enabled: true,
                label: mode == .collapsed ? "미니바 펼치기" : "미니바 접기",
                help: mode == .collapsed
                    ? "최근 발언과 작업 공간 열기를 함께 봅니다"
                    : "미니바를 한 줄 높이로 접습니다"
            ),
        ]
        if mode == .expanded {
            controls.append(
                MinibarControlState(
                    id: .openWorkspace,
                    enabled: true,
                    label: "작업 공간 열기",
                    help: "브라우저에서 전체 작업 공간을 엽니다"
                )
            )
        }
        controls.append(
            MinibarControlState(
                id: .close,
                enabled: true,
                label: "닫기",
                help: "미니바를 숨깁니다. 메뉴 막대에서 다시 열 수 있습니다"
            )
        )
        return controls
    }
}
