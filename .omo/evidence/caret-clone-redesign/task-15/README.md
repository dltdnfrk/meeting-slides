# Task 15 — Complete accessibility, motion, and failure states

Plan: `.omo/plans/caret-clone-redesign.md`, Todo 15 (Wave 4).
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`. No commit, no staging, no reset.

## What this task changed, and why

Every change below closes a defect that a test failed on FIRST (RED), and every
fix is the smallest one that makes the contract true.

### Browser — announcement discipline (DESIGN 9.12)

| Defect (RED) | Fix |
| --- | --- |
| `#live-topbar-timer` carried `aria-live="polite"`, so the per-second timer flooded the announcement queue and drowned the transcript beside it. The contract says the timer is *never* a live region. | Removed `aria-live`; added `aria-label="녹음 경과 시간"` so the value stays readable on demand. |
| `.glance` was a container-level `aria-live="polite"` wrapping the slide count, the sentence count and the provider name, so ONE transcript line re-announced all three — the duplicate noise 9.12 forbids. | Removed the container live region. The state it showed is announced once by the status region. |
| `#status-text` was not a live region at all. `renderStatus()` is the only surface carrying connection loss, capture failure, export failure and save completion, so every one of those was silent to a screen reader while visible on screen. | `role="status" aria-atomic="true"` on `#status-text` itself — scoped to the sentence, not the strip, so the settings button beside it never becomes announceable content. |
| Finalized transcript lines announced through zero live regions. | `role="log" aria-atomic="false"` on `#transcript-stream`: the polite shape for an append-only stream, announcing only the added line. The provisional caption (`#caption-text`) stays outside it and is never announced. |
| `#status-indicator` was a colour-only dot. | `aria-hidden="true"`: it is decoration for the sentence beside it, which carries the same status as text (9.12 "status is never colour-only"). |

### Browser — motion (DESIGN 9.6)

| Defect (RED) | Fix |
| --- | --- |
| Reduced motion in `caret-operator.css` was scoped to `[data-shell="library"]`, so entering the LIVE shell silently restored every transition and animation. | Deleted the per-shell rule. Reduced motion is now handled once, unscoped, in `caret-shell.css`, covering both shells and `::before`/`::after`. |
| `caret-shell.css` used `transition-duration: 0.01ms` and did not touch animations at all, so motion was imperceptibly short rather than stopped, could never be verified by a computed-style audit, and every keyframe animation kept running. | `0s` duration AND delay for transitions and animations, `animation-iteration-count: 1`, `scroll-behavior: auto`. State, timer and focus still change instantly. |
| Three transitions exceeded the approved 200ms budget: `--motion-state: 220ms`, `.status__indicator` 300ms, `.island` 300ms. | 200ms token; the two tone swaps moved to the 150ms press/focus/hover row. |

### Browser — targets, occlusion and narrow-width failure legibility

| Defect (RED) | Fix |
| --- | --- |
| `.session-delete` was 32x32 — a real WCAG 2.2 AA target-size violation at EVERY width. Todo 13's audit missed it because an un-hovered row paints it at `opacity: 0`. | New `--cf-target-min: 44px` foundation token; the control's box is the token, the glyph keeps its 32px square. |
| The 44px control was centred on `.session-item`, which is one hairline taller than `.session-row`, so its hit area hung above the row it acts on. | Centred on the row via `inset-block-start: 50%` + `translateY(-50%)`. |
| The row's `padding-inline-end` reserve was declared in an earlier block and silently reset by the `padding:` shorthand in the row's own rule, leaving a 12px reserve under a 44px control: a long Korean title ran 29px underneath the delete button. | Reserve moved INSIDE the shorthand's rule, sized `calc(--cf-target-min + --cf-space-1)` to account for the control's own end inset. |
| At 375 and 320 the superseded rule `.topbar__status > :not(#btn-settings) { display: none }` hid the status sentence, so a dropped connection left NO visible or announced trace — only `data-connection`. | Status text restored and bounded (ellipsis, `title` keeps the full text) below 420px. The topbar grid sizes its outer tracks to content and `.topbar__right` stretches to its own track, so restoring the sentence does not let it paint over `#btn-attendees`. |

### Native (macOS minibar)

| Defect (RED) | Fix |
| --- | --- |
| `MinibarWindowController.render()` runs on a **one-second timer** and republished the AX status label on every tick, so VoiceOver spoke "녹음 중" once per second forever. | The decision moved into the pure layer: `MinibarAccessibility.announces` is true only when the announcement differs from the last one spoken. `MinibarProjection.render(...)` commits it; `view(...)` stays pure. The AppKit shell posts `.announcementRequested` at `medium` (polite) priority only when `announces` is true. |
| An error flipped the status with no actionable reason attached. | The announcement carries the machine reason: `오류 — <reason>`. A repeated identical failure does not announce twice; recovery announces once. |
| Controls carried a name but no reason, so a disabled Stop was an unexplained dead target. | `MinibarControlState.help` is non-empty for every control and names the exact condition (reconnecting, connecting, stopping, switching model, error, nothing to stop). Published as `setAccessibilityHelp`. |
| All three native suites shared a latent 5s `beforeAll` bound covering two `swiftc` runs plus a driver run; they failed on toolchain scheduling when run together (a pre-existing flake, reproduced at baseline). | Explicit `120_000` bound on the three hooks. It bounds real work — nothing sleeps or polls, and a genuine hang still fails. |

