# tiro-workspace-shell — todo 1 evidence

**Goal:** restructure the public UI into a Tiro-style three-pane workspace shell
(left `.session-rail` | center `.stage-pane` hero | right `.transcript-pane`),
preserving the existing visual-materials stage and the bottom dock.

Baseline: `4a0b40a` (ppt-harness complete). Worktree: `meeting-slides-worktree-tiro-shell`.

## What changed

| File | Change |
|---|---|
| `public/index.html` | Wrapped stage in `.workspace` grid; added `.session-rail` + `.transcript-pane` shells; linked `workspace-shell.css`. Dock left untouched, below the workspace. |
| `public/workspace-shell.css` (new) | Three-column grid layout layer on top of the existing zinc/live token set. |
| `tests/public-workspace.test.ts` (new) | Hermetic Puppeteer structure/geometry assertions. |

`public/app.js` was **not** modified — every id it queries (`#current-slide`,
`#slide-frame`, `#island`, dock buttons, …) kept its identity, only its ancestor
changed.

## Design system compliance

Phase 1 audit of `public/style.css` found: zinc scale `--z950..--z100`, accents
`--live/--warn/--err`, `--ease-smooth`, `--font-display/body/mono`, BEM naming —
but **no spacing or radius tokens** (raw px throughout).

Rather than adding one-off magic numbers, `workspace-shell.css` **extends** the
system before using it:

- `--rail-w`, `--transcript-w` — pane geometry as a single source the todo-2 splitters will write to
- `--sp-1..--sp-5` — 4px-grid spacing scale
- `--radius-sm/--radius-md`, `--rule`, `--rule-strong` — shell radii and divider rules

All colors and fonts reference existing tokens; no hardcoded hex in the new file.

## Verification

- `bun test tests/public-workspace.test.ts tests/public-shell.test.ts tests/public-compile-control.test.ts` → 12 pass / 0 fail (`tests-public.txt`)
- `bun test` (full suite) → 106 pass / 0 fail (`tests-full.txt`)
- `bunx tsc --noEmit` → clean
- `git diff --check` → clean

Measured geometry at 1440x900: rail 232px @ x=0, stage 888px @ x=232,
transcript 320px @ x=1120, dock 1440x200 below — center hero is the widest slot.

## Screenshots

- `workspace-1440-empty.png` — three panes, placeholder stage, dock intact
- `workspace-1440-slide.png` — live MeetingCard rendering inside `.stage-pane`
- `workspace-1000-rail-collapsed.png` — rail collapses below 1180px, stage preserved

## Out of scope (per plan)

Splitter drag + persistence (todo 2), transcript WS wiring (todo 3), and
`listMeetings` (todo 4) are deliberately absent. The right pane and session list
are static shells; `--rail-w`/`--transcript-w` exist so todo 2 can drive them
without further DOM churn.
