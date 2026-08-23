# Start-to-Stop focus handoff repair

Status: **PASS**
Task: `st_019ff409`
Parent/root session: `019fef5e-6de0-7b8b-9d1c-e4d629a0379b`
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`
HEAD: `a1ed25f95980980cd958044b90e739ac45e8280d` (no commits created)
Timestamp: `2026-08-12T03:42:00Z`

## Defect repaired

From `reviews/accessibility-rereview/REPORT.md`, the single blocking item:

> **Blocking:** move focus to the visible browser `#btn-live-stop` after an
> authoritative user-started transition and add a real-keyboard regression that
> subscribes before Start, observes the command/state transition, and asserts
> Stop focus without sleeps or polling.

Reproduced exactly as reported: clicking `#btn-record` produced the real
outbound `{"action":"startCapture"}`, the authoritative capture frames moved the
shell to `live`, `#btn-live-stop` became visible, and `document.activeElement`
remained `BODY`.

## Root cause

`public/operator-surface.js` projected the live shell without any focus handoff.
Activating Start removes `#btn-record` from the live shell while revealing
`#btn-live-stop`, so the browser dropped focus to `BODY`. The pre-existing
comment "Focus is never moved by a state projection" was correct as a rule for
*server-driven* projections but left the *user-driven* Start transition with no
owner at all. Focus calls in the browser source were limited to dialogs, tabs
and output targets, matching the reviewer's source inspection.

## Fix

Three additions to `public/operator-surface.js` (full diff:
`operator-surface.repair.diff`, 71 lines, no other line touched):

1. `pendingStartFocus` — a one-shot flag.
2. `handOffStartFocus()` — moves focus to `#btn-live-stop` once it is genuinely
   perceivable (non-zero box) and the shell is `live`.
3. One line in `activateCapture()` arming the flag.

**Why the flag is armed where it is.** `activateCapture()` is the ONLY local
user-intent seam on the product's only Start surface. The canonical reducer sets
`startRequested` exclusively for a local start the server has not yet answered
(`public/ui-state-machine.ts` `applyActivateCapture`); every server-originated
path — `applyCaptureSnapshot` — *clears* it. So `startRequested === true`
immediately after a local activation is precisely "this user just pressed
Start", and nothing else can produce it.

**Capability boundaries preserved.** No native code was touched. Start remains
browser-only; Stop remains available on both surfaces. No DOM id, wire action or
payload key was renamed. `stopCapture` still flows through the existing
`#btn-record` bridge.

**Cases that deliberately do NOT move focus:**

| Case | Behavior | Why |
| --- | --- | --- |
| Calendar auto-capture (server-originated) | focus unchanged | flag never armed; no local activation |
| First-load hydration into a running capture | focus unchanged | flag never armed |
| Reconnect re-asserting the same live snapshot | focus unchanged | one-shot flag already consumed |
| Open dialog owns focus | focus unchanged | `yieldsFocus` declines when `activeElement` is inside a sheet |
| Operator already moved to another live control | focus unchanged | same `yieldsFocus` guard |

Only the default resting places — `document.body`, `documentElement`, `null`,
and the `#btn-record` control that just left the shell — are handed over.

## TDD record

RED first, at the true user interaction seam (real `#btn-record` click, real
outbound `startCapture`, authoritative frames), subscribing before the
live/capture transition.

- `red-proof.txt` — pre-fix: **4 pass / 2 fail**. The two positive tests fail
  with `stopFocused` expected `true`, received `false`, reproducing the reported
  `BODY` defect. The four negative (non-steal) tests already passed, proving the
  new tests do not merely assert current behavior.
- `green-proof.txt` — post-fix: **6 pass / 0 fail**.

The RED probe was produced by reverting *only* the arming line, then restoring
byte-identical source (verified by `diff`). This makes the pass non-vacuous: the
suite fails without the fix and passes with it.

