// Live native client for the dual-surface integration seam (Todo 16).
//
// Unlike `native-minibar-driver.swift`, which replays an event list, this driver
// opens a REAL `URLSessionWebSocketTask` against the fixture Bun session and
// drives the same pure modules the AppKit shell drives at runtime:
// `TransportClient` for connection/capture truth and `MinibarProjection` for the
// ambient surface. It is headless: no AppKit, no NSApplication, no window, no
// status item. The only thing it adds over the shell is an NDJSON trace on
// stdout so the Bun test can subscribe to an exact native state before the
// trigger that should produce it.
//
// Determinism rules:
//   * `now` is supplied by the test through a `now` command, never sampled here,
//     so the projected timer text is a pure function of the server's `startedAt`.
//   * Nothing sleeps or polls. Reads are socket callbacks; commands are stdin
//     lines; every emission is caused by one of those two.
//   * The driver never invents capture state: on a socket drop it reports
//     `reconnecting` and keeps the last authoritative capture projection, which
//     is exactly the "never claim stopped on transport loss" contract.
//
// Usage:
//   swiftc -O -o driver macos/NativeSurfaceContract.swift macos/AppLifecycle.swift \
//     macos/TransportClient.swift macos/MinibarProjection.swift \
//     tests/fixtures/native-dual-surface-driver.swift
//   ./driver ws://127.0.0.1:PORT/ws   # commands on stdin, NDJSON on stdout

import Foundation

// MARK: - Output

/// All emissions go through one lock so a socket callback and a stdin command
/// can never interleave halfway through a line.
let emitLock = NSLock()

/// Serialises one JSON object per line. `print` is line-buffered when stdout is
/// a pipe only if we flush explicitly, so every emission flushes.
func emit(_ object: [String: Any]) {
    emitLock.lock()
    defer { emitLock.unlock() }
    guard
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8)
    else { return }
    FileHandle.standardOutput.write(Data((text + "\n").utf8))
}

// MARK: - Driver

final class DualSurfaceNativeDriver: NSObject, URLSessionWebSocketDelegate {
    private let endpoint: URL
    private var session: URLSession!
    private var socket: URLSessionWebSocketTask?

    /// Every mutation of the pure modules runs here, so a socket callback and a
    /// stdin command are strictly ordered instead of racing. This is the driver's
    /// stand-in for the shell's main queue.
    private let state = DispatchQueue(label: "dual-surface-native-driver.state")

    /// The same two pure modules the AppKit shell owns. No third store.
    private var transport = TransportClient()
    private var projection = MinibarProjection()

    /// Injected clock. Only a `now` command moves it, so the timer text is a
    /// deterministic function of the server's `startedAt`.
    private var now: Double = 0

    /// Every frame this client actually sent, in order. Lets the test prove that
    /// rapid Stop puts exactly one existing command on the wire.
    private var sentFrames: [String] = []

    /// Monotonic emission counter so the test can order native observations
    /// against its own triggers without any wall-clock reasoning.
    private var seq = 0

