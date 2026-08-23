# F3 Manual QA Rerun

**Verdict: REJECT**

Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Installed artifact: `$HOME/Applications/Meeting Slides.app`  
Gate: F3 only; F4 not entered.

## Decision

The one permitted fresh decisive installed-app journey did not complete all F3 scenarios. The rebuilt installed artifact passed bundle verification and strict codesign, launched with an isolated runtime, and passed the repaired progressive-disclosure activation. It then stopped after compile at a second brittle QA interaction before the remaining scenarios could be observed. F3 therefore remains incomplete and is rejected.

This is QA-harness failure, not a product defect. No product file was edited and no retry was run.

## Exact classification of the 0x0 thumbnail

The selector `#thumbnails .thumbnail` points to a hidden, non-owner control in the live shell while a visible accessible owner already exists.

Evidence:

- The decisive pointer record measured the selected thumbnail at `{x:0,y:0,width:0,height:0}`, `inViewport:false`, and `hitTest:false` (`runtime/pointer-actions.jsonl`).
- Its owner `#dock-history` has class `.dock__panel`; the active live-shell CSS rule `.app[data-shell="live"] .dock__panel { display:none; }` hides that entire filmstrip.
- Successful compile calls `showCompiledScene(scene)`, which immediately sets `viewingHistory = slides[0]`, calls `renderMain()`, and therefore enters `data-stage-state="history-preview"` without any thumbnail activation.
- In that state `renderMain()` creates a visible native `<button class="slide__notice">` inside `#current-slide`. Its click handler invokes `exitSlidePreview()`. Escape is also a documented keyboard exit path.

Therefore the attempted thumbnail click was not evidence of a missing user-reachable product path. It was an unnecessary harness click on a hidden duplicate/history representation after the visible slide preview owner had already become active. The correct real-user path would have been to observe the already-entered history preview and activate `.slide__notice` (or Escape) to return. The task's single-run rule prohibits applying that recovery and retrying now.

## Fresh decisive run

- Build: `bash scripts/build-app.sh` - PASS.
- Bundle verification: `bash scripts/verify-app.sh "$HOME/Applications/Meeting Slides.app"` - PASS.
- Signature: `codesign --verify --deep --strict` - PASS.
- Executable SHA-256: `dddc34ffa7d7776daf183ae5c601d4c28a578f81c8fb3ac2543a6e01d2b34a7c`.
- Journey: `bun run .omo/evidence/caret-clone-redesign/final/f3-manual-qa-rerun/tools/f3-journey.ts` - exit 1.
- Exact terminal interaction: `pointer:history-thumbnail selector=#thumbnails .thumbnail`, measured `0x0`, not in viewport, not hit-testable (`runtime/decisive.stderr`).

## Coverage completed freshly

- Installed executable identity, bundle verification, strict codesign.
- Isolated project/database/export runtime and local deterministic CLI/recorder fixtures.
- Native collapsed and expanded AX surfaces, menu-bar surface, disclosure, and Open Workspace.
- Off-display minibar-frame restoration observation.
- Browser Start through Puppeteer's real pointer path and focus handoff to Stop.
- Six exact live viewports: 1440x900, 1244x836, 960x760, 820x900, 375x812, and 320x667.
- Repaired progressive disclosure through keyboard focus and Enter on the visible native `<summary>` at 960x760.
- Compile activation through a visible, hit-tested `928x40` button and compile completion sufficient to create compiled thumbnails and automatically enter history preview.

The six viewport screenshots were freshly recaptured. Native bounds were also freshly recaptured from this executable hash; no cross-build evidence was reused.

## Coverage incomplete

A final history-preview screenshot and return-to-live action were not recorded after compile. Exports, transport close/reopen continuity, browser close/reopen, non-idle installed-app quit protection, native Stop restoration, Review, Ask, controlled bad input, final screenshots, and final journey observations were not reached. Earlier Todo 19 evidence cannot substitute for these fresh F3 observables.

## Harness recovery made before the run

Only the copied rerun QA harness was changed:

- Replaced the rejected `page.click("#dock-more > summary")` with focus plus Enter on the visible, hit-tested native summary.
- Added bounded selector/geometry/display/visibility/pointer-events/viewport/hit-test labels around every Puppeteer pointer action.
- Replaced mutation waits with subscribe-before-trigger observers where applicable.

No direct DOM `.click()` was used to bypass browser hit testing. No product, test, plan, ledger, Todo, or F4 file was edited.

## Cleanup

Cleanup passed (`runtime/cleanup.json`, `runtime/final-cleanup-verification.txt`):

- installed process absent;
- port 54731 free;
- temporary isolated runtime removed;
- app project marker restored to the canonical root;
- minibar defaults restored;
- user meeting DB hashes unchanged from preflight;
- installed artifact still passes strict codesign.
