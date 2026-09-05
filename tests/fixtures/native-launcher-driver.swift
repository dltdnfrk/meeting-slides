// Deterministic fixture driver for the native launcher lifecycle / transport seam.
//
// Reads a scenario batch as JSON on stdin, runs each scenario against
// macos/AppLifecycle.swift and macos/TransportClient.swift (which reuse the
// decode subset from macos/NativeSurfaceContract.swift), and writes one JSON
// document to stdout. Every failure is reported as a typed result, so a bad
// payload, a missing bun binary or an occupied port never crashes the process
// and never leaks into stderr.
//
// Headless by construction: no AppKit, no process spawn, no socket, no clock,
// no sleeps. Async behavior is modeled as ordered event lists.
//
// Usage:
//   swiftc -O -o driver macos/NativeSurfaceContract.swift macos/AppLifecycle.swift \
//       macos/TransportClient.swift tests/fixtures/native-launcher-driver.swift
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

func requireInt(_ object: [String: Any], _ key: String) throws -> Int {
    guard let value = (object[key] as? NSNumber)?.intValue else {
        throw DriverError.badInput("expected number \(key)")
    }
    return value
}

func parseProbe(_ raw: Any?) throws -> HealthProbe {
    let object = try requireObject(raw, "probe")
    guard let reachable = object["reachable"] as? Bool else {
        throw DriverError.badInput("expected bool reachable")
    }
    return HealthProbe(
        reachable: reachable,
        statusCode: (object["status"] as? NSNumber)?.intValue,
        body: object["body"] as? String
    )
}

func parseProbeList(_ raw: Any?) throws -> [HealthProbe] {
    guard let list = raw as? [Any] else { throw DriverError.badInput("expected attempts array") }
    return try list.map { try parseProbe($0) }
}

// MARK: - Lifecycle scenarios

func runPort(_ input: [String: Any]) throws -> Any {
    let contents: String?
    if let raw = input["env"], !(raw is NSNull) {
        guard let text = raw as? String else { throw DriverError.badInput("expected string env") }
        contents = text
    } else {
        contents = nil
    }
    return ["port": LauncherEnvironment.httpPort(envFileContents: contents)]
}

func runBunCandidates(_ input: [String: Any]) throws -> Any {
    ["paths": LauncherEnvironment.bunCandidatePaths(homeDirectory: try requireString(input, "home"))]
}

func runAutomationRequest(_ input: [String: Any]) throws -> Any {
    let request = try CalendarAutomation.captureRequest(
        port: try requireInt(input, "port"),
        tokenJSON: Data(try requireString(input, "tokenJSON").utf8)
    )
    guard let request else { return ["enabled": false] }
    return [
        "enabled": true,
        "url": request.url!.absoluteString,
        "method": request.httpMethod ?? "",
        "authorization": request.value(forHTTPHeaderField: "Authorization") ?? "",
        "contentType": request.value(forHTTPHeaderField: "Content-Type") ?? "",
        "origin": request.value(forHTTPHeaderField: "Origin") as Any? ?? NSNull(),
        "body": try JSONSerialization.jsonObject(with: request.httpBody ?? Data()),
    ]
}

func runLogPath(_ input: [String: Any]) throws -> Any {
    ["path": LauncherEnvironment.logFilePath(homeDirectory: try requireString(input, "home"))]
}

func runLaunchPlan(_ input: [String: Any]) throws -> Any {
    var bunPath: String?
    if let raw = input["bunPath"], !(raw is NSNull) {
        guard let text = raw as? String else {
            throw DriverError.badInput("expected string bunPath")
        }
        bunPath = text
    }
    let plan = try LauncherEnvironment.serverLaunchPlan(
        bunPath: bunPath,
        projectDir: try requireString(input, "projectDir"),
        port: try requireInt(input, "port")
    )
    return [
        "executable": plan.executablePath,
        "arguments": plan.arguments,
        "workingDirectory": plan.workingDirectory,
        "environment": plan.environmentOverlay,
        "browserURL": plan.browserURL,
    ]
}

func runStartup(_ input: [String: Any]) throws -> Any {
    let decision = try StartupPlanner.decide(probe: try parseProbe(input["probe"]))
    return ["decision": decision.rawValue, "ownsServer": decision.ownsServer]
}

func runHealth(_ input: [String: Any]) throws -> Any {
    let verdict = ServerHealth.evaluate(try parseProbe(input["probe"]))
    return ["healthy": verdict.healthy, "reason": verdict.reason.rawValue]
}

func runReadiness(_ input: [String: Any]) throws -> Any {
    let outcome = ReadinessEvaluator.evaluate(probes: try parseProbeList(input["attempts"]))
    return ["ready": outcome.ready, "attempts": outcome.attempts]
}

func parseLifecycleEvent(_ raw: String) throws -> LifecycleEvent {
    if raw.hasPrefix("serverExited:") {
        let rawCode = String(raw.dropFirst("serverExited:".count))
        guard let code = Int32(rawCode) else {
            throw DriverError.badInput("unparsable exit code \(rawCode)")
        }
        return .serverExited(code: code)
    }
    switch raw {
    case "quit": return .quit
    case "interrupt": return .interrupt
    case "readinessFailed": return .readinessFailed
    default: throw DriverError.badInput("unknown lifecycle event \(raw)")
    }
}

