// Does sharingType = .none also remove the window from a FULL-DISPLAY capture?
// The single-window leg is not enough: screen sharing captures a display.
// Uses SCScreenshotManager with a display filter, the public API a modern
// screen-share tool uses. Prints one JSON document.
import AppKit
import Foundation
import ScreenCaptureKit

let probeTitle = "MeetingSlidesDisplayCaptureProbe"

final class ProbePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

let marker = NSColor(calibratedRed: 0.05, green: 0.85, blue: 0.45, alpha: 1)
let panel = ProbePanel(
    contentRect: NSRect(x: 300, y: 300, width: 360, height: 56),
    styleMask: [.borderless, .nonactivatingPanel],
    backing: .buffered, defer: false
)
panel.title = probeTitle
panel.isFloatingPanel = true
panel.level = .floating
panel.isOpaque = true
panel.backgroundColor = marker
panel.orderFrontRegardless()

func settle(_ t: NSWindow.SharingType) {
    panel.sharingType = t
    panel.displayIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.4))
}

func displayCapture(_ label: String, _ t: NSWindow.SharingType) async -> [String: Any] {
    await MainActor.run { settle(t) }
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { return ["configuration": label, "error": "no display"] }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
        config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let bitmap = NSBitmapImageRep(cgImage: image)
        // The display capture is in the display's own coordinate space with a
        // top-left origin. SCK reports that frame, so derive the sample point
        // from SCDisplay/SCWindow rather than guessing an NSScreen mapping.
        guard let scWindow = content.windows.first(where: { $0.title == probeTitle }) else {
            return ["configuration": label, "error": "probe window not offered by SCK"]
        }
        let bounds = display.frame
        let scaleX = Double(bitmap.pixelsWide) / bounds.width
        let scaleY = Double(bitmap.pixelsHigh) / bounds.height
        let px = Int((scWindow.frame.midX - bounds.minX) * scaleX)
        let py = Int((scWindow.frame.midY - bounds.minY) * scaleY)
        guard px >= 0, py >= 0, px < bitmap.pixelsWide, py < bitmap.pixelsHigh,
              let sample = bitmap.colorAt(x: px, y: py)?.usingColorSpace(.deviceRGB) else {
            return ["configuration": label, "error": "no pixel at \(px),\(py) in \(bitmap.pixelsWide)x\(bitmap.pixelsHigh)"]
        }
        // Save the frame so the leg is auditable rather than a bare boolean.
        if let png = NSBitmapImageRep(cgImage: image)
            .representation(using: .png, properties: [:]) {
            let safe = label.replacingOccurrences(of: " ", with: "-")
                .replacingOccurrences(of: "(", with: "")
                .replacingOccurrences(of: ")", with: "")
            try? png.write(to: URL(fileURLWithPath: "display-\(safe).png"))
        }
        let greenDominant = sample.greenComponent > sample.redComponent + 0.15
            && sample.greenComponent > sample.blueComponent + 0.15
        // Control: if the panel is not present even at the DEFAULT sharing type,
        // this display capture is not showing this process's windows at all and
        // the leg says nothing about exclusion. It must be reported as such.
        return [
            "legValid": t != .readOnly || greenDominant,
            "scWindowFrame": "\(scWindow.frame)",
            "displayFrame": "\(bounds)",
            "configuration": label,
            "sharingType": t == .none ? "NSWindowSharingType.none" : "NSWindowSharingType.readOnly",
            "displayImage": "\(bitmap.pixelsWide)x\(bitmap.pixelsHigh)",
            "sampledAt": "\(px),\(py)",
            "sampledRGB": String(format: "%.3f,%.3f,%.3f", sample.redComponent, sample.greenComponent, sample.blueComponent),
            "panelVisibleInDisplayCapture": greenDominant,
        ]
    } catch {
        return ["configuration": label, "error": "INCONCLUSIVE: \(error)"]
    }
}

var rows: [[String: Any]] = []
let sem = DispatchSemaphore(value: 0)
Task {
    rows.append(await displayCapture("default (no exclusion API used)", .readOnly))
    rows.append(await displayCapture("self-exclusion attempt", .none))
    rows.append(await displayCapture("default restored after exclusion", .readOnly))
    sem.signal()
}
while sem.wait(timeout: .now() + 0.05) == .timedOut {
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
}
let doc: [String: Any] = [
    "probe": "full-display-capture-leg",
    "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
    "api": "SCScreenshotManager + SCContentFilter(display:excludingWindows:[])",
    "results": rows,
]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted, .sortedKeys]))
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
exit(0)
