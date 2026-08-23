import ApplicationServices
import AppKit
import Foundation

func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    (attr(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}
func text(_ element: AXUIElement, _ name: String) -> String? { attr(element, name) as? String }
func findButton(_ element: AXUIElement, title: String) -> AXUIElement? {
    if text(element, kAXRoleAttribute as String) == kAXButtonRole as String,
       text(element, kAXTitleAttribute as String) == title { return element }
    for child in children(element) {
        if let found = findButton(child, title: title) { return found }
    }
    return nil
}

let args = CommandLine.arguments
guard args.count == 3, let pid = Int32(args[1]) else { exit(2) }
let output = args[2]
guard AXIsProcessTrusted() else { exit(3) }
let app = AXUIElementCreateApplication(pid)
let box = NSMutableDictionary(dictionary: ["pid": Int(pid), "observerSubscribedBeforeTrigger": true])
let callback: AXObserverCallback = { _, element, notification, refcon in
    let state = Unmanaged<NSMutableDictionary>.fromOpaque(refcon!).takeUnretainedValue()
    state["notification"] = notification as String
    state["windowRole"] = text(element, kAXRoleAttribute as String) ?? NSNull()
    state["windowTitle"] = text(element, kAXTitleAttribute as String) ?? NSNull()
    if let button = findButton(element, title: "계속 녹음") {
        state["continueButtonFound"] = true
        state["pressStatus"] = AXUIElementPerformAction(button, kAXPressAction as CFString).rawValue
    } else {
        state["continueButtonFound"] = false
    }
    state["done"] = true
    CFRunLoopStop(CFRunLoopGetCurrent())
}
var observer: AXObserver?
let created = AXObserverCreate(pid, callback, &observer)
guard created == .success, let observer else { exit(4) }
let added = AXObserverAddNotification(observer, app, kAXWindowCreatedNotification as CFString, Unmanaged.passUnretained(box).toOpaque())
box["observerCreateStatus"] = created.rawValue
box["observerAddStatus"] = added.rawValue
CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
box["frontmostSetStatus"] = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue).rawValue
box["terminateRequestedAfterSubscription"] = NSRunningApplication(processIdentifier: pid)?.terminate() ?? false
Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { _ in
    box["timeoutFired"] = true
    CFRunLoopStop(CFRunLoopGetCurrent())
}
CFRunLoopRun()
box["timedOut"] = box["done"] as? Bool != true
let data = try! JSONSerialization.data(withJSONObject: box, options: [.prettyPrinted, .sortedKeys])
try! data.write(to: URL(fileURLWithPath: output))
if box["done"] as? Bool != true { exit(5) }
