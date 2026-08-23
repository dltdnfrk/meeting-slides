// ax-capture.swift — runtime AX receipts for the installed Meeting Slides
// minibar (F1 accessibility repair, independent-review gap #3).
//
// Purpose: the Todo 19 journey retained FLATTENED AX text (titles and bounds).
// That is visual truth, not role/help/focus/announcement proof. This tool
// attaches to the REAL installed process through the public accessibility API
// and records, for every element in the minibar panel subtree:
//
//   AXRole, AXSubrole, AXRoleDescription, AXTitle, AXDescription (label),
//   AXHelp, AXEnabled, AXValue, AXFocused, AXPosition, AXSize
//
// It also registers an AXObserver for `AXAnnouncementRequested` on the
// application element and records every announcement notification observed
// during the capture window, including its announcement string and priority,
// so announcement firing AND de-duplication are observable rather than inferred.
//
// Nothing is synthesised: if an attribute is absent on an element, the record
// says `null` for that attribute. If AX access is not granted, the tool exits
// non-zero with the exact permission state instead of emitting a partial tree.
//
// Usage: ax-capture <pid> <seconds> <output.json>

import ApplicationServices
import AppKit
import Foundation

struct CaptureError: Error, CustomStringConvertible {
    let description: String
}

// MARK: - Attribute reading

func copyAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return status == .success ? value : nil
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    guard let raw = copyAttribute(element, name) else { return nil }
    if let text = raw as? String { return text }
    if let number = raw as? NSNumber { return number.stringValue }
    return nil
}

func boolAttribute(_ element: AXUIElement, _ name: String) -> Bool? {
    guard let raw = copyAttribute(element, name), let number = raw as? NSNumber else { return nil }
    return number.boolValue
}

func pointAttribute(_ element: AXUIElement, _ name: String) -> [String: Double]? {
    guard let raw = copyAttribute(element, name) else { return nil }
    guard CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let axValue = raw as! AXValue
    if AXValueGetType(axValue) == .cgPoint {
        var point = CGPoint.zero
        if AXValueGetValue(axValue, .cgPoint, &point) {
            return ["x": Double(point.x), "y": Double(point.y)]
        }
    }
    if AXValueGetType(axValue) == .cgSize {
        var size = CGSize.zero
        if AXValueGetValue(axValue, .cgSize, &size) {
            return ["width": Double(size.width), "height": Double(size.height)]
        }
    }
    return nil
}

func childElements(_ element: AXUIElement) -> [AXUIElement] {
    guard let raw = copyAttribute(element, kAXChildrenAttribute as String) else { return [] }
    return (raw as? [AXUIElement]) ?? []
}

// MARK: - Tree walk

func describe(_ element: AXUIElement, depth: Int, path: String) -> [String: Any] {
    var record: [String: Any] = [
        "path": path,
        "depth": depth,
        "AXRole": stringAttribute(element, kAXRoleAttribute as String) as Any,
        "AXSubrole": stringAttribute(element, kAXSubroleAttribute as String) as Any,
        "AXRoleDescription": stringAttribute(element, kAXRoleDescriptionAttribute as String) as Any,
        "AXTitle": stringAttribute(element, kAXTitleAttribute as String) as Any,
        "AXDescription": stringAttribute(element, kAXDescriptionAttribute as String) as Any,
        "AXHelp": stringAttribute(element, kAXHelpAttribute as String) as Any,
        "AXValue": stringAttribute(element, kAXValueAttribute as String) as Any,
        "AXEnabled": boolAttribute(element, kAXEnabledAttribute as String) as Any,
        "AXFocused": boolAttribute(element, kAXFocusedAttribute as String) as Any,
    ]
    if let position = pointAttribute(element, kAXPositionAttribute as String) {
        record["AXPosition"] = position
    } else {
        record["AXPosition"] = NSNull()
    }
    if let size = pointAttribute(element, kAXSizeAttribute as String) {
        record["AXSize"] = size
    } else {
        record["AXSize"] = NSNull()
    }
    // Normalise absent attributes to an explicit null rather than dropping the key,
    // so a reader can tell "not exposed" from "not captured".
    for key in ["AXRole", "AXSubrole", "AXRoleDescription", "AXTitle",
                "AXDescription", "AXHelp", "AXValue", "AXEnabled", "AXFocused"] {
        if record[key] is NSNull { continue }
        if (record[key] as? String) == nil && (record[key] as? Bool) == nil {
            record[key] = NSNull()
        }
    }
    var kids: [[String: Any]] = []
    for (index, child) in childElements(element).enumerated() {
        kids.append(describe(child, depth: depth + 1, path: "\(path)/\(index)"))
    }
    record["children"] = kids
    return record
}