    init(endpoint: URL) {
        self.endpoint = endpoint
        super.init()
        // A serial delegate queue plus the state queue below keeps every socket
        // event ordered; nothing here depends on concurrency for progress.
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: delegateQueue)
    }

    // MARK: Connection

    /// Must run on `state`.
    private func receiveNext() {
        guard let current = socket else { return }
        current.receive { [weak self] result in
            guard let self else { return }
            self.state.async {
                // A receive that lands after this socket was replaced belongs to
                // a superseded connection and must not move current state.
                guard current === self.socket else { return }
                switch result {
                case let .success(message):
                    switch message {
                    case let .string(payload):
                        self.ingest(payload)
                    case let .data(data):
                        if let payload = String(data: data, encoding: .utf8) { self.ingest(payload) }
                    @unknown default:
                        break
                    }
                    self.receiveNext()
                case .failure:
                    // A dead socket is never evidence that the meeting stopped.
                    self.socket = nil
                    self.apply(self.transport.handle(.closed))
                    self.report(reason: "socket-failure")
                }
            }
        }
    }

    // MARK: Ingest — identical to MinibarWindowController.ingest

    private func ingest(_ payload: String) {
        let before = transport.projection.decodeFailures
        apply(transport.handle(.received(payload)))
        let failed = transport.projection.decodeFailures > before
        projection.ingest(payload, transportDecodeFailed: failed)
        if !failed, let event = try? NativeSurfaceDecoder.decode(payload), case .capture = event {
            projection.applyCapture(transport.projection.capture)
        }
        report(reason: "message")
    }

    private func apply(_ effects: [TransportEffect]) {
        for effect in effects {
            switch effect {
            case let .send(frame):
                sentFrames.append(frame)
                socket?.send(.string(frame)) { _ in }
            case .scheduleReconnect:
                // The test drives reconnection explicitly with a `connect`
                // command; scheduling a real timer here would make the run
                // depend on elapsed time.
                break
            }
        }
    }

    // MARK: Reporting

    /// Project and publish the current native surface state.
    ///
    /// `render` (not `view`) is used so announcement de-duplication behaves
    /// exactly as it does in the shell.
    private func report(reason: String) {
        let model = projection.render(
            connection: transport.projection.connection,
            capture: transport.projection.capture,
            now: now
        )
        seq += 1
        emit([
            "kind": "state",
            "seq": seq,
            "reason": reason,
            "connection": transport.projection.connection.rawValue,
            "status": model.status.rawValue,
            "capturePhase": model.capturePhase.rawValue,
            "capturing": transport.projection.capture.capturing,
            "mode": transport.projection.capture.mode,
            "startedAt": transport.projection.capture.startedAt as Any? ?? NSNull(),
            "timer": model.timer as Any? ?? NSNull(),
            "glyph": model.glyph,
            "title": model.title,
            "lines": model.lines.map { line -> [String: Any] in
                [
                    "text": line.text,
                    "ts": line.ts,
                    "provisional": line.provisional,
                    "speaker": line.speaker as Any? ?? NSNull(),
                ]
            },
            "stopEnabled": model.controls.first(where: { $0.id == .stop })?.enabled ?? false,
            "errorReason": model.errorReason as Any? ?? NSNull(),
            "decodeFailures": transport.projection.decodeFailures,
            "projectionDecodeFailures": projection.decodeFailures,
            "dropCount": transport.projection.dropCount,
            "sent": sentFrames,
        ])
    }

    // MARK: Commands

    func handle(command line: String) {
        state.async { self.execute(command: line) }
    }

    /// Must run on `state`.
    private func execute(command line: String) {
        guard
            let data = line.data(using: .utf8),
            let raw = try? JSONSerialization.jsonObject(with: data, options: []),
            let object = raw as? [String: Any],
            let op = object["op"] as? String
        else {
            emit(["kind": "error", "detail": "unparseable command"])
            return
        }

        switch op {
        case "now":
            now = (object["value"] as? NSNumber)?.doubleValue ?? now
            report(reason: "now")

        case "connect":
            let task = session.webSocketTask(with: endpoint)
            socket = task
            task.resume()
            receiveNext()

        case "disconnect":
            let closing = socket
            socket = nil
            closing?.cancel(with: .goingAway, reason: nil)
            apply(transport.handle(.closed))
            report(reason: "disconnect")

        case "stop":
            // The Stop control. The one-command guard lives in the pure
            // transport, so repeated activation can only ever emit once.
            apply(transport.handle(.stopActivated))
            report(reason: "stop-activated")

        case "mode":
            if let raw = object["value"] as? String, let mode = SurfaceMode(rawValue: raw) {
                projection.setMode(mode)
            }
            report(reason: "mode")

        case "snapshot":
            report(reason: object["label"] as? String ?? "snapshot")

        case "quit":
            emit(["kind": "bye", "sent": sentFrames])
            exit(0)

        default:
            emit(["kind": "error", "detail": "unknown op \(op)"])
        }
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        state.async {
            guard webSocketTask === self.socket else { return }
            self.apply(self.transport.handle(.opened))
            emit(["kind": "open"])
            self.report(reason: "open")
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        state.async {
            guard webSocketTask === self.socket else { return }
            self.socket = nil
            self.apply(self.transport.handle(.closed))
            emit(["kind": "close"])
            self.report(reason: "closed")
        }
    }
}

// MARK: - Entry point

@main
enum DualSurfaceDriverMain {
    static func main() {
        let arguments = CommandLine.arguments
        guard arguments.count >= 2, let endpoint = URL(string: arguments[1]) else {
            FileHandle.standardError.write(Data("usage: driver ws://host:port/ws\n".utf8))
            exit(2)
        }

        let driver = DualSurfaceNativeDriver(endpoint: endpoint)
        emit(["kind": "ready", "endpoint": arguments[1]])

        // Commands arrive as one JSON object per stdin line. `readLine` blocks
        // this thread; socket callbacks run on the URLSession delegate queue, so
        // the driver never spins and never polls.
        while let line = readLine(strippingNewline: true) {
            if line.isEmpty { continue }
            driver.handle(command: line)
        }

        // stdin closed without an explicit quit: exit cleanly rather than linger.
        exit(0)
    }
}
