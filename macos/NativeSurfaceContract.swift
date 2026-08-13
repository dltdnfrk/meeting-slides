// Pure native surface contract for the Meeting Slides macOS minibar.
//
// This module holds the state and geometry rules that the AppKit panel later
// obeys. It deliberately imports Foundation only: no AppKit, no window creation,
// no screen queries, no clock, no networking. Displays, saved frames and server
// payloads all arrive as values, so every rule is testable from a headless
// process without a GUI session.
//
// Native state is a *projection* of server state plus transient transport
// status. This module never becomes a second meeting store.

import Foundation

// MARK: - Geometry

public struct SurfaceSize: Equatable {
    public let width: Double
    public let height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

public struct SurfaceRect: Equatable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var minX: Double { x }
    public var minY: Double { y }
    public var maxX: Double { x + width }
    public var maxY: Double { y + height }
    public var area: Double { width * height }

    /// Overlap area with another rect. Zero when they do not intersect.
    public func intersectionArea(with other: SurfaceRect) -> Double {
        let overlapWidth = Swift.max(0, Swift.min(maxX, other.maxX) - Swift.max(minX, other.minX))
        let overlapHeight = Swift.max(0, Swift.min(maxY, other.maxY) - Swift.max(minY, other.minY))
        return overlapWidth * overlapHeight
    }
}

/// A display as reported by the host app. `isActive` marks the display that owns
/// the current key window / menu bar at the moment the frame is resolved.
public struct DisplayInfo: Equatable {
    public let id: Int
    public let frame: SurfaceRect
    public let isActive: Bool

    public init(id: Int, frame: SurfaceRect, isActive: Bool) {
        self.id = id
        self.frame = frame
        self.isActive = isActive
    }
}

public enum SurfaceMode: String, Equatable {
    case collapsed
    case expanded

    /// Locked minibar bounds. Collapsed shows recording state, timer, one line
    /// and Stop; expanded adds up to three finalized lines and Open Workspace.
    public var size: SurfaceSize {
        switch self {
        case .collapsed: return SurfaceSize(width: 360, height: 56)
        case .expanded: return SurfaceSize(width: 560, height: 220)
        }
    }
}

public struct ResolvedFrame: Equatable {
    public let rect: SurfaceRect
    public let displayId: Int
    /// True when the saved frame was accepted (possibly after clamping),
    /// false when the deterministic default was used instead.
    public let usedSavedFrame: Bool
}

public enum GeometryFailure: String, Error, Equatable {
    case noActiveDisplay
    case invalidDisplayBounds
}

public enum NativeSurfaceGeometry {
    /// Minimum distance between the surface and every edge of its display.
    public static let displayGutter: Double = 16

    /// A saved frame must keep at least this fraction of its area on a display
    /// to be considered restorable; otherwise the default frame wins.
    public static let minimumVisibleFraction: Double = 0.5

    public static func size(for mode: SurfaceMode) -> SurfaceSize { mode.size }

    /// Resolve the frame the panel should occupy.
    ///
    /// Rules, in order:
    /// 1. Every display must have positive, finite bounds able to hold the
    ///    surface plus its gutters, otherwise a typed failure is thrown.
    /// 2. A saved frame keeping >= 50% of its area on some display is restored
    ///    on that display, resized to the mode bounds and clamped into gutters.
    /// 3. Anything else falls back to the deterministic default: bottom-trailing
    ///    corner of the active display, inset by the gutter.
    public static func resolveFrame(
        mode: SurfaceMode,
        savedFrame: SurfaceRect?,
        displays: [DisplayInfo]
    ) throws -> ResolvedFrame {
        guard !displays.isEmpty else { throw GeometryFailure.noActiveDisplay }

        let size = mode.size
        for display in displays {
            let f = display.frame
            guard
                f.width.isFinite, f.height.isFinite, f.x.isFinite, f.y.isFinite,
                f.width > 0, f.height > 0,
                f.width >= size.width + 2 * displayGutter,
                f.height >= size.height + 2 * displayGutter
            else {
                throw GeometryFailure.invalidDisplayBounds
            }
        }

        guard let active = displays.first(where: { $0.isActive }) ?? displays.first else {
            throw GeometryFailure.noActiveDisplay
        }

        if let saved = savedFrame, isUsable(saved) {
            if let host = hostDisplay(for: saved, in: displays) {
                let resized = SurfaceRect(
                    x: saved.x, y: saved.y, width: size.width, height: size.height
                )
                return ResolvedFrame(
                    rect: clamp(resized, into: host.frame),
                    displayId: host.id,
                    usedSavedFrame: true
                )
            }
        }

        return ResolvedFrame(
            rect: defaultFrame(size: size, on: active.frame),
            displayId: active.id,
            usedSavedFrame: false
        )
    }

    /// Deterministic default: bottom-trailing corner, one gutter from each edge.
    public static func defaultFrame(size: SurfaceSize, on display: SurfaceRect) -> SurfaceRect {
        SurfaceRect(
            x: display.maxX - displayGutter - size.width,
            y: display.maxY - displayGutter - size.height,
            width: size.width,
            height: size.height
        )
    }

    /// Keep the whole surface inside the display, honoring the gutter on all sides.
    public static func clamp(_ rect: SurfaceRect, into display: SurfaceRect) -> SurfaceRect {
        let minX = display.minX + displayGutter
        let maxX = display.maxX - displayGutter - rect.width
        let minY = display.minY + displayGutter
        let maxY = display.maxY - displayGutter - rect.height
        return SurfaceRect(
            x: Swift.min(Swift.max(rect.x, minX), Swift.max(minX, maxX)),
            y: Swift.min(Swift.max(rect.y, minY), Swift.max(minY, maxY)),
            width: rect.width,
            height: rect.height
        )
    }

