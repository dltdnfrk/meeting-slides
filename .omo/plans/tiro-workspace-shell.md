# tiro-workspace-shell

## TL;DR (For humans)
Tiro-style notetaker workspace shell: left sessions rail, center visual-materials stage (live slides / compiled deck), right docked transcript panel. All pane boundaries mouse-resizable with persisted sizes. No floating-only SE-handle transcript.

## Intent
- **intent:** clear
- **review_required:** false
- **delivery:** direct (task worktree)
- **baseline:** ppt-harness HEAD `4a0b40a`

## Must-Have
1. Three-pane workspace: **Sessions | Visual stage | Transcript**
2. Center pane is the Tiro "hero" slot → **visual materials** (existing MeetingCard / slide stage / compiled deck view), NOT a calendar dashboard
3. Vertical splitters (left|center, center|right) drag-resizable; widths persisted in `localStorage`
4. Transcript is a **docked right panel** (not center-covering float-only); multi-edge resize at least **W + S + SW** (west edge primary for width); optional undock later out of scope
5. Left rail shows session list skeleton; wire `listMeetings` when store supports it (add WS + store query if missing)
6. Preserve existing live slide WS behavior, dock controls, compile/export actions
7. Hermetic Puppeteer tests for layout presence, splitter drag changing widths, transcript panel width drag, center still renders MeetingCard
8. No minutes-bundle changes; no model HTML; no live multi-kind thrash

## Must-NOT-Have
- Fake Tiro clone pixel-perfect brand theft
- Full channel/thread product (P0 = sessions list only)
- Breaking ppt-harness compile/export
- Orchestrator editing product files (workers only)

## Todos

- [x] 1. Workspace shell DOM + CSS three-pane layout
  - Recommended task executor category: visual-engineering
  - Files: `public/index.html`, `public/style.css`, maybe `public/workspace-shell.css`
  - What: Restructure shell into `.workspace` with `.session-rail`, `.stage-pane` (contains existing stage/slide root), `.transcript-pane`. Move current center stage markup into `.stage-pane`. Keep bottom dock. Empty states: left "세션", center existing placeholder, right "전사".
  - Acceptance: DOM contains three panes; visual stage still mounts `#stage` / existing slide root; no JS behavior break for static load.
  - QA: hermetic open index.html or static server; assert three pane selectors + stage child exists.
  - Commit: `feat(ui): add tiro-style three-pane workspace shell`

- [x] 2. Splitter resize + localStorage persistence
  - Recommended task executor category: visual-engineering
  - Files: `public/workspace-split.js` (new), `public/index.html`, CSS
  - What: Drag handles between left-center and center-right. Pointer events, min widths (left≥180, right≥240, center≥320), clamp to viewport, persist `workspace.layout.v1` `{leftPx,rightPx}`. Keyboard optional skip.
  - Acceptance: drag changes pane widths; reload restores; mins enforced.
  - QA: Puppeteer pointer drag on splitter; measure getBoundingClientRect widths before/after; reload assert restore.
  - Commit: `feat(ui): resizable workspace splitters with persistence`

- [x] 3. Dock transcript panel with multi-edge resize
  - Recommended task executor category: visual-engineering
  - Files: `public/app.js` or `public/transcript-panel.js`, CSS, index.html
  - What: Right pane hosts live transcript feed (migrate from any overlay-only UX). Width via west splitter (todo 2); internal panel supports **S and SW** resize for height if transcript is a sub-card, OR full-height pane. If overlay exists on main only, implement docked panel in this branch from feed lines already in app. Must not block center stage.
  - Acceptance: transcript lines still append on WS `line`/`transcript`; panel width/height adjustable beyond SE-only; stage remains visible.
  - QA: inject WS line events; assert DOM in `.transcript-pane`; drag west edge width delta > 20px.
  - Commit: `feat(ui): dock transcript panel with multi-edge resize`

- [x] 4. Session rail listMeetings API + UI skeleton
  - Recommended task executor category: deep
  - Files: `src/store.ts`, `server.ts`, `public/app.js`, tests
  - What: Add `listMeetings()` (id, title, started_at, status) if missing; WS action `listMeetings` → `{type:"meetings", items:[]}`; left rail renders list; click selects (highlight) — opening historical playback can stub with status toast if out of scope, but live row shows current.
  - Acceptance: empty DB → empty state; after save/session → list non-empty via WS; no crash.
  - QA: unit store + WS hermetic test.
  - Commit: `feat(sessions): listMeetings rail and store query`

- [x] 5. Wire center visual materials + regression lock
  - Recommended task executor category: visual-engineering
  - Files: `public/app.js`, shell CSS, tests
  - What: Ensure slide/MeetingCard render targets center `.stage-pane` only; thumbnails/history stay usable; compile/export dock buttons still work; responsive ≤900px stacks or collapses left rail without destroying stage.
  - Acceptance: existing public-shell MeetingCard tests pass; new workspace tests pass; full suite green.
  - QA: run public-shell + new workspace tests + full bun test.
  - Commit: `fix(ui): keep visual stage in center pane under workspace shell`

- [x] 6. Hermetic workspace E2E + evidence
  - Recommended task executor category: deep
  - Files: `tests/public-workspace.test.ts`
  - What: One hermetic suite: load app → three panes → splitter drag → transcript dock receives line → MeetingCard still renders in center → layout persist roundtrip. Screenshots to evidence.
  - Acceptance: tests pass without sleeps (event/MutationObserver waits); evidence dir written.
  - Commit: `test(ui): hermetic tiro workspace shell e2e`

## Final Verification Wave

- [x] F1. Plan compliance audit
  - Recommended task executor category: deep
- [x] F2. Code quality (LOC, no slop, no any)
  - Recommended task executor category: deep
- [x] F3. Real manual QA (browser workspace + resize + transcript + slide)
  - Recommended task executor category: deep
- [x] F4. Scope fidelity (no minutes-bundle, main dirty preserved)
  - Recommended task executor category: quick

## Notes
- Center pane = Tiro "오늘 미팅을 한눈에" slot → **visual materials**
- Base on ppt-harness work so MeetingCard + compile remain available
