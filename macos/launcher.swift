// ============================================================
// launcher.swift — Meeting Slides 네이티브 macOS 런처
// ============================================================
// 스크립트 번들로는 TCC(마이크 권한)의 주체가 될 수 없다:
// macOS는 Mach-O 네이티브 바이너리 + 번들 조합만 "앱"으로 인정한다.
// 그래서 이 런처가 직접 AVFoundation으로 권한을 요청해
// 프롬프트에 "Meeting Slides"가 뜨게 하고, 그 다음 서버를 실행한다.

import AVFoundation
import AppKit
import Foundation

let bundlePath = Bundle.main.bundlePath
let projectDir = (bundlePath as NSString).deletingLastPathComponent

func log(_ s: String) {
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
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
    which.standardError = Pipe()
    try? which.run()
    which.waitUntilExit()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return (out?.isEmpty == false) ? out : nil
}

/// 번들 주체로 마이크 권한 요청. 최초 1회만 프롬프트가 뜬다.
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

// ── 1. 마이크 권한 (앱 이름으로) ──
let micOK = requestMicAccess()
let statusMsg = micOK
    ? "마이크 권한 확인됨"
    : "⚠️ 마이크 권한 없음 — 시스템 설정에서 Meeting Slides를 켜야 합니다"
log(statusMsg)
try? statusMsg.write(toFile: "/tmp/ms-launcher-status.log", atomically: true, encoding: .utf8)

// ── 2. 서버 실행 ──
guard let bun = findBun() else {
    log("bun을 찾을 수 없습니다 — https://bun.sh 에서 설치해주세요")
    exit(1)
}

let server = Process()
server.executableURL = URL(fileURLWithPath: bun)
server.arguments = ["run", "server.ts"]
server.currentDirectoryURL = URL(fileURLWithPath: projectDir)
var env = ProcessInfo.processInfo.environment
if env["OPEN_BROWSER"] == nil { env["OPEN_BROWSER"] = "true" }
server.environment = env
server.standardOutput = FileHandle.standardOutput
server.standardError = FileHandle.standardError

do {
    try server.run()
} catch {
    log("서버 실행 실패: \(error.localizedDescription)")
    exit(1)
}

// ── 3. 브라우저 오픈 (서버가 자체 오픈하지만 이중으로 열리지 않게 짧게 대기 후 확인) ──
Thread.sleep(forTimeInterval: 3.0)
if let url = URL(string: "http://localhost:8787/") {
    NSWorkspace.shared.open(url)
}

// ── 4. 서버 생명주기와 함께 종료 ──
server.waitUntilExit()
