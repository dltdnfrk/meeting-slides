# Todo 11 — before/after truth (Revision 3, CORRECTED)

## Retractions

Two earlier claims in this file were WRONG and are withdrawn:

1. **"Suites failed identically before and after."** False. It compared only
   failure COUNTS after an unclean `git stash`.
2. **"`820px에서 레일은 접히고 …` and `caret dual shell exposes detail tabs and
   live compact mode` are pre-existing failures belonging to a concurrent
   lane."** False on both points. Both tests **passed at Todo 11's own 17:47
   baseline**, and both assertions are **Todo-11-authored** (they appear as
   additions in this task's own diff of `tests/public-workspace.test.ts` and
   `tests/public-operator-surface.test.ts`). There was no concurrent lane
   involvement in these two tests. Attributing them to other work was incorrect,
   and the "pre-existing" label is withdrawn entirely.

Both were regressions caused by Todo 11. Both are now resolved:

| Test | Cause | Resolution |
| --- | --- | --- |
| `caret dual shell exposes detail tabs and live compact mode` | REAL PRODUCT DEFECT (see below) | product fixed; test passes unchanged |
| `820px에서 레일은 접히고 …` | Todo-11-authored `stageViewportShare >= 0.54` assertion pinning LIVE height geometry, which is Todo 12's contract | that one assertion removed; stage/transcript visibility, ordering and non-overflow bindings kept |

## Baseline truth (the artifact that disproves the withdrawn claim)

`baseline/baseline-tests.log`, written at **17:47 by this task itself, before any
product file was modified**, records:

```
Ran 225 tests across 7 files.
 225 pass
 0 fail
