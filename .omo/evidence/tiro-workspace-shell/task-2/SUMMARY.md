# tiro-workspace-shell — todo 2 evidence

**Goal:** drag-resizable vertical splitters between `left|center` and `center|right`
workspace panes, with min widths, viewport clamping, and `localStorage` persistence.

Parent: `4347227` (three-pane shell). Worktree: `meeting-slides-worktree-tiro-shell`.

## What changed

| File | Change |
|---|---|
| `public/workspace-split.js` (new) | Pointer-capture drag on both splitters → writes `--rail-w` / `--transcript-w` on `#workspace`; clamps; persists `workspace.layout.v1`; restores on load; re-clamps on window resize. |
| `public/index.html` | Two `role="separator"` handles between the panes; loads `/workspace-split.js` before `app.js`. |
| `public/workspace-shell.css` | Grid becomes 5 tracks (pane / splitter / pane / splitter / pane); `--splitter-w` + `--splitter-grab` tokens; hover/active rule uses `--live`; drag-state cursor lock; media queries hide the matching handle when a pane collapses. |
| `tests/public-workspace.test.ts` | 7 new hermetic Puppeteer tests (drag delta, mins, persistence, reload restore, corrupt-value fallback) + todo-1 order assertion now filters splitters. |

`public/app.js` untouched — no id it queries moved.

## Design system compliance

Extends before using, per the todo-1 layer:

- New tokens `--splitter-w` (5px visible track) and `--splitter-grab` (9px pointer hit area) join the existing `--rail-w`/`--transcript-w` geometry vars in `:root`.
- Splitter rule colors reuse the existing divider alpha (`rgba(255,255,255,0.06)`, same value as `--rule`) and the accent `--live` for hover/active; transitions use `--ease-smooth`.
- Zero new hex literals, zero one-off font sizes, zero magic spacing — the module only writes the two geometry variables, never inline pane widths.

## Behavior

- Min widths enforced in one `clamp()`: left ≥ 180, right ≥ 240, center ≥ 320.
- When both sides would starve the stage, the overflow is reclaimed proportionally from each side's slack, so the hero never drops below 320px.
- Preferred (stored) widths are kept in memory and re-clamped on resize, so shrinking then re-widening the window restores the user's chosen widths instead of freezing the collapsed ones.
- Corrupt/absent `workspace.layout.v1` falls back to the CSS defaults; `localStorage` write failures are non-fatal.

## Measured (1440x900, `measurements.txt`)

```
default:     rail 232 | stage 878 | transcript 320 | stored null
after-drag:  rail 352 | stage 638 | transcript 440 | stored {"leftPx":352,"rightPx":440}
after-reload:rail 352 | stage 638 | transcript 440 | restored from storage
min-clamped: rail 180 | stage 1010 | transcript 240 | mins hold under -600/+600 drags
```

## Verification

- `bun test tests/public-workspace.test.ts tests/public-shell.test.ts tests/public-compile-control.test.ts` → 19 pass / 0 fail (`tests-public.txt`)
- `bun test` (full suite) → 113 pass / 0 fail (`tests-full.txt`)
- `bunx tsc --noEmit` → clean
- `git diff --check` → clean

No fixed sleeps in tests: layout settling is awaited via a bounded rAF poll of
`getBoundingClientRect` widths (two identical frames = settled, 2s deadline).

## Screenshots

- `splitters-default.png` — stored key absent, CSS defaults
- `splitters-dragged.png` — both splitters dragged outward
- `splitters-restored.png` — after reload, widths restored from `localStorage`
- `splitters-min-clamped.png` — sides clamped to their minimums

## Out of scope (per plan)

Transcript WS wiring (todo 3), `listMeetings` rail data (todo 4), and keyboard
resize (explicitly optional) are absent.
