// Meeting Slides webapp launcher: mic TCC + bun server + default browser.
// UI is http://localhost browser webapp.

import AVFoundation
import AppKit
import EventKit
import Foundation

let bundleURL = Bundle.main.bundleURL
let resourcesURL = Bundle.main.resourceURL

func log(_ s: String) {
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
    // 사용자 로그 디렉터리에도 남긴다.
    let dir = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Logs/Meeting Slices")
        .replacingOccurrences(of: "Meeting Slices", with: "Meeting Slides")
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let path = (dir as NSString).appendingPathComponent("launcher.log")
    let line = "\(ISO8601DateFormatter().string(from: Date()))  \(s)\n"
    if let data = line.data(using: .utf8) {
        if FileManager.default.fileExists(atPath: path) {
            if let handle = FileHandle(forWritingAtPath: path) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            }
        } else {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }
}

func findBun() -> String? {
    let fm = FileManager.default
    let candidates = [
        "\(NSHomeDirectory())/.bun/bin/bun",
        "/opt/homebrew/bin/bun",
        "/usr/local/bin/bun",
    ]
    for path in candidates where fm.isExecutableFile(atPath: path) { return path }
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
func resolveProjectDir() -> String {
    if let resourcesURL {
        let marker = resourcesURL.appendingPathComponent("project-path.txt")
        if let text = try? String(contentsOf: marker, encoding: .utf8) {
            let path = text.trimmingCharacters(in: .whitespacesAndNewlines)
            var isDir: ObjCBool = false
            if !path.isEmpty, FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue {
                return path
            }
        }
    }
    // 레거시: Meeting Slides.app 이 프로젝트 루트 안에 있을 때
    return bundleURL.deletingLastPathComponent().path
}

func requestMicAccess() -> Bool {
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

func readHttpPort(projectDir: String) -> Int {
    let envFile = (projectDir as NSString).appendingPathComponent(".env")
    guard let contents = try? String(contentsOfFile: envFile, encoding: .utf8) else { return 8787 }
    for raw in contents.split(whereSeparator: \.isNewline) {
        let line = raw.trimmingCharacters(in: .whitespaces)
        if line.hasPrefix("#") || line.isEmpty { continue }
        let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces) == "HTTP_PORT" else { continue }
        if let port = Int(parts[1].trimmingCharacters(in: .whitespacesAndNewlines)), (1...65535).contains(port) {
            return port
        }
    }
    return 8787
}

/// 서버 readiness: 웹앱 HTML 시그니처 (WKWebView 아님).
func waitUntilWebAppReady(port: Int, timeoutSeconds: Double = 30) -> Bool {
    let url = URL(string: "http://127.0.0.1:\(port)/")!
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while Date() < deadline {
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1.5)
        req.httpMethod = "GET"
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        let task = URLSession.shared.dataTask(with: req) { data, response, _ in
            defer { sem.signal() }
            guard
                let http = response as? HTTPURLResponse, http.statusCode == 200,
                let data, let body = String(data: data, encoding: .utf8)
            else { return }
            // launcher health: title + runtime-bootstrap
            ok = body.contains("<title>Meeting Slides") && body.contains("runtime-bootstrap")
        }
        task.resume()
        _ = sem.wait(timeout: .now() + 2)
        if ok { return true }
        Thread.sleep(forTimeInterval: 0.25)
    }
    return false
}

/// 캘린더에서 다음 회의 시작을 감지해 서버에 자동 녹음 시작을 알린다.
/// EventKit 권한이 없거나 캘린더 항목이 없으면 조용히 무시한다.
func calendarAutoCapture(port: Int) {
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
    func post(_ path: String) {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        let task = URLSession.shared.dataTask(with: req)
        task.resume()
    }
    var lastTriggered = Date(timeIntervalSince1970: 0)
    let calendar = Calendar.current
    while true {
        let now = Date()
        let start = calendar.startOfDay(for: now)
        guard let end = calendar.date(byAdding: .day, value: 7, to: start) else { continue }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        let events = store.events(matching: predicate)
        for event in events where event.isAllDay == false && event.startDate > now {
            let delta = event.startDate.timeIntervalSince(now)
            if delta > 0, delta <= 60, event.startDate.timeIntervalSince(lastTriggered) > 60 {
                lastTriggered = event.startDate
                log("캘린더 감지: \(event.title ?? "(제목 없음)") — 자동 녹음 시작")
                post("api/auto-capture")
            }
        }
        Thread.sleep(forTimeInterval: 15)
    }
}

// ── 1. 프로젝트 / bun ──
let projectDir = resolveProjectDir()
log("프로젝트: \(projectDir)")
log("모드: 웹앱(브라우저)")

guard let bun = findBun() else {
    log("bun을 찾을 수 없습니다 — https://bun.sh")
    exit(1)
}

let port = readHttpPort(projectDir: projectDir)
let appURL = URL(string: "http://localhost:\(port)/")!

// ── 0. 캘린더 자동 녹음 (백그라운드 폴링) ──
let calendarThread = Thread {
    calendarAutoCapture(port: port)
}
calendarThread.name = "calendar-auto-capture"
calendarThread.start()


// ── 2. 마이크 권한 (번들 이름 = Meeting Slides) ──
let micOK = requestMicAccess()
log(micOK ? "마이크 권한 확인됨" : "⚠️ 마이크 권한 없음 — 시스템 설정에서 Meeting Slides 허용 필요")

// ── 3. 서버 (웹앱). 브라우저 자동 오픈은 런처가 1회만 담당. ──
let server = Process()
server.executableURL = URL(fileURLWithPath: bun)
server.arguments = ["run", "server.ts"]
server.currentDirectoryURL = URL(fileURLWithPath: projectDir)
var env = ProcessInfo.processInfo.environment
env["OPEN_BROWSER"] = "false" // 서버 쪽 중복 open 방지
env["HTTP_PORT"] = String(port)
server.environment = env
server.standardOutput = FileHandle.standardOutput
server.standardError = FileHandle.standardError

do {
    try server.run()
    log("서버 시작 pid=\(server.processIdentifier) port=\(port)")
} catch {
    log("서버 실행 실패: \(error.localizedDescription)")
    exit(1)
}

// ── 4. 웹앱 ready 후 기본 브라우저로 오픈 ──
if waitUntilWebAppReady(port: port) {
    log("웹앱 ready → 브라우저 오픈 \(appURL.absoluteString)")
    NSWorkspace.shared.open(appURL)
} else {
    log("서버가 \(port)에서 준비되지 않았습니다. 로그를 확인하세요.")
    server.terminate()
    exit(1)
}

// ── 5. 서버 생명주기 ──
server.waitUntilExit()
log("서버 종료 code=\(server.terminationStatus)")
exit(server.terminationStatus)
