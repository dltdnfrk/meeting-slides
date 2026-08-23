import CoreGraphics
import Foundation

let targetPID = Int(CommandLine.arguments[1])!
let output = CommandLine.arguments[2]
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let rows = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []).map { info -> [String: Any] in
    let bounds = info[kCGWindowBounds as String] as? [String: Any] ?? [:]
    return [
        "windowNumber": info[kCGWindowNumber as String] ?? 0,
        "ownerPID": info[kCGWindowOwnerPID as String] ?? 0,
        "ownerName": info[kCGWindowOwnerName as String] ?? "",
        "name": info[kCGWindowName as String] ?? "",
        "layer": info[kCGWindowLayer as String] ?? 0,
        "alpha": info[kCGWindowAlpha as String] ?? 0,
        "onScreen": info[kCGWindowIsOnscreen as String] ?? false,
        "bounds": bounds,
    ]
}
let target = rows.filter { ($0["ownerPID"] as? Int) == targetPID }
let payload: [String: Any] = [
    "observer": "CGWindowListCopyWindowInfo(.optionOnScreenOnly)",
    "targetPID": targetPID,
    "targetWindows": target,
    "targetWindowCount": target.count,
    "ownerInventory": rows,
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
try data.write(to: URL(fileURLWithPath: output))