    private static func isUsable(_ rect: SurfaceRect) -> Bool {
        rect.x.isFinite && rect.y.isFinite
            && rect.width.isFinite && rect.height.isFinite
            && rect.width > 0 && rect.height > 0
    }

    /// The display holding the largest share of the saved frame, provided that
    /// share reaches the visibility threshold.
    private static func hostDisplay(
        for saved: SurfaceRect,
        in displays: [DisplayInfo]
    ) -> DisplayInfo? {
        var best: (display: DisplayInfo, area: Double)?
        for display in displays {
            let overlap = saved.intersectionArea(with: display.frame)
            if overlap <= 0 { continue }
            if best == nil || overlap > best!.area { best = (display, overlap) }
        }
        guard let winner = best, saved.area > 0 else { return nil }
        return winner.area / saved.area >= minimumVisibleFraction ? winner.display : nil
    }
}

// MARK: - Presentation

/// Controller-owned visibility truth for the non-activating panel. AppKit can
/// report stale `isVisible` values for this window style, so menu-bar toggles
/// advance this state and treat the resulting effect as authoritative.
public enum MinibarVisibility: String, Equatable {
    case hidden
    case visible
}

public enum MinibarPresentationEvent: Equatable {
    case present
    case toggle
    case dismiss
}

public enum MinibarPresentationEffect: String, Equatable {
    case show
    case hide
}

public struct MinibarPresentationState {
    public private(set) var visibility: MinibarVisibility = .hidden

    public init() {}

    @discardableResult
    public mutating func handle(_ event: MinibarPresentationEvent) -> MinibarPresentationEffect {
        switch event {
        case .present:
            visibility = .visible
            return .show
        case .toggle:
            if visibility == .visible {
                visibility = .hidden
                return .hide
            }
            visibility = .visible
            return .show
        case .dismiss:
            visibility = .hidden
            return .hide
        }
    }
}

// MARK: - Server payload decode subset

public enum CapturePhase: String, Equatable {
    case idle
    case starting
    case capturing
    case stopping
    case switchingModel = "switching-model"

    /// Whether quitting must be confirmed before the launcher may terminate its
    /// owned server. The server owns capture work until authoritative idle.
    public var requiresQuitProtection: Bool {
        self != .idle
    }
}

/// The only server messages the native surface observes.
public enum NativeSurfaceEvent: Equatable {
    case capture(CaptureProjection)
    case status(text: String)
    /// A well-formed server message outside the observed subset.
    case ignored(type: String)
}

public struct CaptureProjection: Equatable {
    public let capturing: Bool
    public let mode: String
    public let phase: CapturePhase
    /// Server-authoritative start time in epoch milliseconds; the timer is
    /// always derived from this, never from a native stopwatch.
    public let startedAt: Double?
}

public enum DecodeFailure: String, Error, Equatable {
    case malformedPayload
    case unknownPhase
}

public enum NativeSurfaceDecoder {
    public static func decode(_ payload: String) throws -> NativeSurfaceEvent {
        guard let data = payload.data(using: .utf8) else { throw DecodeFailure.malformedPayload }
        let parsed = try? JSONSerialization.jsonObject(with: data, options: [])
        guard let object = parsed as? [String: Any] else { throw DecodeFailure.malformedPayload }
        guard let type = object["type"] as? String else { throw DecodeFailure.malformedPayload }

        switch type {
        case "capture":
            guard
                let capturing = object["capturing"] as? Bool,
                let mode = object["mode"] as? String
            else { throw DecodeFailure.malformedPayload }

            let phase: CapturePhase
            if let raw = object["phase"] {
                guard let rawPhase = raw as? String else { throw DecodeFailure.malformedPayload }
                guard let known = CapturePhase(rawValue: rawPhase) else {
                    throw DecodeFailure.unknownPhase
                }
                phase = known
            } else {
                // Compatibility with phase-less capture messages.
                phase = capturing ? .capturing : .idle
            }

            var startedAt: Double?
            if let raw = object["startedAt"], !(raw is NSNull) {
                guard let number = raw as? NSNumber else { throw DecodeFailure.malformedPayload }
                startedAt = number.doubleValue
            }

            return .capture(
                CaptureProjection(
                    capturing: capturing, mode: mode, phase: phase, startedAt: startedAt
                )
            )

        case "status":
            guard let text = object["text"] as? String else { throw DecodeFailure.malformedPayload }
            return .status(text: text)

        default:
            return .ignored(type: type)
        }
    }
}

// MARK: - One-command guards

/// Existing client action names; the native surface never invents new ones.
public enum NativeOutboundAction: String, Equatable {
    case stopCapture
}

/// Suppresses duplicate Stop requests. Rapid activations while a stop is already
/// in flight emit nothing; the guard rearms only on an authoritative server
/// snapshot that leaves the stopping phase.
public struct StopCommandGuard {
    private var phase: CapturePhase
    private var stopInFlight = false

    public init(phase: CapturePhase = .idle) {
        self.phase = phase
    }

    /// Apply an authoritative server capture snapshot.
    public mutating func apply(_ projection: CaptureProjection) {
        phase = projection.phase
        if phase != .stopping { stopInFlight = false }
    }

    /// Handle a Stop activation. Returns the action to send, or nil.
    public mutating func activateStop() -> NativeOutboundAction? {
        guard !stopInFlight else { return nil }
        switch phase {
        case .starting, .capturing:
            stopInFlight = true
            return .stopCapture
        case .idle, .stopping, .switchingModel:
            return nil
        }
    }
}
