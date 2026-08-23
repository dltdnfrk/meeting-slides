// Does the status item keep the app live and reachable in the window menu list?
// A borderless runloop app with LSUIElement=false owns its windows; the status
// item itself is not an AXButton without Accessibility permission, so observe
// that the process is running with a minibar panel and a Dock presence.
import Foundation
import CoreGraphics
import AppKit

let appPid = Int32(CommandLine.arguments.dropFirst().first ?? "-1")!
let running = NSRunningApplication(processIdentifier: appPid)
print("{")
print("  \"pid\": \(appPid),")
print("  \"isTerminated\": \(running == nil ? true : running!.isTerminated),")
print("  \"activationPolicy\": \(running.map { $0.activationPolicy.rawValue } ?? -1),") // 0 = regular (Dock tile)
print("  \"isHidden\": \(running?.isHidden ?? false)")
print("}")
