// Pure WebSocket transport boundary for the Meeting Slides native surface.
//
// The launcher (and later the minibar) owns the real `URLSessionWebSocketTask`.
// This module owns everything that can be decided without a socket: the endpoint
// URL, the connection state machine, decoding of the observed server subset,
// reconnect bookkeeping and outbound command emission.
//
// Rules this boundary enforces:
//   * Native state is a *projection* of the existing Bun session. There is no
//     second engine, no second meeting store, no invented protocol spelling.
//   * Losing the socket never means "capture stopped": the last authoritative
//     capture projection is retained while the connection is `reconnecting`.
//   * A malformed or unknown payload is a typed decode failure that leaves the
//     last known projection intact.
//   * Stop is emitted at most once per authoritative capturing snapshot and only
//     while the socket is open.
//
// Foundation only: no AppKit, no URLSession, no Thread.sleep, no clock.

import Foundation

// MARK: - Endpoint

public enum TransportEndpoint {
    /// The existing local WebSocket route served by `server.ts`.
    public static func webSocketURL(port: Int) -> String {
        "ws://127.0.0.1:\(port)/ws"
    }
}

// MARK: - Connection state

public enum ConnectionState: String, Equatable {
    case connecting
    case online
    case reconnecting
}

/// Reconnect delay schedule. Pure arithmetic so tests never wait: the caller
/// turns the returned interval into a real timer.
public enum ReconnectBackoff {
    public static let initialSeconds: Double = 0.5
    public static let maximumSeconds: Double = 8

    /// Delay before the Nth consecutive reconnect attempt (1-based).
    public static func delaySeconds(consecutiveFailures: Int) -> Double {
        guard consecutiveFailures > 0 else { return 0 }
        let exponent = Double(consecutiveFailures - 1)
        let raw = initialSeconds * pow(2, exponent)
        return Swift.min(raw, maximumSeconds)
    }
}

// MARK: - Outbound commands

/// Outbound frames use the existing client action spellings only.
public enum NativeCommandEncoder {
    public static func encode(_ action: NativeOutboundAction) -> String {
        "{\"action\":\"\(action.rawValue)\"}"
    }

    /// Every action this surface may ever send. Used as a contract assertion.
    public static var supportedActions: [String] {
        [NativeOutboundAction.stopCapture.rawValue]
    }
}

// MARK: - Projection

/// Everything the native surface knows, derived from server messages plus
/// transient transport status. Deliberately not a meeting store.
public struct TransportProjection: Equatable {
    public var connection: ConnectionState = .connecting
    public var capture: CaptureProjection = CaptureProjection(
        capturing: false, mode: "", phase: .idle, startedAt: nil
    )
    public var statusText: String?
    /// Total socket drops since launch. Never reset: the caller reports how many
    /// times the single Bun session was lost, not how it feels right now.
    public var dropCount = 0
    /// Drops since the last successful open. Drives the reconnect schedule only.
    public var consecutiveFailures = 0
    public var decodeFailures = 0
    public var lastDecodeError: DecodeFailure?
}

/// Transport-level inputs. The caller feeds real socket callbacks in; the client
/// stays a pure state machine.
public enum TransportEvent: Equatable {
    case opened
    case received(String)
    case closed
    case stopActivated
}

/// Side effects the caller must perform after an event.
public enum TransportEffect: Equatable {
    case send(String)
    case scheduleReconnect(afterSeconds: Double)
}

public struct TransportClient {
    public private(set) var projection = TransportProjection()
    private var stopGuard = StopCommandGuard()

    public init() {}

    public var reconnectDelaySeconds: Double {
        ReconnectBackoff.delaySeconds(consecutiveFailures: projection.consecutiveFailures)
    }

    @discardableResult
    public mutating func handle(_ event: TransportEvent) -> [TransportEffect] {
        switch event {
        case .opened:
            projection.connection = .online
            projection.consecutiveFailures = 0
            return []

        case let .received(payload):
            apply(payload)
            return []

        case .closed:
            projection.connection = .reconnecting
            projection.dropCount += 1
            projection.consecutiveFailures += 1
            // The last authoritative capture projection is deliberately kept:
            // a dead socket is not evidence that the meeting stopped.
            return [.scheduleReconnect(afterSeconds: reconnectDelaySeconds)]

        case .stopActivated:
            guard projection.connection == .online else { return [] }
            guard let action = stopGuard.activateStop() else { return [] }
            return [.send(NativeCommandEncoder.encode(action))]
        }
    }

    private mutating func apply(_ payload: String) {
        do {
            let event = try NativeSurfaceDecoder.decode(payload)
            switch event {
            case let .capture(projectionUpdate):
                projection.capture = projectionUpdate
                stopGuard.apply(projectionUpdate)
            case let .status(text):
                projection.statusText = text
            case .ignored:
                break
            }
        } catch let failure as DecodeFailure {
            projection.decodeFailures += 1
            projection.lastDecodeError = failure
        } catch {
            projection.decodeFailures += 1
            projection.lastDecodeError = .malformedPayload
        }
    }
}
