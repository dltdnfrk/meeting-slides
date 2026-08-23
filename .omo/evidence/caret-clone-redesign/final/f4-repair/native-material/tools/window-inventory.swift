import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
let output = CommandLine.arguments[2]
let target = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).filter {
    ($0[kCGWindowOwnerPID as String] as? Int) == pid
}.map { row -> [String: Any] in
    ["windowNumber": row[kCGWindowNumber as String] ?? 0,
     "bounds": row[kCGWindowBounds as String] ?? [:],
     "alpha": row[kCGWindowAlpha as String] ?? 0,
     "onScreen": row[kCGWindowIsOnscreen as String] ?? false]
}
let data = try JSONSerialization.data(withJSONObject: ["observer":"CGWindowListCopyWindowInfo(.optionOnScreenOnly)","pid":pid,"targetWindows":target,"targetWindowCount":target.count], options:[.prettyPrinted,.sortedKeys])
try data.write(to: URL(fileURLWithPath: output))
