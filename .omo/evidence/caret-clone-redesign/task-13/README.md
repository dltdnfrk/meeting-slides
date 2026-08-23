# Todo 13 — Re-home real contextual controls and panels (REVISED)

Evidence index. Every artifact is checksummed in `SHA256SUMS.txt`.
No screenshot-byte golden is used: every assertion reads machine geometry,
computed style, DOM state, an accessibility snapshot, or a real outbound
WebSocket frame.

**This revision repairs the four blockers raised by verifier `st_019ff102`.**

## Verifier blockers — status

| # | Blocker | Repair | Proof |
| --- | --- | --- | --- |
| 1 | Two Stop homes and two timers painted together in live | `.capture-pill` is `display: none` in the live shell only; `#btn-record` / `#capture-timer` keep their IDs, handlers and library roles | `green/stop-timer-matrix.json`: 12 states, every live state reports `stops:[btn-live-stop]`, `timers:[live-topbar-timer]` |
| 2 | 44px claimed but not delivered; false comment crediting the parent capsule | Real floors on `#btn-live-stop`, `#btn-settings`, `#btn-attendees`, library `#btn-record`, detail tabs and action-card buttons; the false comment is deleted and replaced with an accurate one | `green/green-context.log`, edge-band tests at 375/320 |
| 3 | Target test scoped to `DOCK_CAPABILITIES` only | New `readShellTargets` audits **every painted interactive shell control** at 375/320 in both shells, plus 11 new duplicate-Stop/timer tests across phases | 47 context tests (was 30) |
| 4 | `#btn-record` gave no machine reason when gated | `applyGate(btnRecordEl, …)` + `setControlPurpose` so the action label is restored on ungate | `green/adversarial.json` probe 8: 9/9 controls gated, painted, reason identical in both attributes |

### The false comment (blocker 2), verbatim

Removed from `.app[data-shell="live"] #btn-live-stop`:

> `28px is the visual pill; the 44px pointer target is met by the padded capsule
> row around it`

That credits a decorative parent with the child's target size. A pointer landing
on the capsule but outside the button does not stop the recording. The button now
carries its own 44px floor at `<=375px`, verified by an edge-band hit test rather
than a box-size claim.

## Measured before → after

| Residual / blocker | Before | After |
| --- | --- | --- |
| Library dock viewport share | `0.5` at 1440–820 | `0.207`–`0.245` |
| Disclosure set columns | 1 (110.5px) | 5–13, width-driven |
| User disclosure choice across `starting`→`capturing` | `false` | `true` |
| Perceivable Stop controls in live | **2** in all 9 live states | **1** in all 9 |
| Perceivable timers in live | **2** in capturing/stopping | **1** in all 9 |
| `#btn-live-stop` at 375/320 | 66x28 | >=44x44 |
| `#btn-settings` / `#btn-attendees` at 375/320 | 39x26 / 60x28 | >=44x44 |

## Tests

`tests/public-caret-context.test.ts` — **47 tests**, RED → GREEN.

| Phase | Result |
| --- | --- |
| RED, original 30-test suite | 8 pass / 22 fail (`red/red.log`) |
| RED, after adding the 17 blocker tests | 31 pass / **16 fail** (`red/red2.log`) |
| GREEN, final | **47 pass / 0 fail** (`green/green-context.log`) |

15-suite matrix (`green/green-all-suites.log`): **413 pass / 5 fail**, the 5 being
the pre-existing attendees baseline. Task-11/12 suites: 76 pass, unchanged by the
single-Stop rule.

Gates (`green/gates.log`): generated-module drift `ok`, `tsc --noEmit` exit 0,
`git diff --check` clean, LSP errors none on every changed file.

## Product defects found and fixed at the root

1. **Two Stop affordances and two clocks in live.** The dock's capture pill
   carried `#btn-record` (label flipped to "녹음 중지") and `#capture-timer`
   alongside the stage's `#btn-live-stop` and `#live-topbar-timer`.
2. **Ask was permanently unusable** — the `meeting` handler never re-synced
   availability, so `#btn-ask` stayed disabled after a meeting loaded.
3. **Ask was buried** in a disclosure labelled "save/export".
4. **Compile was always visible in live**, against §9.11.
5. **`#ask-panel` was not a dialog**: no role, name, Escape or focus restore.
6. **Settings opened without moving focus into it.**
7. **Disabled controls lied** — stale purpose text, and Ask wrote only `title`.
8. **Two writers of the disclosure default** clobbered the user's choice.
9. **Dock pill radius clipped the outer grid columns**: `border-radius: 999px`
   from a superseded layer covered the first 3px of `#btn-export-md` and the last
   3px of `#btn-export-json` at 375px.
10. **The topbar clipped its own controls**: once settings/attendees became 44px
    they exceeded the 48px bar, and `overflow: hidden` handed their bottom edge to
    the rail header below.
