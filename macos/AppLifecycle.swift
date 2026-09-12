// Pure application lifecycle rules for the Meeting Slides macOS launcher.
//
// Everything a launcher decides — where the project lives, which port the Bun
// webapp uses, how Bun is invoked, whether a server is already healthy on that
// port, whether this process owns the server it must later terminate — is
// expressed here as pure value transformations.
//
// This module imports Foundation only: no AppKit, no EventKit, no AVFoundation,
// no Process, no URLSession, no Thread.sleep, no clock. `macos/launcher.swift`
// keeps the real side effects (TCC prompts, process spawn, HTTP probes,
// EventKit polling, browser opening) and asks this module what to do with them,
// so every decision is testable from a headless process.
//
// There is exactly one Bun session: the launcher either starts it or adopts a
// healthy one. This module never becomes a second engine or state store.

import Foundation

// MARK: - Environment resolution

public enum LauncherFailure: String, Error, Equatable {
    case bunNotFound
    case portOccupiedByForeignServer
    case projectDirectoryNotFound
    case automationTokenLoadFailed
}

/// Which project directory the launcher runs Bun in.
///
/// A directory only counts if it holds the server entry point the launch plan
/// executes. Accepting any existing directory (the legacy "binary's parent"
/// fallback) meant a bare binary resolved a path with no `server.ts` and no
/// `.env`, then spawned a session that could never serve and silently ran on
/// the default port.
public enum ProjectResolution {
    /// The file whose presence makes a directory a Meeting Slides checkout.
    public static let serverEntryPoint = "server.ts"

    /// - Parameters:
    ///   - candidates: ordered paths to try, most authoritative first.
    ///     The launcher supplies the packaged `project-path.txt` marker first
    ///     and the legacy bundle-parent path second.
    ///   - hasServerEntryPoint: does this directory contain `server.ts`?
    ///     The caller performs the filesystem check; this rule stays pure.
    public static func projectDirectory(
        candidates: [String],
        hasServerEntryPoint: (String) -> Bool
    ) throws -> String {
        for candidate in candidates {
            let path = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            if path.isEmpty { continue }
            if hasServerEntryPoint(path) { return path }
        }
        throw LauncherFailure.projectDirectoryNotFound
    }
}

/// Result of one HTTP probe against `http://127.0.0.1:<port>/`.
/// The launcher performs the request; this module only judges the outcome.
public struct HealthProbe: Equatable {
    public let reachable: Bool
    public let statusCode: Int?
    public let body: String?
    public let projectIdentity: String?

    public init(reachable: Bool, statusCode: Int? = nil, body: String? = nil, projectIdentity: String? = nil) {
        self.reachable = reachable
        self.statusCode = statusCode
        self.body = body
        self.projectIdentity = projectIdentity
    }

    public static let unreachable = HealthProbe(reachable: false)
}

public enum HealthReason: String, Equatable {
    case ok
    case unreachable
    case badStatus
    case signatureMismatch
    case identityMismatch
}

public struct HealthVerdict: Equatable {
    public let healthy: Bool
    public let reason: HealthReason
}

/// The webapp readiness signature: the shipped HTML title plus the runtime
/// bootstrap marker. Unchanged from the original launcher.
public enum ServerHealth {
    public static let titleMarker = "<title>Meeting Slides"
    public static let bootstrapMarker = "runtime-bootstrap"

    public static func evaluate(_ probe: HealthProbe) -> HealthVerdict {
        guard probe.reachable else {
            return HealthVerdict(healthy: false, reason: .unreachable)
        }
        guard let status = probe.statusCode, status == 200 else {
            return HealthVerdict(healthy: false, reason: .badStatus)
        }
        guard let body = probe.body,
              body.contains(titleMarker), body.contains(bootstrapMarker)
        else {
            return HealthVerdict(healthy: false, reason: .signatureMismatch)
        }
        return HealthVerdict(healthy: true, reason: .ok)
    }
}

/// How Bun must be spawned. The launcher turns this into a real `Process`.
public struct ServerLaunchPlan: Equatable {
    public let executablePath: String
    public let arguments: [String]
    public let workingDirectory: String
    /// Variables overlaid onto the inherited process environment.
    public let environmentOverlay: [String: String]
    public let browserURL: String
}

public enum LauncherEnvironment {
    public static let defaultHTTPPort = 8787
    public static let portKey = "HTTP_PORT"

    /// Where the launcher looks for bun before falling back to `which bun`.
    public static func bunCandidatePaths(homeDirectory: String) -> [String] {
        [
            "\(homeDirectory)/.bun/bin/bun",
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
        ]
    }

    /// User-visible launcher log file.
    public static func logFilePath(homeDirectory: String) -> String {
        (homeDirectory as NSString)
            .appendingPathComponent("Library/Logs/Meeting Slides/launcher.log")
    }

