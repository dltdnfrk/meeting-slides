import AppKit
import ApplicationServices
import Foundation
import QuartzCore

func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    copy(element, kAXChildrenAttribute as String) as? [AXUIElement] ?? []
}
func text(_ element: AXUIElement) -> String? {
    [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute]
        .compactMap { copy(element, $0 as String) as? String }
        .first { !$0.isEmpty }
}
func findText(_ element: AXUIElement, expected: String, depth: Int = 0) -> AXUIElement? {
    guard depth < 8 else { return nil }
    if text(element) == expected { return element }
    for child in children(element) {
        if let found = findText(child, expected: expected, depth: depth + 1) { return found }
    }
    return nil
}
func size(_ element: AXUIElement) -> CGSize? {
    guard let raw = copy(element, kAXSizeAttribute as String), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    var result = CGSize.zero
    return AXValueGetValue(raw as! AXValue, .cgSize, &result) ? result : nil
}

final class WaitState: NSObject {
    let kind: String
    let expected: String
    let window: AXUIElement
    var observer: AXObserver?
    var displayLink: CADisplayLink?
    var displayFrames = 0
    var settling = false

    init(kind: String, expected: String, window: AXUIElement) {
        self.kind = kind
        self.expected = expected
        self.window = window
    }

    func matches() -> Bool {
        if kind == "text" { return findText(window, expected: expected) != nil }
        let parts = expected.split(separator: "x").compactMap { Double($0) }
        guard parts.count == 2, let actual = size(window) else { return false }
        return abs(actual.width - parts[0]) <= 1 && abs(actual.height - parts[1]) <= 1
    }

    func beginDisplaySettlement() {
        guard !settling else { return }
        settling = true
        guard let screen = NSScreen.main else { exit(9) }
        let link = screen.displayLink(target: self, selector: #selector(displayTick(_:)))
        displayLink = link
        link.add(to: .main, forMode: .default)
    }

    @objc private func displayTick(_ link: CADisplayLink) {
        displayFrames += 1
        guard displayFrames >= 2 else { return }
        link.invalidate()
        print("matched-and-composited \(kind)=\(expected)")
        fflush(stdout)
        exit(0)
    }
}

var state: WaitState!
let callback: AXObserverCallback = { _, _, _, _ in
    if state.matches() { state.beginDisplaySettlement() }
}

guard CommandLine.arguments.count == 5,
      let pid = Int32(CommandLine.arguments[1]),
      AXIsProcessTrusted()
else { exit(2) }
let kind = CommandLine.arguments[2]
let expected = CommandLine.arguments[3]
let readyFIFO = CommandLine.arguments[4]
let app = AXUIElementCreateApplication(pid)
let windows = copy(app, kAXWindowsAttribute as String) as? [AXUIElement] ?? []
guard let window = windows.first else { exit(3) }
state = WaitState(kind: kind, expected: expected, window: window)
var observer: AXObserver?
guard AXObserverCreate(pid, callback, &observer) == .success, let observer else { exit(4) }
state.observer = observer
let notification = kind == "text" ? kAXValueChangedNotification : kAXResizedNotification
let notificationTarget: AXUIElement
if kind == "text" {
    let statuses = ["연결 중", "대기 중", "녹음 준비 중", "녹음 중", "녹음 종료 중", "모델 전환 중", "연결 끊김 — 재연결 중", "오류"]
    guard let status = statuses.compactMap({ findText(window, expected: $0) }).first else { exit(5) }
    notificationTarget = status
} else {
    notificationTarget = window
}
guard AXObserverAddNotification(observer, notificationTarget, notification as CFString, nil) == .success else { exit(5) }
CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)

let fifoFD = open(readyFIFO, O_WRONLY)
guard fifoFD >= 0 else { exit(6) }
_ = write(fifoFD, "ready\n", 6)
close(fifoFD)
if state.matches() { state.beginDisplaySettlement() }
Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { _ in
    fputs("bounded AX/display deadline exceeded\n", stderr)
    exit(8)
}
CFRunLoopRun()
