# F1 repair — `#btn-live-stop` 44px target repair

Task `st_019ff411`. Canonical root `/Users/hyunjun/Documents/MUNI/meeting-slides`.
HEAD at run: `a1ed25f95980980cd958044b90e739ac45e8280d`. No commits made.

## Defect

`start-focus-repair` measured `#btn-live-stop` at **66x28 CSS px** at 1244x836 — below the
DESIGN.md 9.12 pointer-target floor of 44x44 CSS px.

Root cause: the Stop control's block-size floor was a literal `28px` (and its capsule `36px`)
in both the `body .live-topbar__stop` base rule and the `.app[data-shell="live"] #btn-live-stop`
override. The `--cf-target-min: 44px` token was applied **only** inside `@media (max-width: 375px)`,
so the floor was enforced exactly where a media query already forced it and nowhere else.
Every desktop and canonical width shipped a 28px-tall destructive control.

## TDD

### RED — `tdd/red-proof.txt`

New test in `tests/public-caret-accessibility.test.ts`, in the existing
`Todo 15 · every painted control is a real target, scroll included` describe block:

`{width}x{height} live: #btn-live-stop meets 44px without inflating its glyph`

parameterised over the two canonical desktop widths the plan names — **1244x836** (library
reference) and **1440x900** (reference comparison). The pre-existing target scan only ran at
`width <= NARROW_MAX_WIDTH` (375), which is why this defect was invisible to the suite.

The test is machine-consumed and real-browser (puppeteer, same harness/session helpers as the
rest of the file). It asserts three things together so the fix cannot be gamed:

1. **Hit area** — `>= 44x44` and genuinely hit-testable at its own four edge midpoints via
   `elementsFromPoint`, so a padded box that another node covers still fails.
2. **Visual density preserved** — the stop dot keeps its `8x8` box and the label keeps its
   token font size (`<= 13px`). The repair may only grow the target, never the glyph or label.
3. **No layout overflow** — `#live-topbar` gains no horizontal scroll and the capsule stays
   inside `#stage-pane`, so the target cannot be bought by pushing the capsule past the stage.
   Stop also stays enabled.

RED output, both viewports, reproducing the reported defect exactly:

```
{ "actual": "66x28", - "h": true, + "h": false, "w": true }
(fail) 1244x836 live: #btn-live-stop meets 44px without inflating its glyph
(fail) 1440x900 live: #btn-live-stop meets 44px without inflating its glyph
 0 pass / 2 fail
```

### GREEN — `tdd/green-proof.txt`

```
(pass) 1244x836 live: #btn-live-stop meets 44px without inflating its glyph
(pass) 1440x900 live: #btn-live-stop meets 44px without inflating its glyph
 2 pass / 0 fail / 16 expect() calls
```

## The change

`public/caret-operator.css` only. Four token-consistent edits, no new tokens, no magic numbers
— the existing `--cf-target-min: 44px` token replaces the hardcoded `28px`/`36px` literals:

| Rule | Before | After |
| --- | --- | --- |
| `body .live-topbar__stop` | `min-height: 28px` | `min-height/min-width: var(--cf-target-min)` + `justify-content: center` |
| `body .live-topbar__capsule` | `min-height: 36px` | `min-height: var(--cf-target-min)` |
| `.app[data-shell="live"] #btn-live-stop` | `min-block-size: 28px` | `min-block-size/min-inline-size: var(--cf-target-min)` + `justify-content: center` |
| `.app[data-shell="live"] .live-topbar__capsule` | `min-block-size: 36px` | `min-block-size: var(--cf-target-min)` |

Both the base and the `[data-shell="live"]` rule sets were updated so the control is correct
regardless of which one wins. The capsule floor rises with it purely so it *contains* the
44px target; it adds no chrome of its own. `justify-content: center` keeps the unchanged
glyph+label pair optically centred inside the now-taller box rather than letting the growth
read as left-weighted padding.

Nothing else changed: no glyph size, no font size, no padding-inline, no colour, no radius,
no border. Measured result is **66x44** — the width was already compliant, only the block
axis moved.

