# F3 Real Manual QA

**Verdict: REJECT**

Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Installed artifact: `$HOME/Applications/Meeting Slides.app`  
Gate: F3 only; F4 not entered.

## Decision

The freshly rebuilt installed app passed bundle verification and strict codesign, and the real installed executable launched against an isolated temporary project/database/export root with only a local deterministic CLI/recorder fixture. However, the decisive browser/native journey did not complete: at the 960x760 live surface, the browser interaction path could not activate the progressive-disclosure compile flow through Puppeteer's real pointer path and terminated with `Node is either not clickable or not an Element` before compile/history/export. F3 cannot approve without personally completing those required surfaces.

This is a gate rejection, not a claimed product-source defect. No product bytes were edited. The failure may be interaction geometry or harness targeting, but F3 evidence is incomplete and therefore non-approvable.

## Exact reproduction and evidence

1. Fresh build: `bash scripts/build-app.sh` - PASS (`build/build-app.txt`).
2. Artifact verification: `bash scripts/verify-app.sh "$HOME/Applications/Meeting Slides.app"` and `codesign --verify --deep --strict` - PASS.
3. Decisive journey: `bun run .omo/evidence/caret-clone-redesign/final/f3-manual-qa/tools/f3-journey.ts` - exit 1 (`runtime/decisive.exit`, `runtime/decisive.stderr`).
4. The journey reached real installed AppKit surfaces and all six exact live viewports, then failed entering compile/history before `history-preview.png` could be produced.
5. Cleanup completed: marker restored to the canonical root, temporary root removed, task port free, installed process absent, defaults restored (`runtime/cleanup.json`, `runtime/final-cleanup-verification.txt`).

## Observable coverage completed

- Fresh exact installed executable identity, bundle verifier, ad-hoc signature.
- Isolated runtime and user meeting DB hashes unchanged.
- Real browser Start with focus moved to `#btn-live-stop` before the compile-stage failure.
- Live PPT/transcript screenshots at 1440x900, 1244x836, 960x760, 820x900, 375x812, and 320x667.
- Personally inspected screenshots show complete uncropped waiting-stage geometry, persistent Stop/timer, finalized transcript at wide and narrow widths, stacked narrow layout, and no visible horizontal clipping.
- Real native collapsed bounds `360x56`, expanded bounds `560x220`, disclosure, Open Workspace, and menu-bar AX item.
- Off-display saved frame `(9000,9000,360,56)` restored on an available physical display to observed collapsed position `(1136,854)`.

## Coverage blocked by the decisive failure

Compile completion, history preview, exports, browser close/reopen continuity, installed non-idle quit confirmation, native Stop restoration, Review, Ask, controlled bad input, and their final screenshots were not reached in the decisive run. Earlier approved Todo 19 evidence cannot substitute for fresh F3 hands-on evidence.

## Launcher help surface

The executable implements no `--help` parser. A bounded `--help` invocation produced no help text and entered normal launcher startup until terminated (exit 143); README documents only build, verify, and `open -a "Meeting Slides"`. This is recorded in `build/help.*` and `build/documented-launcher.txt`.

## Safety and scope

No microphone device, external API/account, or user database was used. No screen-share claim was made. No product, test, plan, ledger, Boulder, Todo, or F4 file was edited. Only this F3 evidence directory was created.
