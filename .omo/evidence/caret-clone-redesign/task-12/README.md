# Todo 12 — Deliver focused live PPT and transcript workspace

Evidence index. Every artifact is checksummed in `SHA256SUMS.txt`.
No screenshot-byte golden is used anywhere: every assertion reads machine
geometry, computed style or DOM state.

## Outcome

The live shell now presents the **complete generated 16:9 PPT stage and the
complete transcript together** — side by side at >= 900px, stacked stage-above-
transcript below 900px — with a persistent, truthful Stop + timer and a dock
that clips nothing at any width.

## Measured before → after (9 viewports, capturing phase)

| Viewport | Arrangement | Slide aspect | Transcript body px | Offscreen controls (`starting`) | Root overflow |
| --- | --- | --- | --- | --- | --- |
| 1440x900 | side-by-side | 1.372 → **1.780** | 605 → 581 | 0 → 0 | 0 |
| 1244x836 | side-by-side | 1.540 → **1.779** | 541 → 517 | 0 → 0 | 0 |
| 1100x800 | side-by-side | 1.441 → **1.778** | 505 → 481 | 0 → 0 | 0 |
| 960x760 | side-by-side | 1.257 → **1.779** | 465 → 441 | 0 → 0 | 0 |
| 900x760 | side-by-side | 2.341 → **1.780** | 237 → **441** | 0 → 0 | 0 |
| 899x760 | stacked | 13.317 → **1.779** | 80 → **120** | 1 → **0** | 0 |
| 820x900 | stacked | 5.714 → **1.778** | 150 → **161** | 2 → **0** | 0 |
| 375x812 | stacked | 3.539 → **1.782** | 106 → **151** | 8 → **0** | 0 |
| 320x667 | stacked | 7.647 → **1.772** | 51 → **120** | 8 → **0** | 0 |

16:9 = 1.7778. Residual deviation is integer rounding of a fractional CSS box,
inside the declared 1.5% tolerance; it is not a subpixel screenshot allowance.

The **900 seam is tested at the exact boundary**: 900 side-by-side, 899 stacked.

## The Todo-11 handoff defect: root cause and fix

At 375px during `starting`, eight export controls sat between x=367 and x=954 on
a 375px viewport — real capabilities, silently offscreen, last label cut
mid-glyph (`.dock__tabs` scrollWidth overflow: 647px at 375, 702px at 320).

Root cause: Todo 11's wrapping fix is scoped to `.app[data-shell="library"]`.
During `starting`/`stopping` the reducer already reports `data-shell="live"`
while `.app--capturing` is still absent, so **neither** the library fix nor the
legacy live rules applied and the raw `nowrap` scroller from `style.css` /
`operational-liquid.css` won.

Fix: the live dock is an auto-fit **wrapping grid**, plus one real
`<details>` disclosure for the save/export set (DESIGN §9.11 progressive
disclosure). Nothing is hidden or faked — every control keeps its ID, action,
accessible name and tab position; `<details>` is natively keyboard-operable.
The library dock keeps its full open set (`display: contents`), so Todo 11's
contract is preserved unchanged.

## Product defects found and fixed at the root

1. **Slide never 16:9, content cropped.** The superseded layer stretched
   `#current-slide` to fill a free-height frame. At 375px the slide rendered
   only "03 제품 로드맵" — title, all bullets and the emphasis line were gone;
   at 320px it was a 260x34 sliver. Fixed by making `#slide-frame` a
   `container-type: size` container and sizing the slide as
   `min(100cqw, 100cqh * 16/9)`, a true contain-on-both-axes expression.
   `max-width` + `max-height` cannot express this: CSS does not back-propagate a
   clamped axis, so the non-binding axis keeps its value and the ratio breaks
   (measured at 960px: 603x382.5 = 1.576).
