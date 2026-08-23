# F1 repair — visual-fidelity repair of V1, V2, V3

- Task id: `st_019ff400`
- Parent session: `019fef5e-6de0-7b8b-9d1c-e4d629a0379b`
- Root session: `019fef5e-6de0-7b8b-9d1c-e4d629a0379b`
- Depth: 1
- Repaired against HEAD: `a1ed25f95980980cd958044b90e739ac45e8280d` (working tree dirty; shipped `public/` repaired on disk)
- Timestamp (UTC): `2026-08-12T03:44:05Z`
- Contract: `DESIGN.md` Section 9 (`OMO-CONTRACT-ID: operator-contract-v2-caret-grade`) — read only, never edited
- Input under repair: `final/f1-repair/reviews/visual/REPORT.md` (FAIL-V1, FAIL-V2, FAIL-V3)
- No commit was created. No plan, ledger, boulder, or F1 checkbox was touched. No F2–F4 phase entered.

## Verdict

**PASS.** All three defects are directly closed, each proven RED before the fix and GREEN after,
with real Chromium geometry and screenshots inspected personally at every viewport named by the
task.

## What changed

Exactly two shipped files. `public/style.css` was deliberately **not** modified — its SHA-256 is
byte-identical to the value the independent review recorded, which proves V2 was closed in markup
rather than by mutating the stylesheet the review had already audited.

| File | SHA-256 (after repair) |
| --- | --- |
| `public/caret-operator.css` | `4d0c317fb655f9f2484fdb160195432e69b4a038332fd421ed441dbc608425dd` |
| `public/index.html` | `b08d066a8c4395df980d1b4caa698ca42361aa34fb9a90aa09126b0ff88022e9` |
| `public/style.css` (unchanged; matches review) | `d433375487cfae2ec0e6347efd966d27105ffddb0f5d2495641b89884a45fb25` |
| `tests/public-caret-visual-repair.test.ts` (new) | `1fc0028dc5b2d0a6bca8dc17221a497944fe3fb0e2eacacff52320e01bc167a3` |

Every declaration added uses an existing design token (`--cf-space-*`, `--cf-rule*`,
`--cf-text-*`, `--cf-radius-*`). No hardcoded colour, spacing, radius, or font size was
introduced, and no new token was needed.

## Correction to the review's root-cause attribution for V1

The review attributed V1 to `#island` being a direct child of `#document-surface` that receives no
`grid-row`/`grid-column` in the `@media (min-width: 900px)` block. **The runtime DOM disproves
that.** The measured parent chain is:

```
#island -> #stage-pane -> #document-surface -> .workspace -> .app
```

`#island` is a **flex child of `#stage-pane`**, not a grid child of `#document-surface`. Grid
placement was therefore never the mechanism. The real mechanism, measured at 960x760 with the long
provisional caption:

| Node | Measurement (RED) |
| --- | --- |
| `#island` | `x=-133.7  w=902.4  right=768.7`, `flex: 0 0 auto`, `min-width: auto` |
| `#stage-pane` (its flex container) | `x=0  w=635  right=635`, **`overflowX=150`** |
| `#transcript-pane` | `x=640  w=320` |
| `#caption-text` | `x=-47.7  scrollW=1497  clientW=800  overflowX=697` |
| document root | `rootOverflow=0` |

A 902.4px row inside a 635px container, centred, overflows **both** edges: glyphs cut at `x<0` on
the left and the row running under the transcript pane on the right — exactly the two-sided shear
the review observed in `02-live-960.png`. `flex: none` plus the default `min-width: auto` make the
row unable to shrink, so the `text-overflow: ellipsis` that `.island__text` already declared could
never engage. `rootOverflow` stayed `0` throughout, which is precisely why the task-18 harness
missed it.

The fix targets the measured flex-shrink failure. The review's *symptom*, *viewport dependence*,
*content-length dependence*, and *contract citations* were all correct; only the CSS mechanism was
misidentified. The full RED receipt is `red/red-root-cause-geometry.txt`.

## The three repairs

### V1 — provisional caption row shears across the live split at >= 900px

`public/caret-operator.css`, `.app[data-shell="live"] #island` and its `.island__text`:

- `flex: none` -> `flex: 0 1 auto` with `align-self: stretch`, so the row is sized by the pane
  that owns it instead of by its own content.
- Added `min-inline-size: 0` and `max-inline-size: 100%` on the row, and `flex: 0 1 auto` +
  `min-inline-size: 0` on `.island__text`, which releases the flexbox min-content floor so the
  already-declared ellipsis engages.

No grid placement was added, because the node is not a grid item.

### V2 — `#btn-review` renders as a blank 44x44 control at <= 420px

