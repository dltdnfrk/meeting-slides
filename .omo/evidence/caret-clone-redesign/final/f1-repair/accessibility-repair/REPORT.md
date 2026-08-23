# F1 Accessibility Repair

Status: **PARTIAL** — blockers 1 and 2 closed and directly observed; blockers 3 and 4 **not** closed.
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`
Scope: repairs the independent accessibility review at
`.omo/evidence/caret-clone-redesign/final/f1-repair/reviews/accessibility/REPORT.md`.
No plan, ledger, F1 checkbox, or F2-F4 file was touched. No commit was created.

## Verdict against the review's four residual gaps

| # | Review blocker | Result |
| --- | --- | --- |
| 1 | Tab/Shift+Tab focus containment for sheets/modals | **CLOSED** — implemented and proven RED→GREEN through the real browser surface |
| 2 | Installed-app evidence for all six canonical viewports | **CLOSED** — all six captured from the installed app, zero overflow, zero clipping |
| 3 | Native AX role/help/focus/announcement runtime receipts | **PARTIAL** — role/label/help/enabled directly observed; **focus and announcements NOT observed** |
| 4 | Native WCAG contrast receipt | **NOT CLOSED** — not attempted, no measurement exists |

Because blockers 3 and 4 are not fully closed, this repair does **not** claim F1 accessibility PASS.

## Blocker 1 — focus containment (CLOSED)

`DESIGN.md:456-457` requires "Sheets and modals trap focus, close on Escape, and restore focus
to the trigger." Escape and trigger restoration already existed; containment did not.

### The defect

Four surfaces ship with `role="dialog"`: `#provider-panel` (settings), `#attendee-panel`,
`#review-panel`, `#ask-panel`. Each moved focus in on open and closed on Escape, but pressing
Tab from the last control walked straight out into the shell behind the open dialog.

### TDD

A new block, `Todo 15 · every shipped dialog traps Tab and Shift+Tab`, was added to
`tests/public-caret-accessibility.test.ts`. For each of the four dialogs it drives the real
shipped surface with real `page.keyboard` events and asserts:

- Tab from the dialog's last tabbable wraps to its first, never leaving the dialog;
- Shift+Tab from the first wraps to the last;
- Escape releases the trap, restores the trigger, and lets Tab move through the shell again.

Plus two shell-level guards: a closed dialog contributes nothing to the tab order, and an
opened-then-closed dialog leaves no `inert`/`aria-hidden` residue.

RED and GREEN were both produced against the **final** test bytes, by removing and restoring
only the `<script src="/focus-trap.js">` tag:

| Phase | Result | Receipt |
| --- | --- | --- |
| RED | **6 pass / 8 fail** — all four dialogs fail both wrap directions | `tdd/red-focus-trap.txt` |
| GREEN | **14 pass / 0 fail** | `focused/green-focus-trap.txt`, `focused/metadata.txt` |

The 8 RED failures are exactly the 4 dialogs x 2 wrap directions. The 6 tests that passed in
RED are the Escape/restoration and residue guards, which were already correct — that split is
itself evidence the new tests target containment specifically and not pre-existing behavior.

### Implementation

`public/focus-trap.js` (new, 3.4 KB) exposes `window.trapFocus` / `window.releaseFocus`,
matching the existing public-JS style (IIFE + `window.X = X`, the same shape as
`window.createReviewPanel`). One capture-phase `keydown` listener computes the Tab destination
and wraps at the boundaries.

Deliberate design choices:

- **No DOM mutation.** It never writes `inert`, `aria-hidden`, or `tabindex` on the shell. A
  trap that mutates the background and fails to restore leaves the whole app unreachable; this
  one only redirects Tab, so a missed release can never strand the user. This is what the
  "no hidden/inert element regressions" requirement demanded, and the residue test pins it.
- **Recomputes tabbables on every Tab.** The review dialog re-renders its cards, so a list
  cached at open time is stale immediately.
- **Stack with self-healing.** Last-opened wins; a panel already `hidden` is skipped even if a
  close path forgot to release, so the shell cannot lock.

Wiring is 4 lines in `public/app.js` (settings, attendee, ask) and 2 in `public/review-panel.js`,
each next to the existing focus/restore call. `public/index.html` loads the script first;
`tests/public-active-shell.test.ts` pins the exact script list and was updated accordingly.