func runLifecycle(_ input: [String: Any]) throws -> Any {
    let adopted = (input["adopted"] as? Bool) ?? false
    guard let rawEvents = input["events"] as? [Any] else {
        throw DriverError.badInput("expected events array")
    }

    var lifecycle = ServerLifecycle(ownsServer: !adopted)
    for raw in rawEvents {
        guard let text = raw as? String else {
            throw DriverError.badInput("expected string lifecycle event")
        }
        lifecycle.handle(try parseLifecycleEvent(text))
    }

    return [
        "terminations": lifecycle.terminationRequests,
        "exitCode": Int(lifecycle.exitCode),
        "state": lifecycle.state.rawValue,
    ]
}

// MARK: - Transport scenarios

func parseTransportEvents(_ raw: Any?) throws -> [TransportEvent] {
    guard let list = raw as? [Any] else { throw DriverError.badInput("expected events array") }
    return try list.map { entry in
        let object = try requireObject(entry, "event")
        switch try requireString(object, "kind") {
        case "open": return .opened
        case "close": return .closed
        case "stop": return .stopActivated
        case "message": return .received(try requireString(object, "payload"))
        case let other: throw DriverError.badInput("unknown transport event \(other)")
        }
    }
}

func runTransportURL(_ input: [String: Any]) throws -> Any {
    ["url": TransportEndpoint.webSocketURL(port: try requireInt(input, "port"))]
}

func runTransport(_ input: [String: Any]) throws -> Any {
    var client = TransportClient()
    for event in try parseTransportEvents(input["events"]) {
        client.handle(event)
    }

    let projection = client.projection
    var out: [String: Any] = [
        "connection": projection.connection.rawValue,
        "phase": projection.capture.phase.rawValue,
        "startedAt": projection.capture.startedAt.map { $0 as Any } ?? NSNull(),
        "failures": projection.dropCount,
        "decodeFailures": projection.decodeFailures,
    ]
    if let error = projection.lastDecodeError { out["lastDecodeError"] = error.rawValue }
    if let status = projection.statusText { out["status"] = status }
    return out
}

func runCommands(_ input: [String: Any]) throws -> Any {
    var client = TransportClient()
    var sent: [String] = []
    for event in try parseTransportEvents(input["events"]) {
        for effect in client.handle(event) {
            if case let .send(frame) = effect { sent.append(frame) }
        }
    }
    return ["sent": sent]
}

func runCommandEncoding(_ input: [String: Any]) throws -> Any {
    ["actions": NativeCommandEncoder.supportedActions]
}

func runBackoff(_ input: [String: Any]) throws -> Any {
    let failures = try requireInt(input, "failures")
    let delays = (1...Swift.max(failures, 1)).map {
        ReconnectBackoff.delaySeconds(consecutiveFailures: $0)
    }
    return ["delays": delays, "max": ReconnectBackoff.maximumSeconds]
}

// MARK: - Dispatch

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
        case "port": return .success(name, try runPort(input))
        case "automationRequest": return .success(name, try runAutomationRequest(input))
        case "automationTokenArguments": return .success(name, CalendarAutomation.tokenLoadArguments)
        case "bunCandidates": return .success(name, try runBunCandidates(input))
        case "logPath": return .success(name, try runLogPath(input))
        case "launchPlan": return .success(name, try runLaunchPlan(input))
        case "startup": return .success(name, try runStartup(input))
        case "health": return .success(name, try runHealth(input))
        case "readiness": return .success(name, try runReadiness(input))
        case "lifecycle": return .success(name, try runLifecycle(input))
        case "transportURL": return .success(name, try runTransportURL(input))
        case "transport": return .success(name, try runTransport(input))
        case "commands": return .success(name, try runCommands(input))
        case "commandEncoding": return .success(name, try runCommandEncoding(input))
        case "backoff": return .success(name, try runBackoff(input))
        default:
            return .failure(name, kind: "unknownScenarioKind", detail: kind)
        }
    } catch let error as LauncherFailure {
        return .failure(name, kind: error.rawValue, detail: "lifecycle")
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
enum NativeLauncherDriver {
    static func main() {
        let stdinData = FileHandle.standardInput.readDataToEndOfFile()

        guard
            let parsed = try? JSONSerialization.jsonObject(with: stdinData, options: []),
            let batch = parsed as? [String: Any],
            let scenarios = batch["scenarios"] as? [Any]
        else {
            emit([
                "driver": "native-launcher-driver",
                "results": [
                    ScenarioResult.failure(
                        "<batch>", kind: "malformedBatch", detail: "stdin is not {scenarios:[...]}"
                    ).json
                ],
            ])
            exit(1)
        }

        emit([
            "driver": "native-launcher-driver",
            "results": scenarios.map { runScenario($0).json },
        ])
        exit(0)
    }
}
