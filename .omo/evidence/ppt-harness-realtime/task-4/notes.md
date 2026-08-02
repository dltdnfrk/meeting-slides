# Notes — task 4

## Scope delivered
- `public/app.js` `slideHtml`: renders live MeetingCard — index badge + optional `kicker` on one meta row,
  required `title`, accent rule, `bullets` (list omitted when empty), optional `emphasis` callout.
  All text passes through the existing `escapeHtml` helper.
- `public/style.css`: added `.slide__meta`, `.slide__kicker`, `.slide__emphasis`, `.slide__emphasis-label`
  using existing design tokens only (`--font-mono`, `--live`, `--live-soft`, `--z100`). Extended the v2 wide
  redesign block and the <=420px block with matching scale/stacking. No new colors, no dock/overlay changes.
- Single live layout preserved: one card template regardless of content (kinded layouts remain compiler-only).

## Legacy compatibility
- `kicker`/`emphasis` are read defensively (`typeof === "string"` + trim), so pre-MeetingCard payloads
  (title + bullets only) render exactly as before. Covered by the "레거시 슬라이드" test.
- Empty `bullets` no longer emits an empty `<ul>`.

## Tests (tests/public-shell.test.ts, 7 tests / 26 assertions)
Hermetic: a Bun server serves `public/` and a stub `/ws` that pushes scripted `type:"slide"` payloads;
Puppeteer (already a devDependency) loads the real page. No fixed sleeps — renders are awaited via an
in-page MutationObserver installed before each push, and the WS push waits on the server-side `open` event.
Cases: placeholder retained with `current: null`; full card fields (index/kicker/title/bullets/emphasis,
kicker in the meta row, title left edge aligned with bullets); no horizontal spill inside the card at 375px;
legacy card without kicker/emphasis; empty bullets; history preview uses the same card layout;
HTML injection in model text is escaped (no injected tags, no script execution).

Non-vacuity check: with `public/` reverted to the parent commit, 4 of the 7 tests fail.

## Pre-existing issue (not fixed here, out of todo-4 scope)
At 375px the document has ~146px horizontal scroll caused by the dock button row (`.dock__btn`),
reproduced identically on parent commit 3f46a17 before any change. The plan forbids dock redesign in
this todo, so the overflow assertion is scoped to the slide card subtree.

## Screenshots
- `wide-card.png` / `narrow-card.png` — kicker + emphasis at 1440px and 375px
- `wide-legacy.png` / `narrow-legacy.png` — legacy payload without kicker/emphasis