`public/index.html`: added the icon node the stylesheet has always targeted.

```html
<span class="review-btn__icon" aria-hidden="true">✓</span>
```

This resolves the dead-selector defect the review recorded as residual risk #4: `public/style.css`
line 1233 styles `.review-btn__icon`, and until now no such node existed. The glyph is
`aria-hidden`, so the `aria-label` "회의록 검토" remains the single accessible name (DESIGN 9.12) —
asserted explicitly so a future change cannot trade the name away for the glyph. The control now
degrades exactly like its `#btn-attendees` sibling, which already carried the same node.

### V3 — action card text column crushed at the narrow floor

`public/caret-operator.css`, `.app[data-shell="library"] .action-card__head`:

- Added `flex-wrap: wrap` so the command group drops to its own row instead of competing for the
  same line.
- Added `.action-card__head > :first-child { flex: 1 1 auto; min-inline-size: 0 }` so the text
  column claims the full measure.

The observed defect was **not** `.action-card__btn` text truncation. The buttons' own labels always
fit (`overflowX=0` in both RED and GREEN). The real failure was a share-of-width collapse:
`.action-card__actions` is `flex-shrink: 0`, so in a single non-wrapping row it kept its full
156.6px while the title/description column was squeezed to **81.4px of 254px (32%)**, fragmenting
"Send follow-up" and "회의가 끝나면 후속 메일 초안이 여기 쌓입니다." into a ragged sliver. That is
what reads as truncation in `05-viewport-320.png`. The two "unlabeled siblings" the review saw are
the same two commands rendered at `opacity: 0.45` in their `:disabled` state.

## TDD receipts

New focused suite: `tests/public-caret-visual-repair.test.ts`. It pins machine-consumed values
only — box geometry, per-element `scrollWidth - clientWidth`, computed visibility, line-box counts,
and accessible names (which DESIGN 9.12 makes an explicit contract). It pins no prose.

| Phase | Result | Artifact |
| --- | --- | --- |
| RED | **9 fail / 1 pass**, 53 assertions | `tdd/red-visual-repair.txt` |
| GREEN | **10 pass / 0 fail**, 120 assertions | `tdd/green-visual-repair.txt` |

The single RED pass was `reference1440` for V1: at 1440 the stage is wide enough that this
particular caption does not yet overflow. That is reported rather than hidden — V1 is a
width x content-length interaction, and 900 / 960 / 1244 all failed RED.

The V3 assertion was independently re-proven RED after its reader was corrected (the first version
computed line count from `line-height`, which resolves to the keyword `normal`; it now measures
line boxes with a `Range`). Reverting only the `.action-card__head` block reproduced
`textShare = 0.3204` at 320 and `0.4414` at 375, then the fix was restored.

Determinism: every awaited client state is armed with a `MutationObserver` **before** its trigger
frame is pushed and bounded by a named timeout. There is no sleep, no polling delay, and no
`waitForTimeout` anywhere in the suite or in any capture tool under this directory.

## Real Chromium QA

`qa-sweep.ts` — frozen clock, `ko-KR`, `Asia/Seoul`, fonts awaited, long mixed Korean/English
provisional caption. Results in `geometry.json`, screenshots in `screenshots/`.

### V1, live shell, long provisional caption

| Viewport | `#island` | owner `#stage-pane` | within owner | island ovf | stage ovf | `#transcript-pane.x` | root ovf |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `900x760` (seam) | `x=16 w=543 right=559` | `x=0 w=575` | yes | 0 | 0 | 580 | 0 |
| `960x760` | `x=16 w=603 right=619` | `x=0 w=635` | yes | 0 | 0 | 640 | 0 |
| `1244x836` | `x=16 w=887 right=903` | `x=0 w=919` | yes | 0 | 0 | 924 | 0 |
| `1440x900` | `x=16 w=1083 right=1099` | `x=0 w=1115` | yes | 0 | 0 | 1120 | 0 |

At every width the island's right edge is strictly left of the transcript pane's left edge, so it
can no longer cross the splitter. `#stage-pane` overflow went `150 -> 0` at 960.

### V2 and V3, library shell, meeting selected

| Viewport | `#btn-review` | icon | accessible name | ink | text share | commands on own row | title line boxes | command ovf | root ovf |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `375x812` | `44x44` | `7.7x14` `✓` | `회의록 검토` | 1 | `1.0` | yes | 1 | 0 | 0 |
| `320x667` | `44x44` | `7.7x14` `✓` | `회의록 검토` | 1 | `1.0` | yes | 1 | 0 | 0 |

Both commands measure `57.7x44` and `90.9x44` — target size preserved, labels complete.

