// Observe the REAL running minibar through public CGWindowList APIs.
// Answers the Todo-17 manual QA questions without Accessibility permission:
// (a) the menu-bar/status item and NSPanel are live on screen with real bounds;
// (b) are its pixels visible to a public single-window ScreenCaptureKit capture.
import Foundation
import CoreGraphics
import ScreenCaptureKit

let pid = ProcessInfo.processInfo // unused
enum ProbeError: Error { case missing(String) }

let list = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
) as? [[String: Any]] ?? []

// The launcher owns the menu-bar item and the panel. Find its windows.
let appPid = Int32(CommandLine.arguments.dropFirst().first ?? "-1")
var panelInfo: (id: CGWindowID, bounds: CGRect, layer: Int, title: String)? = nil
for entry in list {
    guard (entry[kCGWindowOwnerPID as String] as? Int32) == appPid else { continue }
    let b = (entry[kCGWindowBounds as String] as? NSDictionary) ?? [:]
    let rect = CGRect(x: b["X"] as? Double ?? 0, y: b["Y"] as? Double ?? 0,
                      width: b["Width"] as? Double ?? 0, height: b["Height"] as? Double ?? 0)
    let layer = entry[kCGWindowLayer as String] as? Int ?? -1
    let wid = entry[kCGWindowNumber as String] as? CGWindowID ?? 0
    let name = entry[kCGWindowName as String] as? String ?? ""
    // The 360x56 (collapsed) minibar panel.
    if Int(rect.width) == 360 && Int(rect.height) == 56 {
        panelInfo = (wid, rect, layer, name)
    }
}

guard let panel = panelInfo else {
    print(#"{"error":"no 360x56 minibar panel found for pid \#(appPid)}"#)
    exit(1)
}

// Pixel visibility through the only public single-window capture path.
var pixelVerdict: [String: Any] = ["inconclusive": true]
let sem = DispatchSemaphore(value: 0)
Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        if let win = content.windows.first(where: { $0.windowID == panel.id }) {
            let filter = SCContentFilter(desktopIndependentWindow: win)
            let cfg = SCStreamConfiguration()
            cfg.width = Int(win.frame.width); cfg.height = Int(win.frame.height); cfg.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
            let bmp = NSBitmapImageRep(cgImage: image)
            // Sample a grid and report how many pixels are opaque/non-black.
            var sampled = 0, lit = 0
            for fy in stride(from: 2, to: bmp.pixelsHigh - 2, by: max(1, bmp.pixelsHigh/8)) {
                for fx in stride(from: 2, to: bmp.pixelsWide - 2, by: max(1, bmp.pixelsWide/16)) {
                    if let c = bmp.colorAt(x: fx, y: fy)?.usingColorSpace(.deviceRGB) {
                        sampled += 1
                        if c.redComponent + c.greenComponent + c.blueComponent > 0.15 { lit += 1 }
                    }
                }
            }
            pixelVerdict = [
                "inconclusive": false,
                "offeredByScreenCaptureKit": true,
                "capturedImage": "\(bmp.pixelsWide)x\(bmp.pixelsHigh)",
                "litSampledPixels": "\(lit) of \(sampled)",
                "pixelsReadable": lit > sampled / 3,
            ]
        } else {
            pixelVerdict = ["inconclusive": true,
                            "offeredByScreenCaptureKit": false,
                            "note": "window not in SCK shareable content"]
        }
    } catch {
        pixelVerdict = ["inconclusive": true, "error": "\(error)"]
    }
    sem.signal()
}
sem.wait()

let doc: [String: Any] = [
    "observedPid": appPid,
    "panel": [
        "windowID": Int(panel.id),
        "boundsTopLeft": ["x": Int(panel.bounds.minX), "y": Int(panel.bounds.minY)],
        "size": ["width": Int(panel.bounds.width), "height": Int(panel.bounds.height)],
        "layer": panel.layer,
    ],
    "singleWindowCapture": pixelVerdict,
]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted, .sortedKeys]))
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
