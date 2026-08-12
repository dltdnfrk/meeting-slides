// Headless probe for the pure project-resolution rule in macos/AppLifecycle.swift.
//
// Reads a JSON batch on stdin and writes one JSON document to stdout. It
// performs no filesystem access: the "does this directory hold server.ts"
// answer is supplied per scenario, so the rule is exercised as a pure value
// transformation with no clock, no sleep and no IO.
//
// Usage:
//   swiftc -O -o probe macos/AppLifecycle.swift tests/fixtures/project-resolution-probe.swift
//   echo '{"scenarios":[...]}' | ./probe

import Foundation

struct ProbeResult {
    let name: String
    let ok: Bool
    let value: Any?
    let error: String?

    var json: [String: Any] {
        var out: [String: Any] = ["name": name, "ok": ok]
        if let value { out["value"] = value }
        if let error { out["error"] = error }
        return out
    }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

@main
enum ProjectResolutionProbe {
    static func main() throws {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard let root = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
              let scenarios = root["scenarios"] as? [[String: Any]]
        else {
            fail("expected {\"scenarios\":[...]} on stdin")
        }

        var results: [ProbeResult] = []
        for scenario in scenarios {
            guard let name = scenario["name"] as? String,
                  let candidates = scenario["candidates"] as? [String]
            else {
                fail("each scenario needs name and candidates")
            }
            // Directories the harness declares to hold the server entry point.
            let serving = Set(scenario["serving"] as? [String] ?? [])
            do {
                let resolved = try ProjectResolution.projectDirectory(candidates: candidates) {
                    serving.contains($0)
                }
                results.append(ProbeResult(name: name, ok: true, value: resolved, error: nil))
            } catch let failure as LauncherFailure {
                results.append(
                    ProbeResult(name: name, ok: false, value: nil, error: failure.rawValue)
                )
            } catch {
                results.append(ProbeResult(name: name, ok: false, value: nil, error: "\(error)"))
            }
        }

        let document: [String: Any] = [
            "probe": "project-resolution",
            "entryPoint": ProjectResolution.serverEntryPoint,
            "results": results.map(\.json),
        ]
        let data = try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}
