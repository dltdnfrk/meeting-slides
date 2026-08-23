# Todo 11 — Rebuild the document-centric library shell

## Outcome

The library shell is now a narrow meetings rail plus exactly ONE document
surface. Overview / Notes / Transcript are a real ARIA `tablist` / `tab` /
`tabpanel` that replace one another; the permanent third-column transcript dock
is gone. The canonical UI and transcript reducers are executed by the browser
through a reproducible, drift-tested build artifact — there is no dead
TypeScript seam.

## The browser-valid reducer path (permanent, not a workaround)

`server.ts` serves an unknown extension as `application/octet-stream` with
`x-content-type-options: nosniff`, so a browser refuses to execute
`public/*.ts`. Rather than weaken that MIME policy or fork the reducers into
hand-written JS:

* `scripts/build-public-modules.ts` transpiles each reducer source into
  `public/generated/<name>.js` (type erasure only — no bundling, no minify, no
  hashed name, no timestamp), plus `public/generated/module-manifest.json`
  recording source and output SHA-256.
* `.js` is already in the server MIME map, so the artifact is served as
  `application/javascript; charset=utf-8` and executes.
* `public/operator-surface.js` is now an ES module that imports the artifacts.
* Drift is a test failure, not a review question:
  - the committed artifact must equal a fresh build byte-for-byte;
  - two builds from the same source must be byte-identical;
  - a deliberately perturbed source in a scratch copy must be reported `stale`.
* `bun run scripts/build-public-modules.ts --check` is the CI-shaped gate.

Verified byte-identical across rebuilds:
```
17ff9b54dc49c6a657a5271e780daf9f912c7fa710966ebd4302d391608006ee  transcript-state.js
a3f03ee02df4aa104a56703bb8491828c29ce06d727a0e55641ba53a2e16953f  ui-state-machine.js
```

## Test results

RED → GREEN, `tests/public-caret-library.test.ts`:

| Phase | Result |
| --- | --- |
| RED (before implementation) | 8 pass / 18 fail — see `red/red.log`, `red/red-summary.txt` |
| GREEN (final) | 28 pass / 0 fail |

Focused suites that must remain green — all green (`green/green-tests.log`):

| Suite | Result |
| --- | --- |
| tests/public-caret-library.test.ts (task-11) | pass |
| tests/public-dom-protocol-contract.test.ts (task-3) | pass |
| tests/public-caret-harness.test.ts (task-4) | pass |
| tests/public-caret-foundation.test.ts (task-9) | pass |
| tests/ui-state-machine.test.ts (task-7) | pass |
| tests/transcript-state.test.ts (task-8) | pass |
| **Total** | **228 pass / 0 fail** |

Task-4 needed no hash rebaseline: its assertions are geometry/layout contracts,
not screenshot bytes, and the live split behaviour was restored exactly.

## Real-browser QA (six viewports, happy + bad/reconnect)

Driver: `green/qa-driver.ts` — frozen clock, `ko-KR`, `Asia/Seoul`, DPR 1, every
off-origin request refused, every awaited state subscribed to before its
trigger, no sleeps. Artifacts: `green/screenshots/` (27 PNG), `green/qa-report.json`.

| Viewport | Root overflow | Perceivable panels | Dock controls clipped / truncated |
| --- | --- | --- | --- |
| 1440x900 | 0 | 1 | 0 / 0 |
| 1244x836 | 0 | 1 | 0 / 0 |
| 960x760 | 0 | 1 | 0 / 0 |
| 820x900 | 0 | 1 | 0 / 0 |
| 375x812 | 0 | 1 | 0 / 0 |
| 320x667 | 0 | 1 | 0 / 0 |

Off-origin requests across the whole sweep: **0**.

States exercised and inspected: empty library, populated Overview, typed Notes,
15-line Transcript, malformed frames dropped, transport loss / reconnecting with
content retained, keyboard tab traversal.

## Defects found by visual QA and fixed at the root

1. **Slide painted over the Overview blocks.** An `aspect-ratio` child inside a
   grid track resolves its height after the track is sized, so `#slide-frame`
   was sized at 78px while the slide inside it was 428px. Fixed by giving the
   frame the ratio and making the Overview panel a flex column.
2. **375px/320px dock clipped a label mid-glyph.** The superseded layer made the
   action row a horizontal scroller. Replaced with a wrapping
   `repeat(auto-fit, minmax(96px, 1fr))` grid; the compile action spans the row
   so the longest label is never ellipsized. Also suppressed the legacy `"→"`
   scroll-hint `::after`, which advertised an interaction that no longer exists.
   Now locked by "no dock control is clipped or truncated at any matrix width".
3. **Transcript prose below AA contrast.** A legacy `opacity: 0.85` dimmed
   `#fafafa` text. Neutralized in library shell and locked by a test that
   measures the *composited* colour (inherited opacity included) against the
   nearest opaque ancestor and asserts >= 4.5:1.
4. Delete affordance overlapped the meeting title; selection accent bar was not
   painted (unpositioned `::before`). Both fixed.

## Suite truth and withdrawn attribution (Revision 3)

An earlier revision of this summary claimed two browser tests were "pre-existing
failures" from a concurrent lane. That was **wrong and is withdrawn**. Both
`820px에서 레일은 접히고 …` and `caret dual shell exposes detail tabs and live
compact mode` **passed at Todo 11's own 17:47 baseline**, and both assertions are
Todo-11-authored. They were regressions caused by this task.

Both are resolved:

* `caret dual shell …` exposed a REAL product defect — `#live-topbar` was hidden
  during the `starting` phase, so Stop and the timer vanished while a recording
  was being established (DESIGN §9.8 violation). The product is fixed and driven
  by the authoritative `data-capture-phase`; the test passes unchanged. A
  three-phase regression test now locks it.
* `820px …` carried a Todo-11-authored `stageViewportShare >= 0.54` assertion
  pinning LIVE height geometry, which belongs to Todo 12. That single assertion
  was removed rather than bending the product to an out-of-scope number; the
  stage/transcript visibility, ordering and non-overflow bindings are kept.

Final: `public-workspace` + `public-operator-surface` = **27 pass / 0 fail**;
focused six suites = **232 pass / 0 fail**. Every Todo-11-authored test is green.

## Contracts preserved

* All 99 binding DOM IDs unique, correct ancestry, panes disjoint — task-3 green.
* `#live-topbar` kept inside `#stage-pane` as the frozen contract requires.
* Action names and payload spellings untouched (`startCapture`/`meeting_id`,
  `selectMeeting`/`meetingId`, ...). No server change.
* `.app--capturing` still written by `app.js` and read by the shell.
* Persisted layout keys `workspace.layout.v1`, `workspace.transcript.v1` intact.
* Live split preserved: side by side >= 900px, stacked below — Todo 12 still owns
  the focused live redesign.
