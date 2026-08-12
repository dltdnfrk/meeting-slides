// Meeting Slides webapp launcher: mic TCC + bun server + default browser.
// UI is http://localhost browser webapp.
//
// This file is the entry point only. It performs the real side effects (TCC
// prompts, process spawn, HTTP probes, EventKit polling, browser opening) and
// asks macos/AppLifecycle.swift what those results mean. Port parsing, health
// signature, startup decision, launch plan and shutdown ownership all live in
// that pure module, so they are testable from a headless process.

import AVFoundation
import AppKit
import EventKit
import Foundation

// MARK: - Side effects

enum LauncherIO {
    static let bundleURL = Bundle.main.bundleURL
    static let resourcesURL = Bundle.main.resourceURL

    static func log(_ s: String) {
        FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
        // 사용자 로그 디렉터리에도 남긴다.
        let path = LauncherEnvironment.logFilePath(homeDirectory: NSHomeDirectory())
        try? FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )
        let line = "\(ISO8601DateFormatter().string(from: Date()))  \(s)\n"
        guard let data = line.data(using: .utf8) else { return }
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    static func findBun() -> String? {
        let fm = FileManager.default
        for path in LauncherEnvironment.bunCandidatePaths(homeDirectory: NSHomeDirectory())
        where fm.isExecutableFile(atPath: path) {
            return path
        }
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        which.arguments = ["which", "bun"]
        let pipe = Pipe()
        which.standardOutput = pipe
        which.standardError = FileHandle.nullDevice
        try? which.run()
        which.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (out?.isEmpty == false) ? out : nil
    }

    /// 빌드 시 기록한 프로젝트 경로 → 없으면 .app 상위 디렉터리(레거시).
    /// 두 후보 모두 server.ts 를 가진 실제 체크아웃이어야 한다. 판정 규칙은
    /// ProjectResolution 이 갖고, 여기서는 파일 존재 여부만 알려준다.
    static func resolveProjectDir() throws -> String {
        var candidates: [String] = []
        if let resourcesURL {
            let marker = resourcesURL.appendingPathComponent("project-path.txt")
            if let text = try? String(contentsOf: marker, encoding: .utf8) {
                candidates.append(text)
            }
        }
        candidates.append(bundleURL.deletingLastPathComponent().path)
        return try ProjectResolution.projectDirectory(candidates: candidates) { path in
            FileManager.default.fileExists(
                atPath: (path as NSString)
                    .appendingPathComponent(ProjectResolution.serverEntryPoint)
            )
        }
    }

    static func requestMicAccess() -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            let sem = DispatchSemaphore(value: 0)
            var granted = false
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                granted = ok
                sem.signal()
            }
            _ = sem.wait(timeout: .now() + 120)
            return granted
        default:
            return false
        }
    }

    /// 한 번의 HTTP 프로브. 판정은 AppLifecycle의 순수 규칙이 담당한다.
    static func probeWebApp(port: Int) -> HealthProbe {
        let url = URL(string: "http://127.0.0.1:\(port)/")!
        var req = URLRequest(
            url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1.5
        )
        req.httpMethod = "GET"
        let sem = DispatchSemaphore(value: 0)
        var probe = HealthProbe.unreachable
        let task = URLSession.shared.dataTask(with: req) { data, response, _ in
            defer { sem.signal() }
            guard let http = response as? HTTPURLResponse else { return }
            probe = HealthProbe(
                reachable: true,
                statusCode: http.statusCode,
                body: data.flatMap { String(data: $0, encoding: .utf8) }
            )
        }
        task.resume()
        _ = sem.wait(timeout: .now() + 2)
        return probe
    }

    static func waitUntilWebAppReady(port: Int, timeoutSeconds: Double = 30) -> Bool {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if ServerHealth.evaluate(probeWebApp(port: port)).healthy { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return false
    }

    /// 캘린더에서 다음 회의 시작을 감지해 서버에 자동 녹음 시작을 알린다.
    /// EventKit 권한이 없거나 캘린더 항목이 없으면 조용히 무시한다.
    static func calendarAutoCapture(port: Int) {
        let store = EKEventStore()
        let sem = DispatchSemaphore(value: 0)
        var granted = false
        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents { ok, _ in
                granted = ok
                sem.signal()
            }
        } else {
            store.requestAccess(to: .event) { ok, _ in
                granted = ok
                sem.signal()
            }
        }
        _ = sem.wait(timeout: .now() + 10)
        guard granted else {
            log("캘린더 권한 없음 — 자동 녹음 비활성 (시스템 설정 > 개인정보 보호 > 캘린더)")
            return
        }
        let base = URL(string: "http://127.0.0.1:\(port)")!
        var lastTriggered = Date(timeIntervalSince1970: 0)
        let calendar = Calendar.current
        while true {
            let now = Date()
            let start = calendar.startOfDay(for: now)
            guard let end = calendar.date(byAdding: .day, value: 7, to: start) else { continue }
            let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
            for event in store.events(matching: predicate)
            where event.isAllDay == false && event.startDate > now {
                let delta = event.startDate.timeIntervalSince(now)
                if delta > 0, delta <= 60, event.startDate.timeIntervalSince(lastTriggered) > 60 {
                    lastTriggered = event.startDate
                    log("캘린더 감지: \(event.title ?? "(제목 없음)") — 자동 녹음 시작")
                    var req = URLRequest(url: base.appendingPathComponent("api/auto-capture"))
                    req.httpMethod = "POST"
                    URLSession.shared.dataTask(with: req).resume()
                }
            }
            Thread.sleep(forTimeInterval: 15)
        }
    }
}

