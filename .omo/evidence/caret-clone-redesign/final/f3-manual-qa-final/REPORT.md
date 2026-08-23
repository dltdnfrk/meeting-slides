# F3 Manual QA Final Recovery

**Verdict: REJECT**

Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Installed artifact: `$HOME/Applications/Meeting Slides.app`  
Gate: F3 only; F4 not entered.

## Decision

The required single fresh installed-app journey did not complete. The newly rebuilt app passed bundle verification and strict codesign, and the static interaction-owner preflight passed all 28 planned actions with both previously rejected hidden/non-owner targets absent. The decisive run then failed in the native menu/minibar opening phase because the QA harness queried `AXVisible` on the minibar window immediately after a successful real menu-bar `AXPress` hid that window. System Events correctly returned error `-1728` because the hidden window was no longer addressable as `window 1` through that query.

This is a third QA-harness failure, not an observed product defect. The successful menu-bar action itself made the window unavailable to the harness's follow-up observation. The single-journey constraint precludes changing that observation and retrying. F3 cannot approve without fresh observable completion of every required scenario.

## Static preflight

`runtime/preflight.json` records `PASS` for 28 statically enumerated actions before the journey. The copied harness enforces, before every browser pointer/keyboard dispatch:

- non-zero visible geometry;
- viewport inclusion and center hit-test ownership;
- enabled state;
- accessible role and name.

Native actions are manifest-bound to named AX owners. `#dock-more > summary` is assigned to native-summary keyboard Enter. History return is assigned to the visible `#current-slide .slide__notice`. The rejected `#thumbnails .thumbnail` and nonexistent `#btn-return-live` targets are absent.

This preflight did not launch the product and was not a journey retry.

## Fresh build and exact failure

- `scripts/build-app.sh`: exit 0.
- `scripts/verify-app.sh "$HOME/Applications/Meeting Slides.app"`: exit 0.
- `codesign --verify --deep --strict`: exit 0.
- Decisive command: `bun run .omo/evidence/caret-clone-redesign/final/f3-manual-qa-final/tools/f3-journey.ts`: exit 1.
- Installed menu-bar owner observed before activation: `AXMenuBarItem, Meeting Slides — 대기 중, ○, 2970, 3, 34, 24`.
- Real `AXPress` on `menu bar item 1 of menu bar 2` returned successfully.
- Immediate follow-up failed: System Events could not get `attribute "AXVisible" of window 1`, error `-1728` (`runtime/decisive.stderr`).

The failure occurred before browser launch, so no browser action or screenshot belongs to this incomplete journey. No screenshot was reused or claimed as fresh evidence.

## Incomplete required coverage

The run did not freshly complete happy path, controlled bad input, reconnect, browser close/reopen, compile/export/history, Review, Ask, non-idle quit protection, native Stop restoration, six canonical live widths, or final screenshot inspection. Older F3/Todo 19 artifacts are not substituted.

## Safety, scope, and cleanup

No microphone input, external API/account, or user database was used. No product, test, plan, ledger, Todo, F4, or unrelated dirty-work byte was edited by this QA task. Only this superseding F3 evidence directory and the rebuilt installed bundle were written. No commit or staging operation occurred.

Cleanup passed (`runtime/cleanup.json`, `runtime/final-cleanup-verification.txt`): the project marker is canonical, temporary runtime is removed, port 54732 is free, no task app process remains, minibar defaults match their pre-run value, and the installed artifact still verifies and passes strict codesign.
