# tiro-workspace-shell — todo 3 evidence

**Goal:** dock the live transcript into the right `.transcript-pane` with multi-edge
resize (W + S + SW), replacing any SE-only floating handle, without ever covering
the center visual stage.

Parent: `a615100` (splitters + persistence). Worktree: `meeting-slides-worktree-tiro-shell`.

## What changed

| File | Change |
|---|---|
| `public/index.html` | `.transcript-pane` now hosts `.transcript-card` (head + scrollable body + truncation notice) with S and SW grips. The duplicate bottom-dock transcript tab/panel is removed; the dock keeps history + all export/compile controls. |
| `public/app.js` | Render targets moved from `#feed-list`/`#feed-count`/`#feed-trunc` to the docked `#transcript-stream`/`#transcript-count`/`#transcript-trunc`, with the symbols renamed to match (`renderTranscriptLine`, `renderTranscriptBacklog`, `transcriptLineCount`, …); empty state is now a toggled `hidden` element instead of innerHTML churn; auto-scroll drives the pane body (`#transcript-body`), which is the real scroll container; dock tab switching + `h`/`f`/`1`/`2` shortcuts deleted along with the duplicate panel; reset now clears the stream through `renderTranscriptBacklog([])`. |
| `public/transcript-resize.js` (new) | Pointer-capture drag on S (height) and SW (height + width) grips → writes `--transcript-card-h` on the pane; clamps to `[160px, pane height]`; persists `workspace.transcript.v1`; restores on load; re-clamps on window resize. |
| `public/workspace-split.js` | Exposes a small `window.workspaceLayout` API (`transcriptWidth` / `setTranscriptWidth` / `persistTranscriptWidth`) so the SW grip reuses the existing width clamp + persistence instead of duplicating it. |
| `public/workspace-shell.css` | Transcript card + S/SW grip chrome, hatched slack when height-constrained, truncation notice, and a `≤900px` rule that stacks the transcript under the stage instead of hiding it. |
| `public/style.css` | Dead `.feed__list` / `.feed__empty` / `.feed__trunc` / `.dock__tab*` rules removed; single-item tablist replaced by a `.dock__label`. `.feed-line*` kept — the docked stream reuses it verbatim. |
| `tests/public-transcript-dock.test.ts` (new) | 13 hermetic Puppeteer tests. |

## Resize edges (the point of this todo)

| Edge | Handle | Effect |
|---|---|---|
| **W** | `#splitter-transcript` (todo 2) | pane width, clamped against the 320px stage minimum |
| **S** | `#transcript-grip-s` | card height only; width untouched |
| **SW** | `#transcript-grip-sw` | height *and* width together; width delegates to `workspaceLayout` so both paths share one clamp |

No SE-only floating handle exists (asserted: `.transcript-grip--se` is absent).
Default state is a full-height docked card — the height constraint is opt-in.

## Design system compliance

Extends before using, matching the todo-1/2 layer:

- New tokens: `--grip-h` (9px pointer band), `--grip-corner` (18px corner hit box),
  `--pane-surface` (the side-pane fill, previously an inline literal in two places —
  now declared once and referenced).
- Grip visuals speak the splitter's language: a 1px rule at `rgba(255,255,255,0.06)`
  (the `--rule` alpha) that turns `--live` on hover/focus/active, `--ease-smooth`
  transitions throughout.
- Spacing is `--sp-*` only, radii `--radius-*` only, colors token-based (`--warn`,
  `--live`, `--z*`). The amber pair in `.transcript-trunc` is the byte-identical
  move of the deleted `.feed__trunc` rule, not a new invention.
- Constrained state gets a faint 135° hatch so the slack below the card reads as
  intentional whitespace rather than a render fault.

## Behavior

- Card height clamps to `[160px, pane height]`; dragging back to full height clears
  the stored override so the card returns to "fills the pane".
- Preferred height is held in memory and re-clamped on window resize, same rule the
  splitter widths already follow.
- Corrupt/absent `workspace.transcript.v1` falls back to full height; `localStorage`
  write failures are non-fatal.
- `≤900px`: the pane no longer disappears (it would have orphaned the transcript now
  that the dock duplicate is gone) — the workspace becomes two rows, stage above,
  transcript below, grips hidden since height is no longer user-owned there.

## Measured (`measurements.txt`)

```
1440x900
empty:          transcript 320 | card 648/648 | stage 878x648 | lines 0 | stageHit true
docked-live:    transcript 320 | card 648/648 | stage 878x648 | lines 8 | outsidePane 0
south-drag:     transcript 320 | card 388/648 | stage 878x648 | stored {"heightPx":388}
southwest-drag: transcript 480 | card 478/648 | stage 718x648 | stored height 478 + width 480
after-reload:   transcript 480 | card 478/648 | stage 718x648 | both restored

820x900
narrow-820:     transcript 820 | card 247/248 | stage 820x400 | lines 8 | stageHit true
```

`after-reload` reports `lines 0` by design: it is a fresh page proving the *geometry*
survives reload. Transcript backlog restoration is the server's `transcript`/`snapshot`
message, covered separately by the backlog test.

`stageHitAtCenter` is an `elementFromPoint` hit test at the stage center — true in
every state, i.e. nothing floats over the stage. `linesOutsidePane` is 0 everywhere:
there is exactly one transcript surface.

## Verification

- `bun test tests/public-transcript-dock.test.ts tests/public-workspace.test.ts tests/public-shell.test.ts tests/public-compile-control.test.ts` → 32 pass / 0 fail (`tests-public.txt`)
- `bun test` (full suite) → 126 pass / 0 fail, up from 113 (`tests-full.txt`)
- `bunx tsc --noEmit` → clean
- `git diff --check` → clean

No fixed sleeps: line arrival is awaited via a MutationObserver armed *before* the WS
push (bounded 5s), layout settling via a bounded rAF poll of two identical frames.

## Screenshots

- `transcript-dock-empty.png` — empty state, card fills the pane
- `transcript-dock-live.png` — 8 live lines docked right, MeetingCard fully visible center
- `transcript-dock-south.png` — S drag: card 648→388, hatched slack below, stage untouched
- `transcript-dock-southwest.png` — SW drag: 480px wide × 478px tall, stage still 718px
- `transcript-dock-restored.png` — after reload, both dimensions restored
- `transcript-dock-narrow-820.png` — 820px: transcript stacked under the stage, not hidden

## Out of scope (per plan)

`listMeetings` rail data (todo 4), stage-in-center regression lock (todo 5), and the
consolidated workspace E2E (todo 6).
