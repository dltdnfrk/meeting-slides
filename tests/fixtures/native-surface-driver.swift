// Deterministic fixture driver for the pure native surface contract.
//
// Reads a scenario batch as JSON on stdin, runs each scenario against
// macos/NativeSurfaceContract.swift, and writes one JSON document to stdout.
// Every failure is reported as a typed result, so a bad payload or an
// impossible display never crashes the process and never mixes into stderr.
//
// Usage:
//   swiftc -O -o driver macos/NativeSurfaceContract.swift tests/fixtures/native-surface-driver.swift
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
        if let errorKind {
            out["error"] = ["kind": errorKind, "detail": errorDetail ?? ""]
        }
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
            id: id,
            frame: try parseRect(object),
            isActive: (object["isActive"] as? Bool) ?? false
        )
    }
}

func parsePhase(_ raw: String) throws -> CapturePhase {
    guard let phase = CapturePhase(rawValue: raw) else {
        throw DriverError.badInput("unknown phase \(raw)")
    }
    return phase
}

// MARK: - Scenario execution

func runSurfaceSize(_ input: [String: Any]) throws -> Any {
    let size = NativeSurfaceGeometry.size(for: try parseMode(try requireString(input, "mode")))
    return ["width": size.width, "height": size.height]
}

func runResolveFrame(_ input: [String: Any]) throws -> Any {
    let mode = try parseMode(try requireString(input, "mode"))
    var saved: SurfaceRect?
    if let rawSaved = input["saved"], !(rawSaved is NSNull) {
        saved = try parseRect(try requireObject(rawSaved, "saved"))
    }
    let displays = try parseDisplays(input["displays"])
    let resolved = try NativeSurfaceGeometry.resolveFrame(
        mode: mode, savedFrame: saved, displays: displays
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

func runDecode(_ input: [String: Any]) throws -> Any {
    let event = try NativeSurfaceDecoder.decode(try requireString(input, "payload"))
    switch event {
    case let .capture(projection):
        return [
            "event": "capture",
            "capturing": projection.capturing,
            "mode": projection.mode,
            "phase": projection.phase.rawValue,
            "startedAt": projection.startedAt.map { $0 as Any } ?? NSNull(),
        ]
    case let .status(text):
        return ["event": "status", "text": text]
    case let .ignored(type):
        return ["event": "ignored", "type": type]
    }
}

func runPresentation(_ input: [String: Any]) throws -> Any {
    let mode = try parseMode(try requireString(input, "mode"))
    guard let rawEvents = input["events"] as? [String] else {
        throw DriverError.badInput("expected string events array")
    }

    var state = MinibarPresentationState()
    var effects: [String] = []
    var states: [String] = []
    for raw in rawEvents {
        let event: MinibarPresentationEvent
        switch raw {
        case "present": event = .present
        case "toggle": event = .toggle
        default: throw DriverError.badInput("unknown presentation event \(raw)")
        }
        effects.append(state.handle(event).rawValue)
        states.append(state.visibility.rawValue)
    }
    return [
        "effects": effects,
        "states": states,
        "mode": mode.rawValue,
    ]
}

func runStopGuard(_ input: [String: Any]) throws -> Any {
    let phase = try parsePhase(try requireString(input, "phase"))
    guard let activations = (input["activations"] as? NSNumber)?.intValue else {
        throw DriverError.badInput("expected number activations")
    }

    var guardState = StopCommandGuard()
    guardState.apply(
        CaptureProjection(
            capturing: phase == .capturing || phase == .starting,
            mode: "live",
            phase: phase,
            startedAt: nil
        )
    )

    var actions: [String] = []
    for _ in 0..<activations {
        if let action = guardState.activateStop() { actions.append(action.rawValue) }
    }

    // Optional second round after an authoritative idle snapshot rearms the guard.
    if let follow = (input["thenIdleThenActivations"] as? NSNumber)?.intValue {
        guardState.apply(
            CaptureProjection(capturing: false, mode: "live", phase: .idle, startedAt: nil)
        )
        for _ in 0..<follow {
            if let action = guardState.activateStop() { actions.append(action.rawValue) }
        }
    }

    return ["emitted": actions.count, "actions": actions]
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
        return ScenarioResult.failure("<malformed-scenario>", kind: "badScenario", detail: "\(error)")
    }

    do {
        switch kind {
        case "surfaceSize": return .success(name, try runSurfaceSize(input))
        case "resolveFrame": return .success(name, try runResolveFrame(input))
        case "decode": return .success(name, try runDecode(input))
        case "stopGuard": return .success(name, try runStopGuard(input))
        case "presentation": return .success(name, try runPresentation(input))
        default:
            return .failure(name, kind: "unknownScenarioKind", detail: kind)
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
        let data = try? JSONSerialization.data(
            withJSONObject: document, options: [.sortedKeys]
        ),
        let text = String(data: data, encoding: .utf8)
    else {
        FileHandle.standardError.write(Data("driver could not serialize output\n".utf8))
        exit(2)
    }
    FileHandle.standardOutput.write(Data((text + "\n").utf8))
}

@main
enum NativeSurfaceDriver {
    static func main() {
        let stdinData = FileHandle.standardInput.readDataToEndOfFile()

        guard
            let parsed = try? JSONSerialization.jsonObject(with: stdinData, options: []),
            let batch = parsed as? [String: Any],
            let scenarios = batch["scenarios"] as? [Any]
        else {
            emit([
                "driver": "native-surface-driver",
                "results": [
                    ScenarioResult.failure(
                        "<batch>", kind: "malformedBatch", detail: "stdin is not {scenarios:[...]}"
                    ).json
                ],
            ])
            exit(1)
        }

        emit([
            "driver": "native-surface-driver",
            "results": scenarios.map { runScenario($0).json },
        ])
        exit(0)
    }
}