New tests live in `tests/public-caret-accessibility.test.ts` under
`Todo 15 · user-started capture focuses the visible Stop control`:

1. clicking Start moves focus to `#btn-live-stop` once the live shell reveals it
2. the focused Stop is the control that actually ends the recording (keyboard
   `Enter` produces the real `stopCapture`)
3. a server-originated capture (calendar auto-capture) never steals focus
4. first-load hydration into an already-live capture never steals focus
5. a reconnect re-asserting the same live capture never re-steals focus
6. an open dialog keeps focus: the handoff never pulls focus out of a sheet

Determinism: every awaited state is armed with a `MutationObserver` BEFORE its
trigger and bounded by a named timeout. The suite's own standing determinism
guard ("this suite contains no sleep or polling wait") passes over the new code,
which statically forbids `waitForTimeout`, `Bun.sleep`, `setInterval`, resolving
`setTimeout` and `waitForFunction`.

Note: the new tests hydrate with an authoritative `idle` snapshot before
clicking Start. This is not test convenience — the canonical reducer refuses to
issue any command until `hydrated && connection === "online"`, so a click
without it is not a real start.

## Verification executed

| Command | Result | Output SHA-256 |
| --- | --- | --- |
| `bun test tests/public-caret-accessibility.test.ts` | **103 pass / 0 fail** | see `SHA256SUMS` for `a11y-full-suite.txt` |
| `bun test public-caret-foundation + library + live` | **105 pass / 0 fail** | `foundation-library-live.txt` |
| `bun test public-operator-surface + caret-dual-surface + ui-state-machine + public-active-shell` | **120 pass / 0 fail** | `operator-dual-surface.txt` |
| focused new suite, pre-fix | **4 pass / 2 fail** (RED) | `red-proof.txt` |
| focused new suite, post-fix | **6 pass / 0 fail** (GREEN) | `green-proof.txt` |
| LSP diagnostics, both changed files | **no diagnostics** | — |
| `git diff --check` | **clean** | — |

### Real Chromium manual keyboard QA

`manual-keyboard-qa.json`, driver `manual-keyboard-qa.driver.ts`. No synthetic
`.click()`, no sleeps — the operator reaches Start with real `Tab` keypresses and
activates it with a real `Enter`:

```json
{
  "tabPresses": 7, "reachedStart": true,
  "startFocusVisible": { "matchesFocusVisible": true, "outlineWidth": "2px" },
  "outboundCommand": { "action": "startCapture" },
  "afterStart": {
    "activeTag": "BUTTON", "activeId": "btn-live-stop",
    "stopVisible": true, "stopFocused": true, "stopFocusVisible": true,
    "stopAccessibleName": "녹음 중지", "shell": "live"
  },
  "stopCommand": { "action": "stopCapture" },
  "verdict": "PASS"
}
```

`activeTag` is now `BUTTON` / `btn-live-stop` where the re-review recorded
`BODY`. The handed-off control carries a visible 2px focus ring, keeps its
accessible name, and ends the recording from the keyboard alone.

## Observation, not repaired here (out of scope)

`#btn-live-stop` measures **66x28 CSS px** at 1244x836. Measured with the fix
stashed and restored, the geometry is byte-identical (66x28 both ways), so this
is pre-existing and untouched by this repair. The re-review's 44x44 row passed
because the shipped 44px suite governs the narrow/touch matrix (widths <= 375),
where the live shell paints different geometry. Flagged for the final gate; not
this defect and not changed here.

## Scope discipline

- No commits created.
- No plan, ledger or F1 checkbox edited; no entry into F2-F4.
- Unrelated dirty work untouched. `public/operator-surface.js` was already dirty
  before this task; the repair diff is additive on top of that dirty baseline and
  is reproduced exactly in `operator-surface.repair.diff`.
- Product files changed: `public/operator-surface.js` only.
- Test files changed: `tests/public-caret-accessibility.test.ts` only.