### A real browser behavior worth recording

The review dialog's `<input type="date">` is **one** tabbable that consumes **four** Tab
presses (month/day/year segments). A fixed "one Tab per tabbable" walk therefore mis-measures
it. The test walks with a bounded `tabUntil` that fails if focus ever leaves the dialog, rather
than assuming step counts. Identity is stamped per element, because the review dialog paints
several `button.review-item__action` nodes and a class-derived name would make "reached the
last control" true at the wrong node.

## Blocker 2 — canonical viewport evidence (CLOSED)

The review's objection was specific: the Todo 19 journey recorded live 375/820/960 and library
320/375/960/**1280**, omitting canonical **1440x900** and **1244x836** and substituting a
non-canonical 1280.

All six `DESIGN.md:375-380` viewports were captured from the **installed application**
(`~/Applications/Meeting Slides.app`, pid 63914, serving port 8789). The installed app's
`project-path.txt` resolves to this canonical root and its `/index.html` served the repaired
bytes (`focus-trap.js` present, verified over HTTP), so these captures exercise the repair.

| Viewport | Root h-overflow | Clipped controls | Undersized (<44px) | Trap loaded | Focus contained |
| --- | --- | --- | --- | --- | --- |
| 1440x900 | 0 px | 0 | 0 | yes | yes |
| 1244x836 | 0 px | 0 | 0 | yes | yes |
| 960x760 | 0 px | 0 | 0 | yes | yes |
| 820x900 | 0 px | 0 | 0 | yes | yes |
| 375x812 | 0 px | 0 | 0 | yes | yes |
| 320x667 | 0 px | 0 | 0 | yes | yes |

Receipts: `installed-viewports/viewports.json` plus one PNG per row. Each row also opens the
real settings sheet and confirms focus lands inside it (`btn-recheck`) and stays contained, so
the repair is exercised at every canonical width rather than only at the suite's 1244.

### Honest limitation on this evidence

`shell` was recorded as **observed, not asserted**: every row resolved to the `library` shell.
Driving a real microphone capture to force the live shell was not achievable unattended — the
installed app refuses Start with `meeting 66 is not prepared` while a stale prepared draft
exists on the real database. The rows labelled `live` in the matrix therefore carry **library**
shell geometry at live widths. That is truthful overflow/clipping/target evidence at all six
canonical sizes, and it is **not** proof of live-shell layout at 960/820/375. Live-shell layout
at those widths remains covered only by the focused browser suites, exactly as before this
repair. No live-shell claim is made from these captures.

## Blocker 3 — native AX runtime receipts (PARTIAL — NOT CLOSED)

The review asked for records enumerating AXRole, AXLabel, AXHelp, AXEnabled, focused
element/order, and observed announcement notifications, because Todo 19 retained only flattened
text.

A capture tool (`tools/ax-capture.swift`) attaches to the **real installed process** through the
public accessibility API. `AXIsProcessTrusted()` returned **true**, so permission was not a
limitation. It was run across a real capture cycle driven over the installed app's own
WebSocket (`startCapture` → live → `stopCapture`).

### Directly observed and PASSING

Role, label, help, and enabled state are real runtime receipts, and they change correctly with
projection state:

| State | Stop button | AXHelp | AXEnabled |
| --- | --- | --- | --- |
| idle | `녹음 중지` | 중지할 녹음이 없습니다 | **false** |
| capturing | `녹음 중지` | 진행 중인 녹음을 중지합니다 | **true** |
| stopped | `녹음 중지` | 중지할 녹음이 없습니다 | **false** |

Also observed: root is `AXGroup` labelled `Meeting Slides 미니바`; both controls are real
`AXButton`s; the disclosure button carries persistent AXHelp; heights are 46 pt (≥44).
Receipts: `native-ax/ax-idle.json`, `ax-capturing.json`, `ax-stopped.json`, `ax-transition.json`.

This is a genuine improvement over Todo 19's flattened dumps and closes the role/help/enabled
part of the gap.

### NOT observed — announcements

`announcements: 0` in every capture, including an observer running across the entire
start→live→stop transition.

This is **not** claimed as a product pass, and it is **not** claimed as a product defect. A
control experiment settles which: `native-ax/announcement-control/axpost-probe.swift` is a
minimal AppKit app that posts exactly one known-good `NSAccessibility.post(.announcementRequested)`.
An identical external `AXObserver` also recorded **zero** for it
(`ax-probe-observer.json`, `axpost-run.log`). So `AXAnnouncementRequested` is not delivered to
an external observer on this machine; it requires an active assistive client. VoiceOver is off
(`voiceOverOnOffKey = 0`) and was deliberately not enabled, since doing so hijacks the user's
machine with speech output.

**Announcement behavior therefore remains unproven at the installed AppKit surface.** The
strongest real-surface substitute currently in evidence is the pure-seam native suite
(`tests/native-minibar.test.ts`, 50 pass), which asserts announcement de-duplication logic, plus
the observed fact that `statusTitle` carries the correct AX label/value per state.

### NOT observed — Stop focus on user-origin present

`MinibarWindowController.present(origin:.user)` calls
`panel.makeFirstResponder(contentView.stopControl)`. That was **not** reproducible as AX focus:

- pressing the menu-bar status item via its real `AXPress` action succeeded, and the app did
  become frontmost (`meeting-slides`), so `present(origin:.user)` did run;
- while live, Stop reports `focusedSettable=true` (and `false` when disabled, consistently);
- yet `AXFocused` on Stop stayed **false**, and `AXFocusedUIElement` remained the `AXWindow`;
- the attribute is provably live: setting `AXFocused=true` on Stop externally succeeded and
  read back **true**, with `AXFocusedUIElement` becoming the Stop button;
- the panel is `AXMain=false` by design (`canBecomeMain: false`), and this reproduced with
  `AppleKeyboardUIMode` at both 0 and 3.

This is an unresolved discrepancy between the source contract and the observable installed
surface. It may be a legitimate AppKit consequence of a borderless non-activating panel, or a
real focus defect. **It was not resolved, so no PASS is claimed for native focus behavior.**

## Blocker 4 — native contrast receipt (NOT CLOSED)

Not attempted. No native rendered-contrast measurement exists. Web contrast evidence cannot
establish AppKit contrast, exactly as the review stated.

## Verification executed

All against current bytes, all run to completion:

| Suite | Result |
| --- | --- |
| `public-caret-accessibility` + `public-caret-foundation` | **126 pass / 0 fail** |
| `public-caret-library` + `public-caret-live` | **76 pass / 0 fail** |
| `public-review`, `public-attendees`, `public-active-shell`, `public-runtime-guard`, `public-settings-panel` | **79 pass / 0 fail** |
| 9 remaining public suites (shell, workspace, operator-surface, transcript-dock, context, harness, fresh-workspace, sessions, dom-protocol) | **140 pass / 0 fail** |
| 6 further public suites (live-kind, compile-control, protocol-reliability, transcript-feed, harness-baseline, dual-surface) | **44 pass / 0 fail** |
| `native-minibar` + `native-surface-contract` | **81 pass / 0 fail** |

Total: **546 pass / 0 fail** across the focused accessibility, library, and dialog-owning
matrix. Logs under `tests/`.

Real Chromium keyboard QA ran at the actual shipped surface — the installed app on port 8789 —
at all six canonical viewports, confirming the trap loads and contains focus in the real
settings sheet at each.

## Files changed

Product (5):
- `public/focus-trap.js` — new, the reusable containment behavior
- `public/index.html` — loads it first
- `public/app.js` — 4 trap/release calls (settings, attendee, ask)
- `public/review-panel.js` — 2 trap/release calls
- `tests/public-caret-accessibility.test.ts` — the new focus-containment block
- `tests/public-active-shell.test.ts` — pinned script list updated for the new asset

No prose was pinned by any new assertion. Unrelated dirty work in the tree was preserved.

## Remaining blocker (exact)

> Native AX runtime proof is incomplete. Two required properties are still unobserved at the
> installed AppKit surface: (a) announcement notifications and their de-duplication, which no
> external `AXObserver` can receive on this machine without an active assistive client — proven
> by a control experiment in which a known-good announcement post was equally invisible; and
> (b) Stop receiving focus on user-origin present, which did not reproduce as `AXFocused`
> despite the trigger firing, the app activating, and the attribute being provably settable.
> Additionally, no native WCAG contrast measurement exists (review blocker 4). Closing these
> requires either a VoiceOver-enabled session for announcements or a decision that the pure-seam
> native suite is the accepted substitute, plus a native contrast measurement.
