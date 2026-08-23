# Task 14 — Implement native macOS minibar projection

Plan: `.omo/plans/caret-clone-redesign.md` (Wave 3, Todo 14)
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides` (git toplevel confirmed)
Baseline HEAD: `a1ed25f95980980cd958044b90e739ac45e8280d` (branch `main`, no commit made)
Depends on: Todos 3, 5, 7, 8, 9, 10 — all present and preserved.

## What was delivered

| Path | Role |
| --- | --- |
| `macos/MinibarProjection.swift` (new) | Pure projection: explicit status (`connecting/idle/starting/live/stopping/switching-model/reconnecting/error`), non-color glyph + distinct Korean title per state, timer from server `startedAt` only, bounded transcript viewport (≤3 finalized + 1 provisional), closed control vocabulary, activation/window/motion/accessibility policy. Foundation only, `now` injected. |
| `macos/MinibarWindowController.swift` (new) | Thin AppKit shell: one borderless, floating, non-activating `NSPanel` + menu-bar `NSStatusItem`, real `URLSessionWebSocketTask`, per-display frame memory. Geometry via `NativeSurfaceGeometry.resolveFrame`; every rendered decision comes from the pure module. |
| `macos/MinibarView.swift` (new) | Content view. Draws a `MinibarViewModel` and forwards control activations. No status inference, no timer arithmetic, no transcript trimming, no geometry. |
| `macos/launcher.swift` (minimal wiring) | Hosts the minibar on an AppKit run loop, moves the server watch to a background thread, adds quit-while-capturing confirmation. Todo-10 lifecycle decisions and effects are unchanged. |
| `scripts/build-app.sh` (compile line) | The single `swiftc` invocation now includes the contract, transport and three minibar sources. One executable, no second binary. |
| `tests/fixtures/native-minibar-driver.swift` (new) | Headless deterministic driver: scenario batch on stdin, one JSON document on stdout, typed failures instead of crashes. |
| `tests/native-minibar.test.ts` (new) | 47 tests. Compiles the pure seam + driver with `swiftc` once, typechecks the AppKit shell separately, runs the driver once, asserts on the parsed result. |
| `tests/native-surface-contract.test.ts`, `tests/native-launcher-boundary.test.ts` (1 test each) | Todo-5/10 staging assertions ("minibar modules are not wired into the bundle yet") replaced by the invariant that survives: exactly one `swiftc -O -o` invocation, one executable, no `-framework WebKit`. |

`macos/NativeSurfaceContract.swift`, `macos/AppLifecycle.swift` and `macos/TransportClient.swift`
are **byte-identical** to their Todo-5/10 DoneClaim hashes. The minibar reuses their geometry,
decoder, `StopCommandGuard` and connection state machine rather than duplicating them.

## Boundaries this task enforces

- **Ambient control, never a workspace.** Collapsed 360x56 shows status glyph + title + one
  latest/provisional line + timer + persistent Stop + disclosure. Expanded 560x220 adds at most
  three finalized lines and Open Workspace. No slides, no meeting library, no persistence.
- **One source of truth.** The existing Bun session owns everything. The minibar holds a bounded
  3-row viewport that an authoritative idle snapshot clears; it is a viewport, not a store.
- **Truthful status.** Eight explicit states, each with its own glyph and title. Status is never
  color-only. A dead socket becomes `reconnecting` and retains the known capture phase, timer
  basis and lines — never a phantom stop.
- **Timer from the server.** `MinibarTimer.text(startedAt:now:)` is the only clock; there is no
  native stopwatch, and a capture without `startedAt` shows no timer at all.
- **One Stop.** The only outbound frame is the existing `{"action":"stopCapture"}`, guarded by
  Todo-10's `StopCommandGuard`. Five real clicks produced exactly one frame on the wire.
- **No fake capability.** The control vocabulary is closed to `stop`, `disclosure`,
  `openWorkspace`. No Pause, no share, no screen-share exclusion claim.

## Receipts

### baseline/
- `00-boundary.txt` — canonical root, git toplevel/branch/HEAD, pre-work `git status --short`, toolchain versions.
- `01-protected-hashes.txt` — SHA-256 of every pre-existing dirty path and of the installed app, before any write.

### red/ (failing-first proof)
- `01-red-missing-seam.txt` — **46 fail / 0 pass**, exit 1, before any implementation existed.
- `02-mutation-phantom-stop.txt` — reconnecting reports `idle` instead of retaining capture truth → 2 targeted failures.
- `03-mutation-unbounded-transcript.txt` — the 3-row cap removed → exactly the "at most three finalized lines" test goes RED.
- `04-mutation-stop-lies-while-offline.txt` — Stop advertised as enabled while reconnecting → exactly the truthful-Stop test goes RED.
- `05-mutation-automatic-focus-steal.txt` — automatic capture takes OS focus → exactly the no-focus-steal test goes RED.
- `06-mutation-invented-timer.txt` — timer invented when the server gives no `startedAt` → exactly the no-invented-timer test goes RED.
- `07-mutation-duplicate-stop.txt` — duplicate-Stop guard bypassed → 4 targeted failures across the minibar and Todo-10 suites.

Every mutation was reverted from a byte-identical backup (hash equality shown in each file).
`macos/TransportClient.swift` was restored to its exact Todo-10 hash `110f12cf…`.

### green/
- `01-green-focused.txt` — 119 pass / 0 fail across the three native suites (pre-QA-fix run).
- `02-swiftc-typecheck.txt` — full native surface and pure-seam-only typechecks, both exit 0.
- `03-typecheck-ts.txt` — `tsc --strict --noEmit` on the new test file, exit 0.
- `04-diff-check.txt` — `git diff --check`, exit 0.
- `05-full-bun-test.txt` — full `bun test`: 640 pass / 64 fail / 4 errors, single run.
- `06-failure-attribution.txt` — the 64 failures belong to Puppeteer-browser, LLM-transport, PPTX,
  attendees and server-dispatch suites. Only three suites read this task's files
  (`native-minibar`, `native-surface-contract`, `native-launcher-boundary`) and all three are green.
- `07-protected-integrity.txt` — 22 of 25 protected paths byte-identical. The 3 changed
  (`public/app.js`, `public/index.html`, `public/operator-surface.js`) were modified by concurrent
  sibling work at 17:58–18:04, before this task's native work, and were never opened here.
- `08-green-final.txt` — **120 pass / 0 fail** after the QA-driven fixes, typecheck exit 0, `git diff --check` exit 0.

### manual/ (real native QA against a temporary app bundle)
A temporary bundle was built into a temp install dir and driven against a deterministic local
fixture server (health signature + scripted `capture`/`line`/`caption`/malformed steps on port 8899),
with `startedAt` pinned 65s in the past. The canonical installed app was never rebuilt.

- `00-build-temp-app.txt` — `scripts/build-app.sh` into a temp dir: swiftc, plutil, codesign
  `--force --deep`, `codesign --verify --deep --strict`, WebKit-linkage rejection, exit 0.
- `01-symlink-and-bundle.txt` — the known Todo-10 side effect (the build repoints the repo
  symlink) detected and restored in the same turn; canonical installed app byte-identical.
- `02-collapsed-bounds-ax.txt` — real panel **360x56 at AX (1136, 856)**, description
  `Meeting Slides 미니바`, role `AXWindow`. Independently recomputed from the real display
  (`visible=(0,54,1512,895)`): expected exactly 1136, 856 — a 16px gutter on both axes, 0px error.
- `03-capture-sequence.txt` — starting → capturing → line → caption, panel stays 360x56.
  AX static text: `●`, `녹음 중`, `지금 말하는 중…`, `03:51`. Buttons: `녹음 중지`, `미니바 펼치기`, both enabled.
- `04-expanded.txt` — disclosure → **560x220**, adds `작업 공간 열기`, shows 3 finalized lines with
  speaker labels; a 4th line evicts the oldest and the caption is replaced by its finalized line.
- `05-stop-once.txt` — **5 rapid real clicks on Stop → exactly one `{"action":"stopCapture"}`**
  received by the server; the panel then followed the server to `○ 대기 중` with Stop disabled.
- `06-reconnect.txt`, `06b-reconnecting-window.txt` — socket dropped mid-capture: the panel shows
  `↻ 연결 끊김 — 재연결 중` while **retaining** the timer (04:47) and the known transcript line, then the
  authoritative snapshot restores `● 녹음 중`. No phantom stop.
- `07-bad-payload.txt` — truncated JSON and a badly typed `line` both surface `! 오류` while keeping
  the last known line and timer; process alive; the next authoritative snapshot recovers.
- `08-offdisplay.txt` — saved frame poisoned to (90000, 90000): on relaunch the panel falls back to
  the deterministic default 1136, 856, 360x56.
- `09-screencapture-compat.txt` — **exact compatibility result: the minibar IS captured by
  `screencapture`, a public capture API.** No exclusion API is used and none is claimed anywhere in
  the UI, source or docs. `rg` over `macos/*.swift` finds no `sharingType`/screen-share string.
- `10-quit-while-capturing.txt` — quitting while capturing raises a `경고` / `AXDialog` with
  `계속 녹음` / `종료`; the AppleEvent times out because the modal blocks, the process stays alive,
  and refusing keeps the capture intact. Quitting while idle exits cleanly with no confirmation.
- `11-escape-openworkspace.txt` — Escape collapses 560x220 → 360x56 with the stopCapture frame count
  unchanged and the capture still live; Open Workspace opens the browser; binary has 0 WebKit references.
- `12-cleanup.txt` — temp bundle, temp project, fixture server, defaults and helper files all removed;
  no listener on 8899, no orphan process; canonical installed app and repo symlink byte-identical to baseline.
- `13-artifact-index.txt` — SHA-256 of every evidence artifact and every deliverable.
- `screenshots/01-collapsed-live.png` (720x112 @2x), `screenshots/02-expanded-live.png` (1120x440 @2x) —
  fresh captures of the real panel in both modes.

## Two real defects found by native QA (not by the automated seam)

1. **Collapsed panel was 360x88, not 360x56.** Auto Layout content (a 44pt control row stacked under
   the header) grew the window past the contract. Fixed by making the frame authoritative
   (`contentMinSize`/`contentMaxSize` pinned to the contract size) and by moving the collapsed
   single line inline into the one 44pt header row. A regression test now pins both.
2. **`cancelOperation` was declared on the controller**, which is not a responder, so Escape would
   never have fired. Moved onto `MinibarPanel`, which forwards to the pure `MinibarMode` rule.

Both were caught only because the panel was measured with `osascript` on a real display.