2. **Malformed `line` frames rendered.** `app.js` appended a DOM row for
   `{type:"line"}` and `{type:"line", text:42}`, which the canonical reducer had
   already rejected — leaving DOM and projection permanently out of sync. Fixed
   by having the renderer consult the reducer's verdict
   (`caretShell.acceptsTranscriptFrame`), so there is one judge, not two.
3. **Malformed `slide` frame destroyed the last good slide.** `currentSlide =
   msg.current` accepted any shape. DESIGN §9.8 requires preserving live content;
   a renderability check now drops the frame instead. `null` still means the
   server's real "no slide yet".
4. **Transcript unreadable when stacked.** 51px of body at 320px against 1323px
   of content. Fixed by content-sizing the stage, capping the slide by viewport
   share, and giving the transcript body a 120px floor.
5. **Transcript measure unbounded when stacked** (809px lines at 899px). Capped
   at 68ch so Korean prose wraps at a readable column.

## Tests

`tests/public-caret-live.test.ts` — 44 tests, RED → GREEN.

| Phase | Result |
| --- | --- |
| RED (before implementation) | 23 pass / **18 fail** (`red/red.log`) |
| GREEN (final) | **44 pass / 0 fail** |

Focused suites that must stay green — all green (`green/green-tests.log`):

| Suite | Result |
| --- | --- |
| tests/public-caret-live.test.ts (task-12) | pass |
| tests/public-caret-library.test.ts (task-11) | pass |
| tests/public-workspace.test.ts | pass |
| tests/public-operator-surface.test.ts | pass |
| tests/public-dom-protocol-contract.test.ts (task-3) | pass |
| tests/public-protocol-reliability.test.ts | pass (3/3) |
| **Total** | **129 pass / 0 fail** |

Generated-module drift gate: `bun run scripts/build-public-modules.ts --check`
→ exit 0, both artifacts `ok`. The reducers are reached only through
`public/generated/*.js`; the suite asserts zero `.ts` script requests.

### Additive update to a superseded-layout test

`tests/public-operator-surface.test.ts` → "caret dual shell exposes detail tabs
and live compact mode" entered live by adding `.app--capturing` **by hand**.
That class is the legacy compatibility signal, not the authoritative shell:
setting it alone leaves `data-shell="library"`, so the live geometry never
applied and the assertions measured the library layout while claiming to measure
live. The step now enters and leaves live through **real capture frames**, and
every original assertion holds unchanged. No assertion was weakened or deleted.

## Verifier rejection (st_019ff0b2) — repaired

**Regression:** the first cut dissolved the save/export disclosure in the library
shell with `display: contents` plus `summary { display: none }`. A **closed**
`<details>` still hides its content, so removing the summary removed the only
control that could open it.