### Design-system compliance

- Every value references an existing token (`--cf-target-min`, `--cf-space-3`, `--cf-space-2`).
- Zero hardcoded magic numbers introduced; two hardcoded literals (`28px`, `36px`) **removed**.
- The `@media (max-width: 375px)` block that previously forced `--cf-target-min` on this
  control is now redundant but harmless and was left untouched (out of scope; narrow widths
  re-verified green below).

## Verification

All suites run on this machine, real Chromium, single run each.

| Suite | Result | Evidence |
| --- | --- | --- |
| `public-caret-accessibility` (full) | **105 pass / 0 fail** | `tests/a11y-full.txt` |
| `public-caret-library` + `public-caret-live` | **76 pass / 0 fail** | `tests/library-live.txt` |
| `public-operator-surface` + `public-caret-context` | **55 pass / 0 fail** | `tests/operator-context.txt` |
| `public-active-shell` + `public-shell` + `public-dom-protocol-contract` | **43 pass / 0 fail** | `tests/active-shell-contract.txt` |
| narrow-width target scan (320/375, both shells) | **4 pass / 0 fail** | `tests/narrow-targets.txt` |

The full accessibility run includes the just-added Start focus-handoff tests
(`Todo 15 · user-started capture focuses the visible Stop control`, 5 tests) — all pass, so the
handoff, the browser-only Start / native Stop boundary, and the no-focus-steal rules for
server-originated capture, hydration, reconnect and open dialogs are all preserved.

### Real Chromium keyboard/focus QA — `manual-keyboard-qa.json`

Driver: `manual-keyboard-qa.driver.ts`. No synthetic `.click()`, no sleeps; every awaited state
is armed with a `MutationObserver` before its trigger and bounded by a named timeout.

Operator TABs to Start with real `Tab` keys (7 presses), presses real `Enter`, and the run reads
the authoritative state after the live frame arrives. Both viewports **PASS**:

| Probe | 1244x836 | 1440x900 |
| --- | --- | --- |
| outbound command | `startCapture` | `startCapture` |
| focus after Start | `btn-live-stop` | `btn-live-stop` |
| `:focus-visible` / ring | true / `2px` | true / `2px` |
| accessible name | `녹음 중지` | `녹음 중지` |
| **Stop target px** | **66x44** | **66x44** |
| edge hit-test misses | none | none |
| glyph px (density guard) | 8x8 | 8x8 |
| label font-size | 12px | 12px |
| topbar / root overflow | 0 / 0 | 0 / 0 |
| capsule within stage | true | true |
| Enter on focused Stop | `stopCapture` | `stopCapture` |

### Screenshots — `screenshots/`

`live-stop-1244x836.png`, `live-stop-1440x900.png` (full page) and
`live-topbar-closeup-{w}x{h}.png` (topbar clip). Inspected: the Stop pill reads at its original
visual weight — same dot, same label size, same colour — inside a capsule that grew from 36px
to 54px. Timer, separator and stage framing are unchanged; no crowding, clipping, or overflow
at either width.

### Static checks

- `git diff --check` → exit 0 (`git-diff-check.txt`, `git-diff-check-exit-status.txt`). Both
  changed files are untracked in this working tree, so no tracked hunks exist for them; a direct
  trailing-whitespace audit of the edited regions is clean. The trailing whitespace elsewhere in
  `caret-operator.css` is pre-existing and untouched.
- LSP diagnostics on `tests/public-caret-accessibility.test.ts`: one pre-existing unrelated hint
  (`CAPTURE_STOPPING` declared but unused). No errors.
- LSP for CSS unavailable (biome not installed); CSS is validated by the real-browser suites.

## Scope

Touched only `public/caret-operator.css` and `tests/public-caret-accessibility.test.ts`.
Plan, ledger and the F1 checkbox were not edited. F2–F4 not entered. No commits. Unrelated
dirty work in the tree left untouched.

**Terminal result: PASS.**