    /// Parse `HTTP_PORT` out of a `.env` file body. A missing file, missing key,
    /// unparsable value or out-of-range port all fall back to the default.
    public static func httpPort(envFileContents: String?) -> Int {
        guard let contents = envFileContents else { return defaultHTTPPort }
        for raw in contents.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2,
                  parts[0].trimmingCharacters(in: .whitespaces) == portKey
            else { continue }
            let rawValue = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
            if let port = Int(rawValue), (1...65535).contains(port) { return port }
            return defaultHTTPPort
        }
        return defaultHTTPPort
    }

    /// Build the single Bun invocation. `OPEN_BROWSER=false` keeps browser
    /// opening a launcher responsibility; `HTTP_PORT` pins the resolved port.
    public static func serverLaunchPlan(
        bunPath: String?,
        projectDir: String,
        port: Int
    ) throws -> ServerLaunchPlan {
        guard let bunPath, !bunPath.isEmpty else { throw LauncherFailure.bunNotFound }
        return ServerLaunchPlan(
            executablePath: bunPath,
            arguments: ["run", "server.ts"],
            workingDirectory: projectDir,
            environmentOverlay: ["OPEN_BROWSER": "false", portKey: String(port)],
            browserURL: "http://localhost:\(port)/"
        )
    }
}

// MARK: - Startup decision

/// Ask the same Bun runtime that starts the server to resolve its environment.
/// This preserves inherited overrides, layered dotenv files and expansion.
public enum CalendarAutomation {
    public static let tokenLoadArguments = [
        "--print", "JSON.stringify(process.env.MEETING_SLIDES_AUTOMATION_TOKEN?.trim() ?? '')",
    ]

    public static func captureRequest(port: Int, tokenJSON: Data) throws -> URLRequest? {
        let token = try JSONDecoder().decode(String.self, from: tokenJSON)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return nil }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/auto-capture")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        return request
    }
}

public enum StartupDecision: String, Equatable {
    /// Nothing is listening: this launcher starts and owns the Bun session.
    case startServer
    /// A healthy Meeting Slides server is already running: adopt it, own nothing.
    case adoptRunningServer

    public var ownsServer: Bool { self == .startServer }
}

public enum StartupPlanner {
    /// Decide what to do about the configured port before spawning anything.
    ///
    /// A reachable but foreign listener is a typed conflict: starting a second
    /// Bun session on an occupied port would create a second source of truth.
    public static func decide(probe: HealthProbe, canonicalProjectPath: String? = nil) throws -> StartupDecision {
        if !probe.reachable { return .startServer }
        let verdict = ServerHealth.evaluate(probe)
        guard verdict.healthy else { throw LauncherFailure.portOccupiedByForeignServer }
        if let canonicalProjectPath, probe.projectIdentity != canonicalProjectPath {
            throw LauncherFailure.portOccupiedByForeignServer
        }
        return .adoptRunningServer
        throw LauncherFailure.portOccupiedByForeignServer
    }
}

// MARK: - Readiness

public struct ReadinessOutcome: Equatable {
    public let ready: Bool
    /// Number of probes consumed, so the caller can report progress truthfully.
    public let attempts: Int
}

public enum ReadinessEvaluator {
    /// Walk an ordered probe sequence and stop at the first healthy result.
    /// Attempt scheduling (delay, deadline) is the caller's business; this rule
    /// is a pure fold so tests never wait on a clock.
    public static func evaluate<S: Sequence>(probes: S) -> ReadinessOutcome
    where S.Element == HealthProbe {
        var attempts = 0
        for probe in probes {
            attempts += 1
            if ServerHealth.evaluate(probe).healthy {
                return ReadinessOutcome(ready: true, attempts: attempts)
            }
        }
        return ReadinessOutcome(ready: false, attempts: attempts)
    }
}

// MARK: - Process ownership and shutdown

public enum LifecycleEvent: Equatable {
    /// The supervised server exited on its own with this status.
    case serverExited(code: Int32)
    /// The user quit the app (Dock quit, menu quit).
    case quit
    /// SIGINT/SIGTERM reached the launcher.
    case interrupt
    /// The webapp never became ready within the launcher's budget.
    case readinessFailed
}

public enum LifecycleState: String, Equatable {
    case running
    case exited
}

/// Tracks who owns the Bun process and how many termination requests the
/// launcher is allowed to issue. Repeated interrupts, a quit after an interrupt
/// or a server that already exited must never terminate twice, and an adopted
/// server must never be terminated at all.
public struct ServerLifecycle {
    public private(set) var state: LifecycleState = .running
    public private(set) var terminationRequests = 0
    public private(set) var exitCode: Int32 = 0

    private let ownsServer: Bool

    public init(ownsServer: Bool) {
        self.ownsServer = ownsServer
    }

    /// What the launcher must physically do after an event.
    public enum Effect: Equatable {
        case none
        case terminateServer
        case exit(code: Int32)
    }

    @discardableResult
    public mutating func handle(_ event: LifecycleEvent) -> [Effect] {
        guard state == .running else { return [] }

        switch event {
        case let .serverExited(code):
            state = .exited
            exitCode = code
            return [.exit(code: code)]

        case .quit, .interrupt:
            return shutdown(code: 0)

        case .readinessFailed:
            return shutdown(code: 1)
        }
    }

    /// The only place a termination is requested. Reaching `exited` is what makes
    /// it happen exactly once: `handle` ignores every later event.
    private mutating func shutdown(code: Int32) -> [Effect] {
        var effects: [Effect] = []
        if ownsServer {
            terminationRequests += 1
            effects.append(.terminateServer)
        }
        state = .exited
        exitCode = code
        effects.append(.exit(code: code))
        return effects
    }
}
