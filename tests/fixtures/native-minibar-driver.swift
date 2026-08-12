// Deterministic fixture driver for the pure minibar projection.
//
// Reads a scenario batch as JSON on stdin, drives macos/MinibarProjection.swift
// together with the shared transport/contract modules, and writes one JSON
// document to stdout. No AppKit, no window, no socket, no clock: `now` arrives
// as a value and socket callbacks arrive as an ordered event list.
//
// Usage:
//   swiftc -O -o driver macos/NativeSurfaceContract.swift macos/AppLifecycle.swift \
//     macos/TransportClient.swift macos/MinibarProjection.swift \
//     tests/fixtures/native-minibar-driver.swift
//   echo '{"scenarios":[...]}' | ./driver

import Foundation

// MARK: - Result plumbing

enum DriverError: Error {
    case badInput(String)
}

struct ScenarioResult {
    let name: String
    let ok: Bool
    let value: Any?
    let errorKind: String?
    let errorDetail: String?

    static func success(_ name: String, _ value: Any) -> ScenarioResult {
        ScenarioResult(name: name, ok: true, value: value, errorKind: nil, errorDetail: nil)
    }

    static func failure(_ name: String, kind: String, detail: String) -> ScenarioResult {
        ScenarioResult(name: name, ok: false, value: nil, errorKind: kind, errorDetail: detail)
    }

    var json: [String: Any] {
        var out: [String: Any] = ["name": name, "ok": ok]
        if let value { out["value"] = value }
        if let errorKind { out["error"] = ["kind": errorKind, "detail": errorDetail ?? ""] }
        return out
    }
}

// MARK: - Input parsing

func requireObject(_ raw: Any?, _ label: String) throws -> [String: Any] {
    guard let object = raw as? [String: Any] else {
        throw DriverError.badInput("expected object for \(label)")
    }
    return object
}

func requireString(_ object: [String: Any], _ key: String) throws -> String {
    guard let value = object[key] as? String else {
        throw DriverError.badInput("expected string \(key)")
    }
    return value
}

func requireDouble(_ object: [String: Any], _ key: String) throws -> Double {
    guard let value = object[key] as? NSNumber else {
        throw DriverError.badInput("expected number \(key)")
    }
    return value.doubleValue
}

func parseMode(_ raw: String) throws -> SurfaceMode {
    guard let mode = SurfaceMode(rawValue: raw) else {
        throw DriverError.badInput("unknown mode \(raw)")
    }
    return mode
}

func parsePhase(_ raw: String) throws -> CapturePhase {
    guard let phase = CapturePhase(rawValue: raw) else {
        throw DriverError.badInput("unknown phase \(raw)")
    }
    return phase
}

func parseRect(_ object: [String: Any]) throws -> SurfaceRect {
    SurfaceRect(
        x: try requireDouble(object, "x"),
        y: try requireDouble(object, "y"),
        width: try requireDouble(object, "width"),
        height: try requireDouble(object, "height")
    )
}

func parseDisplays(_ raw: Any?) throws -> [DisplayInfo] {
    guard let list = raw as? [Any] else { throw DriverError.badInput("expected displays array") }
    return try list.map { entry in
        let object = try requireObject(entry, "display")
        guard let id = (object["id"] as? NSNumber)?.intValue else {
            throw DriverError.badInput("expected number id")
        }
        return DisplayInfo(
            id: id, frame: try parseRect(object), isActive: (object["isActive"] as? Bool) ?? false
        )
    }
}

// MARK: - Session replay

/// One replayed native session: the shared transport client plus the minibar
/// projection, driven by an ordered event list. This mirrors exactly what the
/// AppKit shell does at runtime, minus the socket and the window.
struct ReplaySession {
    var transport = TransportClient()
    var projection: MinibarProjection
    var sent: [String] = []

    init(mode: SurfaceMode) {
        projection = MinibarProjection(mode: mode)
    }

    mutating func run(_ events: [Any]) throws {
        for raw in events {
            let event = try requireObject(raw, "event")
            switch try requireString(event, "kind") {
            case "open":
                apply(transport.handle(.opened))

            case "close":
                apply(transport.handle(.closed))

            case "message":
                let payload = try requireString(event, "payload")
                let before = transport.projection.decodeFailures
                apply(transport.handle(.received(payload)))
                let transportFailed = transport.projection.decodeFailures > before
                projection.ingest(payload, transportDecodeFailed: transportFailed)
                if !transportFailed, isCaptureMessage(payload) {
                    projection.applyCapture(transport.projection.capture)
                }

            case "stop":
                apply(transport.handle(.stopActivated))

            case "toggle":
                projection.handleMode(.toggleDisclosure)

            case "escape":
                projection.handleMode(.escape)

            case let other:
                throw DriverError.badInput("unknown event kind \(other)")
            }
        }
    }

