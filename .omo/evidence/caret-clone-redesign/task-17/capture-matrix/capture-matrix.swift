// Public-API screen-capture behavior matrix for the Meeting Slides minibar.
//
// This is an evidence probe, not shipped product code. It answers one question
// with observations instead of claims: using only public macOS APIs, can a
// window like the minibar keep itself out of a screen capture?
//
// It creates a real NSPanel configured exactly like the minibar (borderless,
// non-activating, floating), then measures three public capture surfaces:
//
//   1. CGWindowListCopyWindowInfo   — window enumeration (what a capturer sees)
//   2. ScreenCaptureKit             — SCShareableContent window enumeration
//   3. /usr/sbin/screencapture      — the shipped user-facing capture tool
//
// Each surface is measured twice: with the default sharingType (.readOnly) and
// with sharingType = .none, the only public self-exclusion API AppKit offers.
// Results are written as JSON. No claim is derived here; the DoneClaim reports
// exactly what this prints.
//
// Build:
//   swiftc -O -o capture-matrix capture-matrix.swift \
//     -framework AppKit -framework ScreenCaptureKit -framework CoreGraphics

import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

let probeTitle = "MeetingSlidesCaptureMatrixProbe"

// MARK: - Panel under test (minibar configuration)

final class ProbePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

let panel = ProbePanel(
    contentRect: NSRect(x: 200, y: 200, width: 360, height: 56),
    styleMask: [.borderless, .nonactivatingPanel],
    backing: .buffered,
    defer: false
)
panel.title = probeTitle
panel.isFloatingPanel = true
panel.level = .floating
panel.hidesOnDeactivate = false
panel.isOpaque = true
panel.backgroundColor = .windowBackgroundColor
panel.orderFrontRegardless()

// MARK: - Measurements

/// Is this process's probe window present in the CoreGraphics window list?
func visibleInCGWindowList() -> Bool {
    let pid = ProcessInfo.processInfo.processIdentifier
    guard let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] else { return false }
    return list.contains { entry in
        (entry[kCGWindowOwnerPID as String] as? Int32) == pid
            && (entry[kCGWindowName as String] as? String) == probeTitle
    }
}

/// Is the probe window offered to a ScreenCaptureKit capturer?
func visibleInScreenCaptureKit() async -> (visible: Bool, error: String?) {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(
            true, onScreenWindowsOnly: true
        )
        let pid = ProcessInfo.processInfo.processIdentifier
        let found = content.windows.contains { window in
            window.owningApplication?.processID == pid && window.title == probeTitle
        }
        return (found, nil)
    } catch {
        return (false, "\(error)")
    }
}

/// Can a capturer read this window's pixels through ScreenCaptureKit, the only
/// public pixel-capture path left? `CGWindowListCreateImage` was obsoleted in
/// macOS 15.0 ("Please use ScreenCaptureKit instead"), so this is the surface a
/// modern screen-share tool actually uses for single-window capture.
func pixelsReadableByScreenCaptureKit(marker: NSColor) async -> (readable: Bool, detail: String) {
    let pid = ProcessInfo.processInfo.processIdentifier
    let window: SCWindow
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(
            true, onScreenWindowsOnly: true
        )
        guard let found = content.windows.first(where: {
            $0.owningApplication?.processID == pid && $0.title == probeTitle
        }) else {
            return (false, "ScreenCaptureKit does not offer the probe window at all")
        }
        window = found
    } catch {
        return (false, "INCONCLUSIVE: SCShareableContent failed: \(error)")
    }

    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    configuration.width = Int(window.frame.width)
    configuration.height = Int(window.frame.height)
    configuration.showsCursor = false
    do {
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter, configuration: configuration
        )
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let sample = bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2)?
            .usingColorSpace(.deviceRGB),
            let expected = marker.usingColorSpace(.deviceRGB)
        else {
            return (false, "captured image had no readable pixel")
        }
        // The marker is a saturated green. Colour management shifts absolute
        // components, so the decisive question is whether the marker's signal
        // survives at all: a green-dominant, non-black pixel means the window's
        // content was captured; a black frame means it was suppressed.
        let luminance = (sample.redComponent + sample.greenComponent + sample.blueComponent) / 3
        let greenDominant = sample.greenComponent > sample.redComponent + 0.15
            && sample.greenComponent > sample.blueComponent + 0.15
        let readable = greenDominant && luminance > 0.05
        let detail = String(
            format: "SCScreenshotManager image %dx%d, center rgb(%.3f, %.3f, %.3f) "
                + "vs marker rgb(%.3f, %.3f, %.3f); luminance %.3f; greenDominant %@",
            bitmap.pixelsWide, bitmap.pixelsHigh,
            sample.redComponent, sample.greenComponent, sample.blueComponent,
            expected.redComponent, expected.greenComponent, expected.blueComponent,
            luminance, greenDominant ? "yes" : "no"
        )
        return (readable, detail)
    } catch {
        return (false, "INCONCLUSIVE: SCScreenshotManager.captureImage failed: \(error)")
    }
}