11. **The command row overflowed its container at narrow widths.** The superseded
    layer makes the switcher a full-width wrapped line with `order: 2` while
    pinning `min-height: 66px`; the wrapped switcher escaped and overlapped
    `#btn-ask`. Fixed with `height/min-height: fit-content` + `flex-shrink: 0`,
    written **physically** because a logical `min-block-size` does not override a
    physical `min-height` from another sheet at equal specificity.
12. **The dock covered the detail tabs at 320x667** by 15px.

### Defects I introduced and caught during this task

* `min-inline-size: 44px` on `.output-switcher__item` inflated already-wide items
  until they overlapped `#btn-ask`. Only the block axis is forced there now.
* `min-block-size: 0` on the command bar collapsed it to 24px while it held two
  44px lines. Replaced with `fit-content`.

Both were caught by acceptance probes, **not** by the test suite. Recorded because
that gap is real.

## Fresh browser QA

**12 states** (1244/375/320 × library/starting/capturing/stopping), frozen clock,
`ko-KR`, `Asia/Seoul`, DPR 1: `green/stop-timer-matrix.json`,
`green/shots-revised/` (12 PNGs), AX snapshot node counts per state.

* Every live state: exactly one Stop, exactly one timer.
* Timer reads the truthful `02:05` derived from server `startedAt` (`00:00` in
  `starting`, before a start time exists).
* `green/narrow-ask-realclick.log` — a **real CDP pointer click** at the control's
  own centre opens the Ask panel at both 375 and 320, after scrolling it into view
  as a user does. The dock is a legitimate scroll owner at 320px.

### A probe artifact, documented

`elementFromPoint` returns the scrolling ancestor for a control inside a scroll
container, and reports a stale stacking order when a rect is read across a scroll.
The suite therefore uses `elementsFromPoint` (the full hit-test stack) and
excludes controls not fully inside their scroller. Real pointer clicks are the
tie-breaker wherever the two disagree.

## Adversarial probes — `green/adversarial.json`

| Probe | Result |
| --- | --- |
| Duplicate ID / control | 0 duplicates across 25 binding IDs; 1 slide surface; 1 disclosure |
| Hidden capability | 0 of 9 hidden |
| Stale disclosure toggle | user's open state survives 3 repeated `capturing` frames |
| Broken focus restore | both dialogs focus inside; Escape restores to trigger |
| Wrong payload key | `selectMeeting` / `ask` both carry frozen `meetingId` |
| Narrow overflow | 320px, disclosure open: root/body overflow 0, 0 clipped |
| Repeated state transitions | 4 full cycles → 1 shell, 1 compile home, 1 Ask home, `perceivableStops: [btn-record]` |
| Network block | 9 gated controls disabled, painted, reason identical in both attributes |

## Unrelated / legacy failures — recorded, NOT fixed

`tests/public-attendees.test.ts` — **5 fail**, all about `startCapture` /
`meeting_id` / reconnect-restore. Attribution **proven twice**, not asserted:
reverting this task's `app.js`+`index.html`, and separately reverting the
single-Stop CSS rule, each leaves the count at 5 fail. Delta zero.

## Files changed

| File | Ownership |
| --- | --- |
| `public/index.html` | Ask re-homed to primary row; compile into the disclosure; `#ask-panel` dialog semantics |
| `public/app.js` | `applyGate` / `setControlPurpose`; Ask Escape + focus restore; settings focus-in; meeting-load re-sync; `#btn-record` gate reason |
| `public/operator-surface.js` | single-source disclosure default |
| `public/caret-operator.css` | composed grid dock; live capture-pill hidden; real 44px floors; radius/topbar/command-row/dock-height containment fixes |
| `tests/public-caret-context.test.ts` | new (task-13), 47 tests |
| `tests/public-test-harness.ts` | timed-out waiter leaves the queue |
| `tests/public-compile-control.test.ts` | additive: opens the disclosure |
| `tests/public-protocol-reliability.test.ts` | additive: opens the disclosure |

Preserved: every binding DOM ID unique and semantically owned, every action name
and payload spelling, `.app--capturing`, the library single-document shell, and
the live stage+transcript geometry. No server change.

## Determinism

Frozen clock (`1710376860000`), `ko-KR`, `Asia/Seoul`, DPR 1. Every awaited state
is subscribed to **before** its trigger and bounded by a named timeout. No sleep,
no polling delay, no `waitForTimeout` in any test or driver.

## Artifacts

- `baseline/` — pre-change matrix (27 states), panel probes, 27 screenshots
- `red/red.log`, `red/red2.log` — the 22- and 16-failure REDs
- `green/` — context + 15-suite logs, gates, stop/timer matrix, reachability,
  adversarial, real-click log, 12 revised + 18 open-disclosure screenshots
- `driver/` — characterization, adversarial, stop/timer, pointer-click, edge-band
- `SHA256SUMS.txt` — every artifact