### Blanket clipping sweep

Every text-bearing node (`button, a, h1, h2, h3, p, span, li`, plus the three repaired component
classes) was checked for `scrollWidth > clientWidth` without an opted-in ellipsis, at all six
viewports:

```
clippedTextNodes = []   (all six viewports)
rootOverflowX    = 0    (all six viewports)
```

No new overflow, no CJK clipping, no blank control.

### Screenshots inspected personally

All captures below were opened and read, not merely produced:

| Artifact | What was confirmed by eye |
| --- | --- |
| `screenshots/live-960x760.png` | Caption row starts at the left gutter, ends with a clean `금요…` ellipsis well inside the stage column. No sheared glyph at either edge. |
| `screenshots/live-1440x900.png` | Same, with more of the English tail visible before the ellipsis. Stage/transcript seam clean. |
| `screenshots/live-900x760-seam.png` | Exact seam width; row contained, ellipsized, no bleed. |
| `screenshots/live-1244x836.png` | Library reference width in live shell — the capture the review flagged as missing entirely. |
| `screenshots/review-control-320.png` | A clearly rendered `✓` glyph inside the 44x44 capsule. |
| `screenshots/library-320x667-topbar.png` | The review control now reads as a real control beside the `◇` attendee sibling — the blank capsule is gone. |
| `screenshots/action-card-320.png` | "Send follow-up" complete on one line; the Korean description on one line; Copy / Open draft legible on their own row. |
| `screenshots/action-card-375.png` | Same, full card visible including body. |
| `red/red-320-action-card.png` | RED comparison: the same description fragmented as "후속 메일 / 초안이 여기 / 쌓입니다." and the blank review capsule. |

Residual risk #1 from the review ("no current `1440x900` or `1244x836` capture exists in live shell
with a long provisional caption") is now closed: both exist, both were inspected, and both are
clean.

## Verification

| Check | Result |
| --- | --- |
| Focused suite `public-caret-visual-repair` | **10 pass / 0 fail**, 120 assertions |
| Related browser suites (`caret-live`, `caret-library`, `caret-accessibility`, `review`, `shell`) + focused | **230 pass / 0 fail**, 1225 assertions |
| `git diff --check` | exit `0`, no whitespace error |
| LSP diagnostics, `tests/public-caret-visual-repair.test.ts` | **No diagnostics found** |
| LSP diagnostics, CSS/HTML | Unavailable — the configured `biome` server is not installed. Not installed unasked. Integrity verified structurally instead: CSS brace balance `0` with min depth `0`; HTML `<span>` 81/81, `<button>` 34/34, `id="btn-review"` appears exactly once. |
| CSS/HTML token discipline | Every added declaration uses an existing `--cf-*` token; zero magic numbers |

### Full-suite status

`bun test` across 75 files: **983 pass / 8 fail** on the first run. All 8 failures are pre-existing
and unrelated to this repair — they live in `src/llm.ts` transport and server WS dispatch
(`llm-transport`, `start-review-action`, `attendees-action`) and none of them loads any `public/`
asset or the browser harness (verified: no reference to `public-test-harness`, `public/`,
`caret-operator`, or `index.html` in any of those suites).

A second full run showed a 9th failure, `Todo 15 · a reconnect re-asserting the same live capture
never re-steals focus`. This is **not** a regression from this repair:

- it passes standalone 3/3 and passes with its whole suite (103 pass / 0 fail);
- it passed in the 230-test related-suite run;
- a concurrent sibling session was actively editing that exact file and
  `public/operator-surface.js` at 12:38–12:41, after this repair's edits at 12:31 (mtimes recorded).

This repair touched neither of those files.

## Concurrency note

This tree is shared with at least one concurrent sibling repair session. Files observed being
modified by that session, and explicitly **not** touched here:
`public/operator-surface.js`, `tests/public-caret-accessibility.test.ts`, and
`final/f1-repair/start-focus-repair/`. Unrelated dirty work elsewhere in the tree was preserved
untouched.

## Scope statement

Product files modified — exactly two:

- `public/caret-operator.css` (V1: island flex sizing; V3: action-card head wrapping)
- `public/index.html` (V2: one `.review-btn__icon` span)

Test file added:

- `tests/public-caret-visual-repair.test.ts`

Evidence written under `final/f1-repair/visual-repair/` only. `DESIGN.md` (mtime `04:33`),
`.omo/plans/caret-clone-redesign.md` (`11:29`), and `.omo/start-work/ledger.jsonl` (`11:29`) all
predate this session (`12:31`+) and were not modified. No F1 checkbox was ticked. No F2–F4 phase
was started. No commit was created.