// MARK: - App delegate

/// Owns the quit path only. Quitting while a capture is live asks for
/// confirmation first, so an ambient surface can never silently end a meeting.
final class LauncherAppDelegate: NSObject, NSApplicationDelegate {
    var minibar: MinibarWindowController?
    var onQuit: (() -> Void)?

    func applicationShouldTerminate(
        _ sender: NSApplication
    ) -> NSApplication.TerminateReply {
        if minibar?.isCapturing == true, !confirmQuitWhileCapturing() {
            return .terminateCancel
        }
        minibar?.stopConnection()
        onQuit?()
        return .terminateNow
    }

    private func confirmQuitWhileCapturing() -> Bool {
        let alert = NSAlert()
        alert.messageText = "녹음 중입니다"
        alert.informativeText = "지금 종료하면 진행 중인 녹음이 중단됩니다. 종료할까요?"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "종료")
        alert.addButton(withTitle: "계속 녹음")
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }
}

// MARK: - Entry point

@main
enum MeetingSlidesLauncher {
    /// Retained for the process lifetime so GCD never deactivates them.
    static var signalSources: [DispatchSourceSignal] = []
    /// Hand the main thread to AppKit so the minibar can live. The pure
    /// lifecycle rules still decide what quitting means; this only runs them.
    static func runLoop(
        minibar: MinibarWindowController,
        quit: @escaping () -> Void
    ) -> Never {
        let app = NSApplication.shared
        let delegate = LauncherAppDelegate()
        delegate.minibar = minibar
        delegate.onQuit = quit
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
        exit(0)
    }

