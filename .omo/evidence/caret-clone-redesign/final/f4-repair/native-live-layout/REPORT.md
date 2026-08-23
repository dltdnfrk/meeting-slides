# F4 M1R native live projection and balanced layout repair

**Terminal verdict: PASS**

Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Installed app: `/Users/hyunjun/Applications/Meeting Slides.app`  
Installed executable SHA-256: `915e570684a24f3f57b4ed7b3bd7b116ebc651ef8392e57e22184e76de2b40b5`

## Root cause and repair

The collapsed-live rejection was not a product projection/state-wiring defect. The authoritative capture frame already projected `녹음 중`, server-derived timer/latest caption, enabled `녹음 중지`, enabled disclosure, and truthful AX help. The prior screenshot was taken before those already-observed semantics reached a composited frame. The new deterministic render-contract test proves this exact projection together.

The expanded layout was a product defect: intrinsic `NSStackView` sizing packed the header and transcript against the right edge. The smallest product repair adds one pure `560x220` layout contract and makes `MinibarView` consume it: a `176x196` status/Stop region on the left and a `348x140` transcript plus `348x48` action region on the right, all within the existing 12pt content bounds. No capability, fake content, protocol, or geometry was added or changed.

## TDD and verification

- RED: `red/01-native-minibar-red.txt` records the new deterministic expanded-layout contract failing because `MinibarLayout` did not exist.
- GREEN, serial:
  - native minibar: 59/59 tests, 216 expectations;
  - native launcher: 42/42 tests, 92 expectations;
  - native surface: 34/34 tests, 77 expectations;
  - full Swift shell typecheck: exit 0;
  - app build, artifact verification, and strict deep codesign: exit 0.
- Exact installed executable identity and changed-source identities are in `green/08-artifact-identity.txt`.

## Installed isolated QA

The installed executable adopted an isolated localhost server on port 54832. No microphone input, user database, or external API was used. State changes were synchronized to AX state and subsequent display-link frames; there were no sleeps or polling delays.

I personally inspected the direct panel and display screenshots:

- `02-collapsed-live.panel.png` visibly shows `녹음 중`, `02:05`, the current caption prefix, enabled red Stop, and disclosure at exact `360x56`. Its AX receipt contains the complete caption and enabled Stop help. The screenshot began exactly 125 seconds after the wire `startedAt`, matching the visible `02:05`.
- `03-expanded-live.panel.png` visibly uses both regions at exact `560x220`: status, large server timer, and Stop occupy the left card; three finalized lines plus one provisional line occupy the right transcript card; collapse and Open Workspace form the right footer. Text/material are readable, content remains inside the window, and the prior unused left field is gone.
- `04-expanded-ended.panel.png` truthfully shows authoritative idle after the native Stop wire command: idle status, disabled Stop, and cleared transcript, while retaining the balanced geometry.

`qa/summary.json` correlates the live capture frame, screenshot timestamp, AX positions/enabled/help, exact bounds, one native `stopCapture` receipt, authoritative ended frame, off-display restoration, and restored menu-toggle frame. The immediate hidden-menu inventory landed during AppKit's order-out fade (`alpha 0.3477`); hide/restore state semantics remain covered by the passing serial native-surface contract and the installed second AXPress restored the exact `560x220` frame.

The first post-run summary exited 1 only because its checker required the AX button bezel to begin at x=1136 rather than the observed x=1135 and required an immediate zero-window count during the native fade. The captures and product run were complete; the corrected bounds-tolerant evaluation is `qa/summary.json` with verdict PASS.

## Preservation and cleanup

HUD material, exact `360x56`/`560x220` geometry, browser-only Start/native Stop, control vocabulary, AX roles/help, contrast, menu restoration, and off-display restoration remain intact. Cleanup restored the canonical project marker and saved frame, removed temporary files, stopped the app/server, and freed port 54832. No plan, ledger, todo, F4 checkbox, user data, or unrelated product file was edited. No commit was created.

**M1R is directly closed.**
