# Public-API screen-capture behavior matrix (Todo 17)

Automated local matrix run on this machine. Nothing here is a product claim; it
is the observed behavior of public macOS APIs against a window configured
exactly like the Meeting Slides minibar (borderless, non-activating, floating
`NSPanel`, 360x56).

- Host: macOS `Version 26.5.2 (Build 25F84)`, Apple M5 Pro, single built-in display.
- Probes: `capture-matrix.swift` (single-window legs), `display-capture-leg.swift`
  (full-display leg), `tcc-check.swift` (capture-permission context).
- Raw results: `01-matrix-raw.json`, `02-display-leg.json`, `03-tcc-status.json`.

## Documented API facts (Apple SDK 26.5 headers, the shipped authority)

- `NSWindow.sharingType` is **not deprecated**. `AppKit/NSWindow.h` documents
  `NSWindowSharingNone` as "Window contents may not be read by another process"
  and warns the window "will also not be able to participate in a number of
  system services". Only `NSWindowSharingReadWrite` is deprecated (macOS 15.0).
- `CGWindowListCreateImage` was **obsoleted in macOS 15.0** ("Please use
  ScreenCaptureKit instead"), so ScreenCaptureKit is the public pixel-capture path.
- ScreenCaptureKit exclusion is **capturer-side**:
  `SCContentFilter(display:excludingWindows:)` and the
  `excludingApplications:exceptingWindows:` variants live on the capturing
  process. A captured application has **no** public SCK API to force its own
  exclusion.

## Observed matrix

| Leg | API | default (`.readOnly`) | `sharingType = .none` |
| --- | --- | --- | --- |
| Window enumeration | `CGWindowListCopyWindowInfo` | enumerated | **still enumerated** |
| Capturer window list | `SCShareableContent` | offered | **still offered** |
| Single-window pixels | `SCScreenshotManager` + `SCContentFilter(desktopIndependentWindow:)` | **readable** (360x56, green marker present, luminance 0.639) | **not readable** (black frame) |
| Full-display pixels | `SCScreenshotManager` + `SCContentFilter(display:excludingWindows:[])` | **INCONCLUSIVE** | **INCONCLUSIVE** |
| `screencapture(1)` | shipped capture tool | **INCONCLUSIVE** (exit 1) | **INCONCLUSIVE** (exit 1) |

Each configuration was measured **twice in alternating order**
(`readOnly -> none -> readOnly -> none`) and the single-window result was
identical in both passes, so it is not an ordering or warm-up artifact.

### Why two legs are INCONCLUSIVE, not "excluded"

The full-display leg carries a `legValid` control: the panel must be visible at
the **default** sharing type for the leg to mean anything. It was **not**
(`legValid: false`), and `screencapture(1)` exits 1 in this context. Per
`03-tcc-status.json`, this process has `CGPreflightScreenCaptureAccess: true`
but SCK still offers only 5 applications / 15 windows - a restricted capture
view for this non-interactive context. Recording those legs as "not captured"
would be a false exclusion claim, so they are recorded as no-verdict.

Todo 14 `manual/09` separately observed, from an interactive context, that the
real minibar **is** captured by `screencapture`. That leg is not contradicted by
anything measured here: it tested a window that never set `sharingType`.

## Claim decision

**Ship no screen-share exclusion claim, and use no exclusion API.**

The one leg that produced a verdict shows `sharingType = .none` does suppress
single-window pixel capture on this macOS build. That is *not* sufficient to
promise a user their minibar is hidden during a meeting, because:

1. The window remains **enumerated** in both `CGWindowListCopyWindowInfo` and
   `SCShareableContent` under `.none`, so a screen-share picker still lists it.
2. The full-display leg - the case that actually matters for screen sharing -
   produced **no valid verdict** on this machine.
3. Apple's own header warns `.none` costs the window "a number of system
   services", an unpriced regression for an ambient control surface.
4. One machine, one macOS build, one capture stack is not a compatibility
   matrix, and conferencing apps capture through paths not measured here.

Therefore the product keeps the Todo 14 position unchanged: no `sharingType`
call in any shipped source, and no UI, README or DESIGN string that promises
screen-share invisibility. `tests/app-bundle.test.ts` pins both halves - the
bundle declares no `NSScreenCaptureUsageDescription`, and no `macos/*.swift`
source references `sharingType` or `ScreenCaptureKit`.