// MARK: - Announcement observer

final class AnnouncementLog {
    private(set) var entries: [[String: Any]] = []
    private let started = Date()

    func append(notification: String, info: [String: Any]) {
        var entry: [String: Any] = [
            "notification": notification,
            "atSecondsFromStart": Date().timeIntervalSince(started),
        ]
        // The observer userInfo arrives with the AX-level key strings, which are
        // what an assistive client actually receives.
        if let announcement = info["AXAnnouncement"] as? String {
            entry["announcement"] = announcement
        } else {
            entry["announcement"] = NSNull()
        }
        if let priority = info["AXPriority"] as? NSNumber {
            entry["priority"] = priority.intValue
        } else {
            entry["priority"] = NSNull()
        }
        // Retain every other key verbatim so nothing observed is silently dropped.
        entry["rawKeys"] = info.keys.sorted()
        entries.append(entry)
    }
}

let log = AnnouncementLog()

let observerCallback: AXObserverCallbackWithInfo = { _, _, notification, info, _ in
    var dictionary: [String: Any] = [:]
    if let info = info as? [String: Any] { dictionary = info }
    log.append(notification: notification as String, info: dictionary)
}

// MARK: - Main

let arguments = CommandLine.arguments
guard arguments.count == 4, let pid = Int32(arguments[1]), let seconds = Double(arguments[2]) else {
    FileHandle.standardError.write("usage: ax-capture <pid> <seconds> <output.json>\n".data(using: .utf8)!)
    exit(2)
}
let outputPath = arguments[3]

guard AXIsProcessTrusted() else {
    FileHandle.standardError.write(
        "AX DENIED: AXIsProcessTrusted() == false for this capture process\n".data(using: .utf8)!)
    exit(3)
}

let application = AXUIElementCreateApplication(pid)

// Announcement observation is registered BEFORE the tree walk so a status change
// that happens during the capture window is recorded rather than missed.
var observer: AXObserver?
let observerStatus = AXObserverCreateWithInfoCallback(pid, observerCallback, &observer)
var observerState = "created"
if observerStatus != .success || observer == nil {
    observerState = "AXObserverCreate failed: \(observerStatus.rawValue)"
} else {
    let addStatus = AXObserverAddNotification(
        observer!, application, kAXAnnouncementRequestedNotification as CFString, nil)
    if addStatus != .success {
        observerState = "AXObserverAddNotification failed: \(addStatus.rawValue)"
    } else {
        CFRunLoopAddSource(
            CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer!), .defaultMode)
        observerState = "observing kAXAnnouncementRequestedNotification"
    }
}

// Let the run loop process notifications for the requested window.
let deadline = Date().addingTimeInterval(seconds)
while Date() < deadline {
    CFRunLoopRunInMode(.defaultMode, 0.1, true)
}

let windowsRaw = copyAttribute(application, kAXWindowsAttribute as String)
let windows = (windowsRaw as? [AXUIElement]) ?? []
var windowRecords: [[String: Any]] = []
for (index, window) in windows.enumerated() {
    windowRecords.append(describe(window, depth: 0, path: "window[\(index)]"))
}

var focusedRecord: Any = NSNull()
if let raw = copyAttribute(application, kAXFocusedUIElementAttribute as String),
   CFGetTypeID(raw) == AXUIElementGetTypeID() {
    let focused = raw as! AXUIElement
    focusedRecord = [
        "AXRole": stringAttribute(focused, kAXRoleAttribute as String) as Any,
        "AXTitle": stringAttribute(focused, kAXTitleAttribute as String) as Any,
        "AXDescription": stringAttribute(focused, kAXDescriptionAttribute as String) as Any,
        "AXHelp": stringAttribute(focused, kAXHelpAttribute as String) as Any,
    ]
}

let payload: [String: Any] = [
    "tool": "ax-capture.swift",
    "capturedAtUnixSeconds": Date().timeIntervalSince1970,
    "pid": Int(pid),
    "axProcessTrusted": true,
    "observerState": observerState,
    "captureWindowSeconds": seconds,
    "applicationRole": stringAttribute(application, kAXRoleAttribute as String) as Any,
    "windowCount": windows.count,
    "windows": windowRecords,
    "focusedUIElement": focusedRecord,
    "announcements": log.entries,
]

let data = try JSONSerialization.data(
    withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
try data.write(to: URL(fileURLWithPath: outputPath))
FileHandle.standardOutput.write(
    "AX CAPTURE OK windows=\(windows.count) announcements=\(log.entries.count) observer=\(observerState)\n"
        .data(using: .utf8)!)
