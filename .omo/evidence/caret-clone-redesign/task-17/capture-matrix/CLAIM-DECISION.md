# Todo 17 screen-capture claim decision

## Exact automated results (public APIs only, this machine)

Host: macOS 26.5.2 (Build 25F84), arm64 single internal display.

Single-window leg (`SCScreenshotManager` + `SCContentFilter(desktopIndependentWindow:)`),
measured twice in alternating order, identical both passes:

| Configuration     | CGWindowList enumerates | SCK `SCShareableContent` offers | Pixels               |
| ----------------- | ----------------------- | ------------------------------- | -------------------- |
| default readOnly  | yes                     | yes                             | readable (360x56)    |
| `.none`           | yes                     | yes                             | black (not readable) |
| readOnly restored | yes                     | yes                             | readable (360x56)    |
| `.none` re-applied| yes                     | yes                             | black (not readable) |

Real, running rebuilt app (pid 92036): the collapsed minibar (windowID from
the live process) is offered by `SCShareableContent`, and a
`desktopIndependentWindow` capture returned a readable 360x56 image
(134/136 sampled subpixels lit). The shipped app sets no `sharingType`.

Full-display leg (`SCContentFilter(display:excludingWindows:[])`, the panel's
own screen, valid coordinates): the panel was **not** captured even at the
default sharing type — the control (`legValid`) was false in every pass, so
this leg produced **no verdict**. `screencapture(1)` hard-failed
(`could not create image from rect`) from this launch context.

## Decision: claim "unsupported / unobservable here", ship no claim

1. `NSWindow.sharingType = .none` **works** for single-window SCK capture on
   this build — but the window **remains enumerated** under both
   `CGWindowListCopyWindowInfo` and `SCShareableContent`, so any capture UI
   still lists it by name.
2. The display-capture leg — what actually matters for screen sharing — could
   not be validated from this context, so there is **no evidence** the panel
   would or would not appear in a shared screen, and **no evidence** `.none`
   would help there.
3. Todo 14's interactive `screencapture` run already proved the shipped panel
   **is** visible in an interactive full-screen capture.

The product (source, UI, README) therefore claims **nothing** about screen-share
visibility and uses **no** exclusion API. Verified: no `sharingType`,
`ScreenCaptureKit`, or `NSWindowSharing*` in `macos/*.swift`; no
exclusion/claim string in `README.md`/`public/`.

## Drift to reconcile (owned by Todo 18, surfaced here)

`DESIGN.md:196` and `DESIGN.md:546` state `NSWindow.SharingType.none` is a
"legacy constant macOS no longer honors". That is **not** true for
single-window capture on macOS 26.5.2 (see matrix above). Both lines' actual
resolution — "no surface may claim the minibar is hidden; state only what the
matrix proves" — remains correct, but the rationale sentence is stale and
should be reworded when the docs task runs. No edit here: those files belong to
Todo 18.
