# F3 native menu-toggle repair receipt

**Terminal verdict: PASS**

Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Fresh installed app: `/Users/hyunjun/Applications/Meeting Slides.app`  
Installed executable SHA-256: `23865fbdc70fcc0d7db65bc995b893854fff1e04ef939d29b513dabdb422538d`  
Bundle id: `com.meetingslides.app`

## Root cause and repair

The status-item action in `MinibarWindowController.statusItemActivated()` unconditionally called `present(origin: .user)`. That path only ordered the panel forward, so both direct menu-bar AXPress activations were show operations. This exactly explains the prior receipt's unchanged CGWindow id/bounds after both presses.

The repair adds controller-owned presentation truth (`hidden`/`visible`) to the pure native surface contract. Presentation events emit explicit `show`/`hide` effects. The AppKit controller applies `hide` with `panel.orderOut(nil)` and applies `show` through its existing focus-aware presentation path. It never consults `NSWindow.isVisible`, which can be stale for a nonactivating panel. Disclosure mode remains independent and is retained through hide/restore.

## TDD and automated verification

- RED: `tdd-red.txt` records the deterministic fixture failing because presentation state/effects did not exist and the shipping controller had no hide path.
- GREEN: `tdd-green.txt` records collapsed and expanded sequences as `show, hide, show`, with states `visible, hidden, visible` and unchanged mode.
- Serial native suites (`native-tests-serial.txt`):
  - native minibar: 56 pass, 0 fail;
  - native launcher: 42 pass, 0 fail;
  - native surface: 34 pass, 0 fail.
- Aggregate Swift typecheck: clean (`swift-aggregate-typecheck.txt`).
- Fresh app build: PASS (`build.txt`).
- Bundle verifier: PASS (`verify-app.txt`).
- Strict codesign: PASS (`codesign.txt`, `post-cleanup-codesign.txt`).

## Fresh installed-app manual QA

The exact freshly installed executable above was launched against an isolated healthy server adopted on port 54746. No microphone input, user database, or external API was used. Readiness used bounded FIFO and kqueue vnode notifications; there were no sleeps or polling. Every user action used direct System Events `AXPress`. Window truth came from one-shot `CGWindowListCopyWindowInfo(.optionOnScreenOnly)` inventories and fresh full-screen screenshots, not AX visibility or `NSWindow.isVisible`.

- Off-display restoration: seeded `9000,9000,360,56`; observed on-screen at `1136,854,360,56` (`windows/01-initial-off-display-restored.json`, screenshot 01).
- First menu press: AXPress succeeded and target on-screen window count became 0 (`windows/02-after-first-hide.json`, screenshot 02 visibly has no minibar).
- Second menu press: AXPress succeeded and window id `103634` returned on-screen at `1136,854,360,56` (`windows/03-after-second-restore.json`, screenshot 03 visibly shows the collapsed minibar).
- Disclosure: direct AXPress expanded the same window to `936,690,560,220` (`windows/04-expanded.json`, screenshot 04).
- Open Workspace: direct AXPress produced a new adopted-server GET with host `localhost:54746`.
- Stop-once: five direct AXPress activations produced exactly one `{"action":"stopCapture"}` client command; screenshot 05 visibly shows the live projection and Stop control.

`manual-summary.json` is the compact machine-readable verdict. I visually inspected screenshots 01-05; they agree with the CGWindow inventories and protocol receipt.

## Cleanup and preservation

`cleanup.json` records run exit 0, restored project marker, restored minibar defaults, freed port 54746, terminated only the task app/server, preserved the installed executable hash, removed the temporary project, and revalidated strict codesign. No plan, ledger, todo, F3 checkbox, F4 artifact, microphone data, or user database was edited.
