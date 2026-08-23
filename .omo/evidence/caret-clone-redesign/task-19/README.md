# Todo 19 - complete Caret-grade journey

Status: **DONE**, with unrelated pre-existing full-suite failures explicitly isolated below. F1-F4 were not entered.

## Boundary

The browser remains the only Start surface. The installed native minibar independently projected capture/transcript state, expanded, invoked Open Workspace, and received five rapid AX Stop activations in each of two cycles; the real wire recorded exactly one `stopCapture` per cycle and zero native starts.

## Fresh installed-app journey

Command: `bun run .omo/qa/task19-journey.ts`

Result: `JOURNEY PASS {"finalSessions":2,"totalStops":2,"totalStarts":2,"consoleErrors":1,"exportArtifacts":17,"nativeDropCount":0}`.

The one console message is Chromium's non-product favicon 404; no page exception or failed product request occurred.

Observed through the real installed executable, real Bun server, real Chromium, real AppKit AX controls, and a compiled native projection client:

- isolated empty library;
- cycle 1 browser Start, 16 deterministic finalized Korean lines;
- installed minibar projection, disclosure, Open Workspace, and exactly-one Stop;
- live 960x760, 820x900, and 375x812 layouts;
- live compile to three slides, history preview, four exports / 17 artifacts;
- browser transport disconnect/reconnect and live reopen without transcript loss;
- just-ended meeting selection, real Review request and confirmation;
- reload with stable export hashes and 16 restored lines;
- 320/375/960/1280 library layouts, settings, grounded Ask;
- malformed compile target surfaced in a status region without data loss;
- cycle 2 browser Start, five lines, installed minibar Open Workspace and exactly-one Stop;
- two final meetings; app/server/port/runtime/defaults/marker cleanup.

CGWindowList did not expose the panel to the QA process, so the fresh run records the screen-capture path as unsupported instead of claiming exclusion. Native visual truth is independently recorded through exact AX state and dimensions; no universal screen-share claim ships.

## Product defects fixed test-first

1. Real-wire Ask was registered but omitted from the actual dispatch whitelist. `tests/server-ask-dispatch.test.ts` now proves one CLI call and one terminal response.
2. Review had no first-use path: the button stayed hidden until a review already existed. A selected meeting now exposes Review; first activation sends the existing `startReview` action and opens loading state.
3. Reset cleared internal selection but left the ended row visibly selected. Reset now rerenders the rail immediately, enabling deterministic cycle 2.
4. The newly reachable narrow Review button inherited a removed token and measured 28x14. It now uses the canonical 44px target token.
5. The app-bundle suite's real build exceeded Bun's default 5s hook bound; the event-driven build hook now has a 30s bounded timeout.

RED/GREEN receipts are under `product-defect/` and `verification/`.

## Verification

- Project TypeScript: PASS.
- Swift full typecheck: PASS.
- `git diff --check`: PASS.
- Installed build: PASS.
- `scripts/verify-app.sh`: PASS.
- `codesign --verify --deep --strict`: PASS.
- App bundle test: 30 pass / 0 fail.
- Journey-related browser/native/server matrix: 224 pass / 0 product failures after focused repair (194-pass matrix plus 30-pass bundle; narrow target 4/4).
- LSP: changed TS/JS files clean where the server responded; `public/app.js` diagnostics timed out, while project TypeScript passed. CSS LSP unavailable because Biome is not installed.

The single required full `bun test` invocation completed 927 pass / 11 fail. Three failures were then fixed/verified (two narrow Review target cases and app-bundle hook bound). Eight failures remain in unrelated pre-existing meeting-minutes/provider work and reproduce outside the journey: six stale `tests/llm-transport.test.ts` expectations versus the dirty provider implementation, plus `tests/start-review-action.test.ts` and `tests/attendees-action.test.ts` timeouts. Per Todo 19's instruction, those unrelated dirty-work failures were not modified; exact logs are retained in `verification/`.

## Visual reviews

Three review lenses approve desktop/live, narrow/responsive, and native/accessibility captures in `visual-reviews.md`.

## Cleanup

Temporary QA harnesses are deleted after this index is written. No owned installed-app process, Bun server, browser, native driver, lock, temporary database/export tree, defaults mutation, or task port remains. The repository app symlink resolves to `$HOME/Applications/Meeting Slides.app`, and its project marker points to the canonical repository.

`SHA256SUMS` indexes every retained artifact.