## Files changed

Product:
- `public/index.html` — live-region topology only (timer, glance, status, transcript stream, indicator).
- `public/style.css` — motion tokens (`--motion-state`, `.status__indicator`, `.island`).
- `public/caret-shell.css` — the single complete reduced-motion rule.
- `public/caret-operator.css` — 44px delete target, row reserve, narrow status legibility, narrow topbar tracks; removed the per-shell reduced-motion rule.
- `public/caret-foundation.css` — added `--cf-target-min`.
- `macos/MinibarProjection.swift` — `announces`, `render(...)`, announcement text, control `help`.
- `macos/MinibarView.swift` — polite announcement post, `setAccessibilityValue`, `setAccessibilityHelp`.
- `macos/MinibarWindowController.swift` — `render(...)` instead of `view(...)`.

Tests / harness:
- `tests/public-caret-accessibility.test.ts` — NEW, 83 tests.
- `tests/native-minibar.test.ts` — three announcement/control-AX tests + driver scenarios.
- `tests/fixtures/native-minibar-driver.swift` — `announcements` and `controlAccessibility` scenario kinds.
- `tests/public-test-harness.ts` — `pushRaw()` so a suite can send a frame that is not parseable at all.
- `tests/native-surface-contract.test.ts`, `tests/native-launcher-boundary.test.ts` — hook bound only.

## Commands run (all from the canonical root)

```
bun test tests/public-caret-accessibility.test.ts                      # 83 pass
bun test <7 caret + contract suites>                                   # 278 pass
bun test <7 legacy public suites>                                      # 73 pass
bun test tests/native-*.test.ts                                        # 123 pass
bun run .omo/evidence/caret-clone-redesign/task-15/driver/capture.ts   # 126 cells, 0 defects
bun run scripts/build-public-modules.ts --check                        # no drift
npx tsc --noEmit -p tsconfig.json                                      # clean
npx tsc --noEmit --strict ... <changed test files>                     # clean
swiftc -typecheck -swift-version 5 macos/*.swift                       # clean
git diff --check                                                       # clean
```

## Visual QA matrix

`green/qa/` holds 126 cells: 9 viewports (1440/1244/1100/960/900/899/820/375/320)
x normal + reduced motion x 7 states (library, live, loading, empty, error,
reconnect, compile). Each cell has a same-size PNG, a Chromium AX snapshot, and a
machine record (motion, live regions, targets, overlap, contrast, overflow).
`green/qa/index.json` reports **0 defects**.

Deterministic: frozen clock `1710376860000`, `ko-KR`, `Asia/Seoul`,
`deviceScaleFactor: 1`, local harness only, no off-origin request.

## Adversarial probes (all covered by passing tests)

missing aria linkage; duplicate live announcement; hidden focus under reduced
motion; 43px target; contrast drop; reduced-motion state loss; stale error;
malformed payload (both an invalid body and unparseable JSON via `pushRaw`);
repeated transitions; network block (`disconnectClients`); cleanup.

## Two driver corrections worth recording

The capture driver's first two runs reported defects that were **artifacts**, and
both were verified against the real DOM before being dismissed:

1. Scrolling each control into view *between* measurements made every rect refer
   to a different scroll position, so controls 8px apart reported a 29px overlap.
   Fixed by measuring in one pass.
2. An ancestor-walk counted the collapsed `<details>` export set as painted (it
   has no `display: none` anywhere on its chain yet reports a full rect), so eight
   hidden buttons appeared to overlap the Overview card. Fixed with
   `checkVisibility`.

The occlusion audit in the test suite scrolls each control into view *before*
hit-testing, because DESIGN 9.12 explicitly allows a short viewport to keep
controls reachable by scrolling; only what remains after scrolling is occlusion.

## Pre-existing failures (NOT caused by this task, not fixed here)

`tests/public-attendees.test.ts` — 5 failures. Reproduced at baseline with
`public/index.html` and `public/style.css` reverted to HEAD, confirming they
predate this task. Recorded in `green/preexisting-attendees-failures.txt`.
They concern `startCapture`/`listMeetings` ordering and a reconnect restore
query, none of which this task touches.

## Cleanup

Temporary Swift build dirs, probe scripts and file backups removed. No stray
Chromium or Bun process. `Meeting Slides.app` and `Meeting Slides 2.app`
symlinks and the installed bundle are untouched (bundle executable mtime
`Aug 9 23:15`, predating this task; `scripts/build-app.sh` was never run).
