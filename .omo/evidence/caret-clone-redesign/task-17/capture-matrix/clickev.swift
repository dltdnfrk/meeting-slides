// Synthesize a real left click through the window server. Usage: cliickev X Y
import CoreGraphics
import Foundation
let x = Double(CommandLine.arguments[1])!, y = Double(CommandLine.arguments[2])!
let p = CGPoint(x: x, y: y)
let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)
let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)
down?.post(tap: .cghidEventTap)
up?.post(tap: .cghidEventTap)
print("click posted at \(Int(x)),\(Int(y))")
