import AppKit
import Foundation

// Minimal AppKit app that posts exactly ONE announcementRequested, so an
// external AXObserver can be tested for delivery independently of the product.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 60),
                      styleMask: [.titled], backing: .buffered, defer: false)
let label = NSTextField(labelWithString: "probe")
window.contentView?.addSubview(label)
window.setAccessibilityLabel("axpost probe window")
window.orderFrontRegardless()
print("PID \(ProcessInfo.processInfo.processIdentifier)")
fflush(stdout)
DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
    NSAccessibility.post(element: label, notification: .announcementRequested,
                         userInfo: [.announcement: "probe announcement",
                                    .priority: NSAccessibilityPriorityLevel.medium.rawValue])
    print("POSTED")
    fflush(stdout)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 8) { exit(0) }
app.run()