    private mutating func apply(_ effects: [TransportEffect]) {
        for effect in effects {
            if case let .send(frame) = effect { sent.append(frame) }
        }
    }

    /// A capture snapshot is the only authoritative source of capture phase.
    private func isCaptureMessage(_ payload: String) -> Bool {
        guard let event = try? NativeSurfaceDecoder.decode(payload) else { return false }
        if case .capture = event { return true }
        return false
    }

    func view(now: Double) -> MinibarViewModel {
        projection.view(
            connection: transport.projection.connection,
            capture: transport.projection.capture,
            now: now
        )
    }

    /// What the AppKit shell does: project AND commit the announcement, so a
    /// later render of an unchanged status reports `announces == false`.
    mutating func render(now: Double) -> MinibarViewModel {
        projection.render(
            connection: transport.projection.connection,
            capture: transport.projection.capture,
            now: now
        )
    }
}

func lineJSON(_ line: MinibarLine) -> [String: Any] {
    [
        "text": line.text,
        "speaker": line.speaker.map { $0 as Any } ?? NSNull(),
        "provisional": line.provisional,
    ]
}

func replay(_ input: [String: Any]) throws -> ReplaySession {
    let mode = try parseMode((input["mode"] as? String) ?? "collapsed")
    var session = ReplaySession(mode: mode)
    try session.run((input["events"] as? [Any]) ?? [])
    return session
}

// MARK: - Scenario execution

func runSurfaceSize(_ input: [String: Any]) throws -> Any {
    let size = NativeSurfaceGeometry.size(for: try parseMode(try requireString(input, "mode")))
    return ["width": size.width, "height": size.height]
}

