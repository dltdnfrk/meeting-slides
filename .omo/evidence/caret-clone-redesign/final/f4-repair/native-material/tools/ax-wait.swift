import ApplicationServices
import Foundation

func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    copy(element, kAXChildrenAttribute as String) as? [AXUIElement] ?? []
}
func findStatus(_ element: AXUIElement, statuses: [String], depth: Int = 0) -> AXUIElement? {
    guard depth < 8 else { return nil }
    let candidates = [
        copy(element, kAXValueAttribute as String) as? String,
        copy(element, kAXTitleAttribute as String) as? String,
        copy(element, kAXDescriptionAttribute as String) as? String,
    ].compactMap { $0 }.filter { !$0.isEmpty }
    if candidates.contains(where: statuses.contains) { return element }
    for child in children(element) {
        if let found = findStatus(child, statuses: statuses, depth: depth + 1) { return found }
    }
    return nil
}
func text(_ element: AXUIElement) -> String? {
    let values = [
        copy(element, kAXValueAttribute as String) as? String,
        copy(element, kAXTitleAttribute as String) as? String,
        copy(element, kAXDescriptionAttribute as String) as? String,
    ].compactMap { $0 }
    return values.first(where: { !$0.isEmpty })
}
func size(_ element: AXUIElement) -> CGSize? {
    guard let raw = copy(element, kAXSizeAttribute as String), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    var result = CGSize.zero
    return AXValueGetValue(raw as! AXValue, .cgSize, &result) ? result : nil
}

final class State {
    let expectedText: String?
    let expectedSize: CGSize?
    let target: AXUIElement
    init(expectedText: String?, expectedSize: CGSize?, target: AXUIElement) {
        self.expectedText = expectedText; self.expectedSize = expectedSize; self.target = target
    }
    func matches() -> Bool {
        if let expectedText { return text(target) == expectedText }
        guard let expectedSize, let actual = size(target) else { return false }
        return abs(actual.width - expectedSize.width) <= 1 && abs(actual.height - expectedSize.height) <= 1
    }
}

var state: State!
let callback: AXObserverCallback = { _, _, _, _ in
    if state.matches() { print("matched"); fflush(stdout); exit(0) }
}

guard CommandLine.arguments.count == 5,
      let pid = Int32(CommandLine.arguments[1]), AXIsProcessTrusted()
else { exit(2) }
let kind = CommandLine.arguments[2], expected = CommandLine.arguments[3], readyFIFO = CommandLine.arguments[4]
let app = AXUIElementCreateApplication(pid)
let windows = copy(app, kAXWindowsAttribute as String) as? [AXUIElement] ?? []
guard let window = windows.first else { exit(3) }
let target: AXUIElement
let notification: CFString
if kind == "text" {
    let statuses = ["연결 중", "대기 중", "녹음 준비 중", "녹음 중", "녹음 종료 중", "모델 전환 중", "연결 끊김 — 재연결 중", "오류"]
    guard let found = findStatus(window, statuses: statuses) else { exit(4) }
    target = found
    notification = kAXValueChangedNotification as CFString
    state = State(expectedText: expected, expectedSize: nil, target: target)
} else {
    let parts = expected.split(separator: "x").compactMap { Double($0) }
    guard parts.count == 2 else { exit(5) }
    target = window
    notification = kAXResizedNotification as CFString
    state = State(expectedText: nil, expectedSize: CGSize(width: parts[0], height: parts[1]), target: target)
}
// Publish readiness before checking the already-current state. This lets the
// driver use the same exact-state primitive for initial hydration and changes.
let fifoFD = open(readyFIFO, O_WRONLY)
guard fifoFD >= 0 else { exit(6) }
_ = write(fifoFD, "ready\n", 6)
close(fifoFD)
if state.matches() { print("matched"); exit(0) }
var observer: AXObserver?
guard AXObserverCreate(pid, callback, &observer) == .success, let observer else { exit(7) }
guard AXObserverAddNotification(observer, target, notification, nil) == .success else { exit(8) }
CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { _ in
    fputs("bounded deadline exceeded\n", stderr); exit(8)
}
CFRunLoopRun()
