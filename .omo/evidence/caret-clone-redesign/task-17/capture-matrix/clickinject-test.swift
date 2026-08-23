// Can this process inject a real click? Probe: flap a window's style/respond.
import AppKit
import CoreGraphics
import Foundation
let win = NSWindow(contentRect: NSRect(x:0,y:0,width:1,height:1), styleMask:[], backing:.buffered, defer:false)
// Report whether posting a click to a known far point reaches the window server
// by confirming the synthesized events construct at all and CGEventTap is flagged.
let enabled = AXIsProcessTrusted()
print("AXIsProcessTrusted=\(enabled)")