Measured with `red2/reproduce.ts` (hit-test at each control's own centre):

| Width | Summary painted | Unreachable | Below unscrollable fold |
| --- | --- | --- | --- |
| 1440x900 | **false** | **8/9** | **7/9** |
| 1244x836 | **false** | **8/9** | **7/9** |
| 1100x800 | **false** | **8/9** | **7/9** |

The earlier Todo-11 suite pass was a false negative: it measured `.dock__btn`
boxes, and a box with a non-zero rect can still be unclickable.

**Root fix (the preferred one):** the *same real disclosure* is now reachable in
both shells. Its DEFAULT is shell-driven — open in library (Todo 11's contract
that the dock shows its whole set), collapsed in live (so it cannot grow tall
enough to starve the stage and transcript). The default is applied only when the
shell actually changes, so a user's own toggle survives within a shell.

Two supporting fixes, both from measurement:
* the library dock is `flex-shrink: 1; min-height: 0; max-height: 50vh;
  overflow-y: auto`. `.app` is a `100dvh` flex column, so the previous
  `flex-shrink: 0` let a grown dock overflow the viewport — at 1100x800 that put
  `#btn-reset` at y=801, one pixel past the fold and unhittable.
* the reachability probe scrolls with `block: "nearest"` before hit-testing,
  because the dock is legitimately a scroll owner.

**After:** `unreachable=0/9`, `belowFold=0/9`, `summaryPainted=true` at all three
widths (`green/reachability-green.json`).

RED evidence: `red2/red2.log` — the new assertions fail **3/3** against the
regressed CSS and pass 3/3 with the fix.

### Renamed misleading test

`"repeated Stop activation sends exactly one stopCapture"` →
**`"the live Stop control emits the existing stopCapture action"`**. The old name
claimed a single-dispatch guarantee Todo 12 does not own (de-duplication belongs
to the canonical reducer, Todo 7, and the native surface, Todo 14), and its
assertion raced a harness read against a rAF tick, so it could pass merely
because the frame resolved first. It now asserts only what Todo 12 owns: the
stage's Stop is wired to the one real capture control and emits the frozen
action name. **No product stop behaviour and no native contract was changed.**

### Additive update to one attendees test

`tests/public-attendees.test.ts` → "existing slide rendering and dock controls
survive the new panel" clicks `#btn-export-md` while **live**, where Todo 12
places the export set behind the disclosure. Puppeteer's `click` requires
visibility, so the test now opens the disclosure first — as a user does — and its
original action assertion is untouched. Attendees goes 6 fail → **5 fail, exactly
its pre-existing baseline**, so the Todo-12 delta is zero.

## Unrelated / legacy failures — recorded, NOT fixed

`tests/public-attendees.test.ts` — **5 fail**, all asserting that `startCapture`
emits no companion `listMeetings`. That is a capture/session concern in
`app.js`, unrelated to dock layout, and the count is **identical** with the
Todo-12 dock removed entirely. Left unfixed.

`tests/public-transcript-dock.test.ts` — **6 fail**, all in the one describe
block `전사 패널 다중 모서리 리사이즈` (transcript corner-resize grips).

Attribution is proven, not asserted: reverting Todo 12's single
`.transcript-grip` rule leaves the count at **6 fail either way**. These grips
were already removed from the shell by **Todo 11** (`caret-operator.css:914`,
`.app[data-shell="library"] .transcript-grip`), before Todo 12 existed. DESIGN
§9.9 replaces them with the splitters, and §9.8 excludes dense tool rows from
the live shell. This is **Todo 18's** superseded-layer cleanup, out of scope
here, and was deliberately left unfixed.

## Files changed by this task

| File | Ownership |
| --- | --- |
| `public/caret-operator.css` | live shell section added; library section untouched |
| `public/caret-shell.css` | superseded live block **removed**, shell-agnostic Stop/timer chrome retained |
| `public/index.html` | export set wrapped in one real `<details>` disclosure |
| `public/app.js` | renderer consults the canonical reducer for `line`; `slide` renderability check |
| `public/operator-surface.js` | exposes `acceptsTranscriptFrame` (the reducer's verdict) |
| `tests/public-caret-live.test.ts` | new (task-12) |
| `tests/public-operator-surface.test.ts` | additive: enters live authoritatively |

Preserved: Todo 11's library shell and its 32-test suite, the generated
reducers, all binding DOM IDs, every action name and payload spelling
(`startCapture`/`meeting_id`, `selectMeeting`/`meetingId`), `.app--capturing`,
and the persisted layout keys. No server change. No commit, no staging.

## Determinism

Frozen clock (2024-03-14T09:41+09:00), `ko-KR`, `Asia/Seoul`, DPR 1, every
off-origin request refused, every awaited state subscribed to **before** its
trigger, bounded named timeouts. No sleep, no polling delay, no
`waitForTimeout`. Zero off-origin requests across the sweep.

## Artifacts

- `baseline/` — pre-change characterization: driver, geometry JSON, 9 screenshots
- `red/red.log` — the 18-failure RED
- `green/` — GREEN test log, geometry JSON, 9 screenshots, `before-after.json`
- `SHA256SUMS.txt` — checksums for all 25 artifacts