/// Does the probe window's pixel content appear in a screencapture(1) image?
/// The panel is filled with a known solid color; the capture is sampled inside
/// the panel's rect and compared against it.
func visibleInScreencapture(marker: NSColor) -> (visible: Bool, detail: String) {
    let temp = FileManager.default.temporaryDirectory
        .appendingPathComponent("capture-matrix-\(UUID().uuidString).png")
    let rect = panel.frame
    guard let screen = NSScreen.screens.first else { return (false, "no screen") }
    // screencapture -R uses top-left origin.
    let x = Int(rect.minX) + 8
    let y = Int(screen.frame.maxY - rect.maxY) + 8
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    task.arguments = ["-x", "-o", "-R", "\(x),\(y),16,16", temp.path]
    do {
        try task.run()
    } catch {
        return (false, "screencapture failed to launch: \(error)")
    }
    task.waitUntilExit()
    if task.terminationStatus != 0 {
        // screencapture(1) needs a Screen Recording grant for the invoking
        // process. Without it this leg yields no verdict at all; reporting it
        // as "not captured" would be a false exclusion claim.
        return (false, "INCONCLUSIVE: screencapture(1) exited \(task.terminationStatus) "
            + "(Screen Recording not granted to this probe process)")
    }
    guard let image = NSImage(contentsOf: temp),
          let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let sample = bitmap.colorAt(x: 4, y: 4)?
          .usingColorSpace(.deviceRGB),
          let expected = marker.usingColorSpace(.deviceRGB)
    else {
        return (false, "screencapture produced no comparable image (exit \(task.terminationStatus))")
    }
    try? FileManager.default.removeItem(at: temp)
    let distance = abs(sample.redComponent - expected.redComponent)
        + abs(sample.greenComponent - expected.greenComponent)
        + abs(sample.blueComponent - expected.blueComponent)
    let sampled = String(
        format: "sampled rgb(%.3f, %.3f, %.3f) vs marker rgb(%.3f, %.3f, %.3f)",
        sample.redComponent, sample.greenComponent, sample.blueComponent,
        expected.redComponent, expected.greenComponent, expected.blueComponent
    )
    return (distance < 0.12, sampled)
}

// MARK: - Run the matrix

let marker = NSColor(calibratedRed: 0.05, green: 0.85, blue: 0.45, alpha: 1)
panel.backgroundColor = marker
panel.displayIfNeeded()

/// Apply the configuration and let the window server publish it by turning the
/// main runloop, which is also what actually draws the panel.
func applyAndSettle(_ sharingType: NSWindow.SharingType) {
    panel.sharingType = sharingType
    panel.displayIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.35))
}

func measure(label: String, sharingType: NSWindow.SharingType) async -> [String: Any] {
    await MainActor.run { applyAndSettle(sharingType) }

    let cgVisible = visibleInCGWindowList()
    let sck = await visibleInScreenCaptureKit()
    let windowImage = await pixelsReadableByScreenCaptureKit(marker: marker)
    let shot = visibleInScreencapture(marker: marker)
    let inconclusive = shot.detail.hasPrefix("INCONCLUSIVE")
    let imageInconclusive = windowImage.detail.hasPrefix("INCONCLUSIVE")
    return [
        "configuration": label,
        "sharingType": sharingType == .none ? "NSWindowSharingType.none" : "NSWindowSharingType.readOnly",
        "cgWindowListEnumeratesWindow": cgVisible,
        "screenCaptureKitOffersWindow": sck.visible,
        "screenCaptureKitError": sck.error ?? NSNull(),
        "screenCaptureKitPixelsReadable": imageInconclusive ? NSNull() : windowImage.readable,
        "screenCaptureKitPixelDetail": windowImage.detail,
        "screencapturePixelsPresent": inconclusive ? NSNull() : shot.visible,
        "screencaptureDetail": shot.detail,
    ]
}

let semaphore = DispatchSemaphore(value: 0)
var rows: [[String: Any]] = []

Task {
    // Measured in both orders. If `.none` only ever looked suppressed because
    // it ran second, restoring `.readOnly` afterwards would stay suppressed too.
    rows.append(await measure(label: "default (no exclusion API used)", sharingType: .readOnly))
    rows.append(await measure(label: "self-exclusion attempt", sharingType: .none))
    rows.append(
        await measure(label: "default restored after exclusion", sharingType: .readOnly)
    )
    rows.append(await measure(label: "self-exclusion re-applied", sharingType: .none))
    semaphore.signal()
}

// The probe must terminate on its own; AppKit work happens on this runloop.
while semaphore.wait(timeout: .now() + 0.05) == .timedOut {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}

let document: [String: Any] = [
    "probe": "public-api-screen-capture-matrix",
    "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
    "window": [
        "styleMask": "borderless + nonactivatingPanel",
        "level": "floating",
        "size": "360x56",
    ],
    "surfaces": [
        "CGWindowListCopyWindowInfo": "public CoreGraphics window enumeration",
        "SCShareableContent": "public ScreenCaptureKit enumeration offered to capturers",
        "SCScreenshotManager": "public ScreenCaptureKit pixel capture (CGWindowListCreateImage was obsoleted in macOS 15.0)",
        "screencapture(1)": "shipped user-facing capture tool",
    ],
    "results": rows,
]
let data = try JSONSerialization.data(withJSONObject: document, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
exit(0)
