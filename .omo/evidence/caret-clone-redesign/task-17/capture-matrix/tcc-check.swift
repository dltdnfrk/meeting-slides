// Is this process actually permitted to capture the screen? SCK reports
// redacted/limited content instead of failing when the grant is missing.
import Foundation
import CoreGraphics
import ScreenCaptureKit

let preflight = CGPreflightScreenCaptureAccess()
let sem = DispatchSemaphore(value: 0)
var windowCount = -1
var appCount = -1
var titledCount = -1
var err: String? = nil
Task {
    do {
        let c = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        windowCount = c.windows.count
        appCount = c.applications.count
        titledCount = c.windows.filter { ($0.title ?? "").isEmpty == false }.count
    } catch { err = "\(error)" }
    sem.signal()
}
sem.wait()
let doc: [String: Any] = [
    "CGPreflightScreenCaptureAccess": preflight,
    "sckWindowCount": windowCount,
    "sckApplicationCount": appCount,
    "sckWindowsWithTitle": titledCount,
    "sckError": err ?? NSNull(),
    "note": "Without a Screen Recording grant, SCK returns redacted content: windows are enumerated but titles and pixels of other processes are withheld.",
]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted, .sortedKeys]))
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
