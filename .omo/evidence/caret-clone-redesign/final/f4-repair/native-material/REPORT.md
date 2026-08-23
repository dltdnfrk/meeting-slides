# F4 M1 native material repair

**Terminal verdict: BLOCKED (installed visual closure missing)**

## Product repair

`MinibarView` now uses a real AppKit `NSVisualEffectView` with active `.hudWindow` / `.behindWindow` material, a fixed vibrant-dark appearance for readable semantic label colors, a 16pt clipped corner, 1pt ambient stroke, and a restrained dark raised transcript layer. The opaque `NSColor.windowBackgroundColor` draw path is removed. The panel remains clear/non-opaque with its native shadow. No projection, controls, protocol, presentation, persistence, or geometry logic changed.

## RED / GREEN

- RED: `red/native-material-red.txt` — the added machine-consumed native material contract failed against the former opaque `NSView` implementation (56 pass, 1 fail).
- GREEN: `green/01-native-minibar.txt` — 57 pass, 0 fail, including exact 360x56 / 560x220 geometry and the native HUD material assertions.
- Serial neighboring native suites: launcher 42/42; surface contract 34/34.
- Aggregate Swift typecheck: exit 0.
- Fresh installed app build, bundle verification, and strict codesign: exit 0.
- Installed executable SHA-256: `7847745f6d94512434c6ac41e3e3352e5c33825aa3c9f921fc8613d86b8e5281`.

## Installed QA outcome

The isolated installed-app runner reached the installed launcher and real WebSocket, but its temporary accessibility waiter was not trusted/usable for the newly compiled helper and later attempts reached the launcher before System Events exposed window 1. Per the convergence directive, no further harness edits or retries were made.

No screenshot file was successfully captured under `qa/screenshots/`. Therefore this receipt cannot directly demonstrate the screenshot-visible installed M1 closure, and a PASS would be false. In particular, fresh installed collapsed-idle, collapsed-live, and expanded material screenshots are missing. The prior F3 screenshots are rejected evidence of the old opaque implementation and were not reused as closure proof.

## Cleanup and preservation

Final inspection found no task app process and no listener on port 54831. The installed project marker points to the canonical root, minibar defaults were restored to the pre-QA 360x56 frame, the temporary project was removed, strict codesign passes, and `scripts/verify-app.sh` passes. No microphone, user database, external API, governance file, or F4 report was touched.

## Exact remaining blocker

Capture and personally inspect the freshly installed executable in collapsed-idle, collapsed-live, and expanded states, with exact bounds and AX receipts, showing that the dark layered native HUD material is visibly ambient and readable. Until those installed pixels exist, F4 M1 is not directly closed.