    static func main() {
        let projectDir: String
        do {
            projectDir = try LauncherIO.resolveProjectDir()
        } catch {
            LauncherIO.log(
                "프로젝트 폴더를 찾지 못했습니다 — "
                    + "\(ProjectResolution.serverEntryPoint)가 있는 체크아웃이 필요합니다. "
                    + "scripts/build-app.sh로 다시 빌드하세요."
            )
            exit(1)
        }
        LauncherIO.log("프로젝트: \(projectDir)")
        LauncherIO.log("모드: 웹앱(브라우저)")

        // ── 1. 포트 ──
        let envFile = (projectDir as NSString).appendingPathComponent(".env")
        let port = LauncherEnvironment.httpPort(
            envFileContents: try? String(contentsOfFile: envFile, encoding: .utf8)
        )
        LauncherIO.log(
            "\(LauncherEnvironment.portKey)=\(port) "
                + "(기본값 \(LauncherEnvironment.defaultHTTPPort))"
        )

        // ── 2. 이미 떠 있는 Bun 세션이 있으면 그것을 단일 진실로 채택한다. ──
        let startup: StartupDecision
        do {
            startup = try StartupPlanner.decide(probe: LauncherIO.probeWebApp(port: port))
        } catch {
            LauncherIO.log("포트 \(port)를 다른 서버가 사용 중입니다 — 두 번째 서버를 띄우지 않습니다.")
            exit(1)
        }

        let plan: ServerLaunchPlan
        do {
            plan = try LauncherEnvironment.serverLaunchPlan(
                bunPath: LauncherIO.findBun(), projectDir: projectDir, port: port
            )
        } catch {
            LauncherIO.log("bun을 찾을 수 없습니다 — https://bun.sh")
            exit(1)
        }

        // ── 3. 캘린더 자동 녹음 (백그라운드 폴링) ──
        let calendarThread = Thread { LauncherIO.calendarAutoCapture(port: port) }
        calendarThread.name = "calendar-auto-capture"
        calendarThread.start()

        // ── 4. 마이크 권한 (번들 이름 = Meeting Slides) ──
        let micOK = LauncherIO.requestMicAccess()
        LauncherIO.log(
            micOK
                ? "마이크 권한 확인됨"
                : "⚠️ 마이크 권한 없음 — 시스템 설정에서 Meeting Slides 허용 필요"
        )

        // ── 5. 서버. 브라우저 자동 오픈은 런처가 1회만 담당. ──
        var lifecycle = ServerLifecycle(ownsServer: startup.ownsServer)
        let server = Process()
        if startup.ownsServer {
            server.executableURL = URL(fileURLWithPath: plan.executablePath)
            server.arguments = plan.arguments
            server.currentDirectoryURL = URL(fileURLWithPath: plan.workingDirectory)
            var env = ProcessInfo.processInfo.environment
            for (key, value) in plan.environmentOverlay { env[key] = value }
            server.environment = env
            server.standardOutput = FileHandle.standardOutput
            server.standardError = FileHandle.standardError
            do {
                try server.run()
                LauncherIO.log("서버 시작 pid=\(server.processIdentifier) port=\(port)")
            } catch {
                LauncherIO.log("서버 실행 실패: \(error.localizedDescription)")
                exit(1)
            }
        } else {
            LauncherIO.log("이미 실행 중인 Meeting Slides 서버를 사용합니다 port=\(port)")
        }

        /// 순수 생명주기 규칙이 내린 결정을 실제 프로세스 동작으로 옮긴다.
        func apply(_ effects: [ServerLifecycle.Effect]) -> Never {
            for effect in effects {
                switch effect {
                case .terminateServer:
                    if server.isRunning { server.terminate() }
                case let .exit(code):
                    LauncherIO.log("런처 종료 code=\(code)")
                    exit(code)
                case .none:
                    break
                }
            }
            exit(lifecycle.exitCode)
        }

        // ── 6. 웹앱 ready 후 기본 브라우저로 오픈 ──
        guard LauncherIO.waitUntilWebAppReady(port: port) else {
            LauncherIO.log("서버가 \(port)에서 준비되지 않았습니다. 로그를 확인하세요.")
            apply(lifecycle.handle(.readinessFailed))
        }
        LauncherIO.log("웹앱 ready → 브라우저 오픈 \(plan.browserURL)")
        if let appURL = URL(string: plan.browserURL) { NSWorkspace.shared.open(appURL) }

        // ── 7. 네이티브 미니바. 브라우저가 여전히 완전한 작업 공간이고,
        //      미니바는 같은 Bun 세션을 투영하는 상시 앰비언트 컨트롤이다. ──
        let minibar = MinibarWindowController(port: port)
        minibar.installStatusItem()
        minibar.connect()
        // 앱이 직접 띄운 표면이므로 OS 포커스를 뺏지 않는다.
        minibar.present(origin: .automatic)
        LauncherIO.log("미니바 준비됨 port=\(port)")

        // ── 8. 서버 생명주기 ──
        guard startup.ownsServer else {
            // 채택한 세션은 이 런처가 소유하지 않는다 — 브라우저와 미니바를
            // 띄운 뒤에도 서버는 건드리지 않는다.
            LauncherIO.log("채택한 서버 — 이 런처는 서버를 소유하지 않습니다")
            runLoop(minibar: minibar) { apply(lifecycle.handle(.quit)) }
        }

        // 서버 감시는 백그라운드로 옮긴다. 메인 스레드는 미니바 런루프가 쓴다.
        let watcher = Thread {
            server.waitUntilExit()
            let code = server.terminationStatus
            DispatchQueue.main.async {
                LauncherIO.log("서버 종료 code=\(code)")
                apply(lifecycle.handle(.serverExited(code: code)))
            }
        }
        watcher.name = "server-watch"
        watcher.start()

        // A raw SIGTERM/SIGINT (logout, pkill, a controlling script) never
        // reaches applicationShouldTerminate, so without this the owned Bun
        // server would survive the launcher and keep the port. Route the
        // signal through the same pure lifecycle a clean quit uses, so the
        // terminator runs at most once. The sources live on the type, not in
        // this scope, or GCD would deactivate them at the closing brace.
        for sig: Int32 in [SIGTERM, SIGINT] {
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            signal(sig, SIG_IGN)
            source.setEventHandler {
                LauncherIO.log("시그널 받음 sig=\(sig)")
                apply(lifecycle.handle(.interrupt))
            }
            source.resume()
            signalSources.append(source)
        }

        runLoop(minibar: minibar) { apply(lifecycle.handle(.quit)) }
    }
}