func rectJSON(_ rect: SurfaceRect) -> [String: Double] {
    ["x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height]
}

func runExpandedLayout(_: [String: Any]) throws -> Any {
    let layout = MinibarLayout.expanded
    return [
        "surface": rectJSON(layout.surface),
        "content": rectJSON(layout.content),
        "status": rectJSON(layout.status),
        "transcript": rectJSON(layout.transcript),
        "actions": rectJSON(layout.actions),
        "columnGap": layout.columnGap,
        "rowGap": layout.rowGap,
    ]
}

func runRenderContract(_ input: [String: Any]) throws -> Any {
    let session = try replay(input)
    let model = session.view(now: try requireDouble(input, "now"))
    let stop = model.controls.first { $0.id == .stop }
    return [
        "status": model.status.rawValue,
        "title": model.title,
        "timer": model.timer.map { $0 as Any } ?? NSNull(),
        "line": model.lines.first.map(lineJSON) ?? NSNull(),
        "stopEnabled": stop?.enabled ?? false,
        "stopLabel": stop?.label ?? "",
        "stopHelp": stop?.help ?? "",
        "accessibilityStatus": model.accessibility.statusAnnouncement,
    ]
}

func runResolveFrame(_ input: [String: Any]) throws -> Any {
    let mode = try parseMode(try requireString(input, "mode"))
    var saved: SurfaceRect?
    if let rawSaved = input["saved"], !(rawSaved is NSNull) {
        saved = try parseRect(try requireObject(rawSaved, "saved"))
    }
    let resolved = try NativeSurfaceGeometry.resolveFrame(
        mode: mode, savedFrame: saved, displays: try parseDisplays(input["displays"])
    )
    return [
        "x": resolved.rect.x,
        "y": resolved.rect.y,
        "width": resolved.rect.width,
        "height": resolved.rect.height,
        "displayId": resolved.displayId,
        "usedSavedFrame": resolved.usedSavedFrame,
    ]
}

func runView(_ input: [String: Any]) throws -> Any {
    let session = try replay(input)
    let view = session.view(now: try requireDouble(input, "now"))
    return [
        "mode": view.mode.rawValue,
        "status": view.status.rawValue,
        "glyph": view.glyph,
        "title": view.title,
        "timer": view.timer.map { $0 as Any } ?? NSNull(),
        "capturePhase": view.capturePhase.rawValue,
        "lines": view.lines.map(lineJSON),
        "errorReason": view.errorReason.map { $0 as Any } ?? NSNull(),
        // Rejections observed by this surface, transport-level ones included.
        "decodeFailures": session.projection.decodeFailures,
        "transportDecodeFailures": session.transport.projection.decodeFailures,
    ]
}

func runControls(_ input: [String: Any]) throws -> Any {
    let session = try replay(input)
    let view = session.view(now: 0)
    return [
        "controls": view.controls.map { control in
            [
                "id": control.id.rawValue,
                "enabled": control.enabled,
                "label": control.label,
                "role": "button",
            ]
        }
    ]
}

func runQuitProtection(_ input: [String: Any]) throws -> Any {
    let phase = try parsePhase(try requireString(input, "phase"))
    return ["phase": phase.rawValue, "protected": phase.requiresQuitProtection]
}

func runControlVocabulary(_: [String: Any]) throws -> Any {
    [
        "controls": MinibarControl.vocabulary,
        "outboundActions": NativeCommandEncoder.supportedActions,
    ]
}

func runCommands(_ input: [String: Any]) throws -> Any {
    let session = try replay(input)
    return ["sent": Array(Set(session.sent)).sorted(), "count": session.sent.count]
}

func runActivation(_ input: [String: Any]) throws -> Any {
    guard let origin = CaptureOrigin(rawValue: try requireString(input, "origin")) else {
        throw DriverError.badInput("unknown origin")
    }
    _ = try parsePhase(try requireString(input, "phase"))
    let plan = MinibarActivation.plan(
        origin: origin, userInteracted: (input["thenUserInteraction"] as? Bool) ?? false
    )
    return [
        "showsSurface": plan.showsSurface,
        "activatesApp": plan.activatesApp,
        "focusesStop": plan.focusesStop,
    ]
}

func runMode(_ input: [String: Any]) throws -> Any {
    var projection = MinibarProjection(mode: try parseMode(try requireString(input, "mode")))
    switch try requireString(input, "event") {
    case "escape": projection.handleMode(.escape)
    case "toggle": projection.handleMode(.toggleDisclosure)
    case let other: throw DriverError.badInput("unknown mode event \(other)")
    }
    // Escape and the disclosure never produce an outbound command.
    return ["mode": projection.mode.rawValue, "emitted": [String]()]
}

func runWindowPolicy(_: [String: Any]) throws -> Any {
    let policy = MinibarWindowPolicy()
    return [
        "borderless": policy.borderless,
        "floating": policy.floating,
        "nonActivating": policy.nonActivating,
        "hidesOnDeactivate": policy.hidesOnDeactivate,
        "resizableWhenExpanded": policy.resizable(in: .expanded),
        "resizableWhenCollapsed": policy.resizable(in: .collapsed),
        "dragThreshold": policy.dragThreshold,
        "joinsAllSpaces": policy.joinsAllSpaces,
        "dockIdentityChanged": policy.dockIdentityChanged,
    ]
}

func runAccessibility(_ input: [String: Any]) throws -> Any {
    let session = try replay(input)
    let ax = session.view(now: try requireDouble(input, "now")).accessibility
    return [
        "role": ax.role,
        "label": ax.label,
        "statusAnnouncement": ax.statusAnnouncement,
        "timerIsLiveRegion": ax.timerIsLiveRegion,
        "transcriptIsLiveRegion": ax.transcriptIsLiveRegion,
        "minimumTargetSize": [
            "width": ax.minimumTargetSize.width,
            "height": ax.minimumTargetSize.height,
        ],
        "focusOrder": ax.focusOrder,
        "announces": ax.announces,
    ]
}

/// Replays an ordered list of STEPS, rendering after each one, and reports what
/// the surface would announce at that point.
///
/// `render` (not `view`) is used deliberately: it commits the announcement, so
/// the sequence proves the real runtime behaviour - an unchanged status on a
/// later clock reports `announces == false` - rather than a hypothetical.
func runAnnouncements(_ input: [String: Any]) throws -> Any {
    let mode = try parseMode((input["mode"] as? String) ?? "collapsed")
    var session = ReplaySession(mode: mode)
    var out: [[String: Any]] = []
    for rawStep in (input["steps"] as? [Any]) ?? [] {
        let step = try requireObject(rawStep, "step")
        try session.run((step["events"] as? [Any]) ?? [])
        let model = session.render(now: try requireDouble(step, "now"))
        out.append([
            "status": model.status.rawValue,
            "announcement": model.accessibility.statusAnnouncement,
            "announces": model.accessibility.announces,
            "errorReason": model.errorReason.map { $0 as Any } ?? NSNull(),
        ])
    }
    return out
}

/// Every control the surface paints, with the accessibility payload the AppKit
/// shell publishes for it.
func runControlAccessibility(_ input: [String: Any]) throws -> Any {
    let session = try replay(input)
    let model = session.view(now: try requireDouble(input, "now"))
    let minimum = model.accessibility.minimumTargetSize
    return model.controls.map { control in
        [
            "id": control.id.rawValue,
            "label": control.label,
            "help": control.help,
            "enabled": control.enabled,
            "minimumTargetSize": ["width": minimum.width, "height": minimum.height],
        ] as [String: Any]
    }
}

func runMotion(_ input: [String: Any]) throws -> Any {
    guard let reduce = input["reduceMotion"] as? Bool else {
        throw DriverError.badInput("expected bool reduceMotion")
    }
    let plan = MinibarMotion.plan(reduceMotion: reduce)
    return ["durationSeconds": plan.durationSeconds, "animates": plan.animates]
}

func runScenario(_ raw: Any) -> ScenarioResult {
    let name: String
    let kind: String
    let input: [String: Any]
    do {
        let object = try requireObject(raw, "scenario")
        name = try requireString(object, "name")
        kind = try requireString(object, "kind")
        input = try requireObject(object["input"], "input")
    } catch {
        return ScenarioResult.failure(
            "<malformed-scenario>", kind: "badScenario", detail: "\(error)"
        )
    }

    do {
        switch kind {
        case "surfaceSize": return .success(name, try runSurfaceSize(input))
        case "expandedLayout": return .success(name, try runExpandedLayout(input))
        case "renderContract": return .success(name, try runRenderContract(input))
        case "resolveFrame": return .success(name, try runResolveFrame(input))
        case "view": return .success(name, try runView(input))
        case "controls": return .success(name, try runControls(input))
        case "quitProtection": return .success(name, try runQuitProtection(input))
        case "controlVocabulary": return .success(name, try runControlVocabulary(input))
        case "commands": return .success(name, try runCommands(input))
        case "activation": return .success(name, try runActivation(input))
        case "mode": return .success(name, try runMode(input))
        case "windowPolicy": return .success(name, try runWindowPolicy(input))
        case "accessibility": return .success(name, try runAccessibility(input))
        case "announcements": return .success(name, try runAnnouncements(input))
        case "controlAccessibility": return .success(name, try runControlAccessibility(input))
        case "motion": return .success(name, try runMotion(input))
        default: return .failure(name, kind: "unknownScenarioKind", detail: kind)
        }
    } catch let error as GeometryFailure {
        return .failure(name, kind: error.rawValue, detail: "geometry")
    } catch let error as DecodeFailure {
        return .failure(name, kind: error.rawValue, detail: "decode")
    } catch let DriverError.badInput(detail) {
        return .failure(name, kind: "badInput", detail: detail)
    } catch {
        return .failure(name, kind: "unexpected", detail: "\(error)")
    }
}

// MARK: - Entry point

func emit(_ document: [String: Any]) {
    guard
        let data = try? JSONSerialization.data(withJSONObject: document, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8)
    else {
        FileHandle.standardError.write(Data("driver could not serialize output\n".utf8))
        exit(2)
    }
    FileHandle.standardOutput.write(Data((text + "\n").utf8))
}

@main
enum NativeMinibarDriver {
    static func main() {
        let stdinData = FileHandle.standardInput.readDataToEndOfFile()

        guard
            let parsed = try? JSONSerialization.jsonObject(with: stdinData, options: []),
            let batch = parsed as? [String: Any],
            let scenarios = batch["scenarios"] as? [Any]
        else {
            emit([
                "driver": "native-minibar-driver",
                "results": [
                    ScenarioResult.failure(
                        "<batch>", kind: "malformedBatch", detail: "stdin is not {scenarios:[...]}"
                    ).json
                ],
            ])
            exit(1)
        }

        emit([
            "driver": "native-minibar-driver",
            "results": scenarios.map { runScenario($0).json },
        ])
        exit(0)
    }
}