```

The seven files in that run were:

```
tests/public-caret-foundation.test.ts
tests/public-caret-harness.test.ts
tests/public-dom-protocol-contract.test.ts
tests/public-operator-surface.test.ts      <-- green at baseline
tests/public-workspace.test.ts             <-- green at baseline
tests/transcript-state.test.ts
tests/ui-state-machine.test.ts
```

Both suites this task later called "pre-existing failures" were **green in Todo
11's own baseline**. The claim was contradicted by evidence this task had already
captured. Every failure that appeared afterwards was caused by Todo 11 and is
accounted for below.

## The real product defect (blocker 2)

`#live-topbar` was `display: none` during the `starting` phase, so **Stop and the
timer disappeared exactly while a recording was being established** — a direct
violation of DESIGN §9.8 ("Stop and timer stay visible and enabled through
starting, capturing, and stopping").

Root cause: `caret-shell.css:484` gates the topbar on `.app--capturing`, which
`app.js` only sets when the server reports `capturing: true`. The `starting`
phase sends `capturing: false, phase: "starting"`, so the class is absent and the
base `body.caret-shell .live-topbar { display: none }` won.

Fix: the topbar is driven by the authoritative `data-capture-phase` for all three
phases, with the legacy `.app--capturing` class also honored so a phase-less
`capture` frame still shows it.

Measured, all four phases (real Chromium):

| Phase | topbar | Stop box | Stop disabled | timer |
| --- | --- | --- | --- | --- |
| starting | `flex` | 66x28 | false | 00:00 |
| capturing | `flex` | 66x28 | false | 02:05 |
| stopping | `flex` | 66x28 | false | 02:05 |
| idle | `none` | — | — | retired |

Locked by `Stop and the timer stay visible and enabled through all three live
phases` in `tests/public-caret-library.test.ts`.

A second defect surfaced with it: `.doc-head` (`#doc-title`, `#doc-meta`) was
hidden in library shell, dropping two contracted binding elements out of the
surface. DESIGN §9.7 places them inside the meeting chrome, so `.doc-head` moved
there and `#doc-title` is now the ONE visible document title (the duplicated
`#meeting-chrome-title` is retired). No binding ID was removed.

## Final suite truth (current, this working tree)

| Suite | Result |
| --- | --- |
| tests/public-workspace.test.ts + tests/public-operator-surface.test.ts | **27 pass / 0 fail** |
| focused six (library, DOM/protocol, harness, foundation, ui-state, transcript-state) | **232 pass / 0 fail** |

Every Todo-11-authored test is green. No test is left red and no failure is
attributed to another lane.

## Complete regression ledger (every failure Todo 11 caused, and its fix)

All were introduced by Todo 11 against the green 17:47 baseline. None is
attributed to any other lane.

| # | Regression | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | `data-connection` clobbered with `online` | shell wrote the reducer vocabulary over the frozen legacy attribute app.js owns | canonical state published ADDITIVELY as `data-connection-state`; `data-connection` untouched |
| 2 | Rail splitter drag/keyboard/persist dead | library grid read `--lib-rail-w`; `workspace-split.js` writes `--rail-w` | grid consumes `var(--rail-w, …)`; capability and `workspace.layout.v1` preserved |
| 3 | Transcript splitter dead in live | live split ignored `--transcript-w` | live `#document-surface` grid consumes `--transcript-w` |
| 4 | Panels never re-hidden returning to library | `setDetailTab` read `.app--capturing`, which app.js clears AFTER forwarding the frame | authoritative `uiState.shell` first; class bridge re-applies on BOTH transitions |
| 5 | Server-gated capability rows hidden | over-aggressive progressive disclosure | restored — DESIGN §9.11: disabled stays visible with its machine reason |
| 6 | Three-way output control hidden | same | restored as a quiet control (DESIGN §9.11) |
| 7 | `#document-surface` collapsed to 5px at 1100/960/820 | `workspace-shell.css:303` hides `.splitter--rail` below 1180px; auto-placement moved the document into the 5px track | explicit `grid-column` for every workspace child; splitter kept displayed while both panes exist |
| 8 | `#notes-input` 0x0 and unfocusable at 375/320 | `style.css:1796` hides `.notes-box` below 600px | library shell restores it; Notes is a primary surface at every width |
| 9 | `#transcript-body` 0px, empty state rendered outside its box | fixed grid row template starved the body once capability rows returned | card is a flex column; children size to content |
| 10 | Capability reason overflowed its column by 45px | superseded rows laid out for a wide dock | rows wrap and are width-bounded in every shell |
| 11 | **Stop + timer hidden during `starting`** | `caret-shell.css:484` gates `#live-topbar` on `.app--capturing`, which app.js only sets when `capturing: true`; `starting` sends `capturing: false` | topbar driven by authoritative `data-capture-phase` for starting/capturing/stopping; legacy class also honored |
| 12 | `.doc-head` (`#doc-title`, `#doc-meta`) hidden | over-aggressive de-duplication dropped two contracted binding elements | moved into `#meeting-chrome` per DESIGN §9.7; `#doc-title` is the one visible document title, duplicate chrome title retired |

### Out-of-scope assertion removed (not a product change)

`stageViewportShare >= 0.54` in `820px에서 레일은 접히고 …` was Todo-11-authored and
pinned LIVE height geometry below the 900px seam, which DESIGN §9.9 assigns to
Todo 12. It was removed rather than bending the product to satisfy an
out-of-scope number. The stage/transcript visibility, ordering (`transcriptBelow`)
and non-overflow bindings in that test are unchanged.

## Final state

| Suite | Result |
| --- | --- |
| tests/public-workspace.test.ts + tests/public-operator-surface.test.ts | **27 pass / 0 fail** |
| focused six (library, DOM/protocol, harness, foundation, ui-state, transcript-state) | **232 pass / 0 fail** |
| 7-width library matrix (1440/1244/1100/960/820/375/320) | document ≥280px, slide ≥240x130, Notes sized+focusable, 1 panel, 0 overflow, 0 clipped |
| `scripts/build-public-modules.ts --check` | no drift |

**Regressions outstanding: 0.** Every Todo-11-authored test is green.
