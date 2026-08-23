import ApplicationServices
import CoreGraphics
import Foundation

func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}
func string(_ element: AXUIElement, _ attribute: String) -> String? {
    copy(element, attribute) as? String
}
func bool(_ element: AXUIElement, _ attribute: String) -> Bool? {
    (copy(element, attribute) as? NSNumber)?.boolValue
}
func pair(_ element: AXUIElement, _ attribute: String, _ type: AXValueType) -> [String: Double]? {
    guard let raw = copy(element, attribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = raw as! AXValue
    if type == .cgPoint {
        var point = CGPoint.zero
        guard AXValueGetValue(value, type, &point) else { return nil }
        return ["x": point.x, "y": point.y]
    }
    var size = CGSize.zero
    guard AXValueGetValue(value, type, &size) else { return nil }
    return ["width": size.width, "height": size.height]
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    copy(element, kAXChildrenAttribute as String) as? [AXUIElement] ?? []
}
func flatten(_ element: AXUIElement, path: String, into rows: inout [[String: Any]]) {
    rows.append([
        "path": path,
        "role": string(element, kAXRoleAttribute as String) ?? NSNull(),
        "title": string(element, kAXTitleAttribute as String) ?? NSNull(),
        "description": string(element, kAXDescriptionAttribute as String) ?? NSNull(),
        "value": string(element, kAXValueAttribute as String) ?? NSNull(),
        "help": string(element, kAXHelpAttribute as String) ?? NSNull(),
        "enabled": bool(element, kAXEnabledAttribute as String) ?? NSNull(),
        "position": pair(element, kAXPositionAttribute as String, .cgPoint) ?? NSNull(),
        "size": pair(element, kAXSizeAttribute as String, .cgSize) ?? NSNull(),
    ])
    for (index, child) in children(element).enumerated() {
        flatten(child, path: "\(path)/\(index)", into: &rows)
    }
}

guard CommandLine.arguments.count == 3, let pid = Int32(CommandLine.arguments[1]), AXIsProcessTrusted() else { exit(2) }
let output = CommandLine.arguments[2]
let app = AXUIElementCreateApplication(pid)
let windows = copy(app, kAXWindowsAttribute as String) as? [AXUIElement] ?? []
var elements: [[String: Any]] = []
for (index, window) in windows.enumerated() { flatten(window, path: "window[\(index)]", into: &elements) }
let cgRows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).filter {
    ($0[kCGWindowOwnerPID as String] as? Int32) == pid
}.map { row -> [String: Any] in
    [
        "windowNumber": row[kCGWindowNumber as String] ?? 0,
        "bounds": row[kCGWindowBounds as String] ?? [:],
        "alpha": row[kCGWindowAlpha as String] ?? 0,
        "onScreen": row[kCGWindowIsOnscreen as String] ?? false,
    ]
}
let payload: [String: Any] = [
    "observer": "AXUIElement + CGWindowListCopyWindowInfo(.optionOnScreenOnly)",
    "pid": pid,
    "axTrusted": true,
    "windowCount": windows.count,
    "elements": elements,
    "cgWindows": cgRows,
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
try data.write(to: URL(fileURLWithPath: output))
