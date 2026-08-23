# Task 16 — Synchronize browser and native capture restoration

Plan: `.omo/plans/caret-clone-redesign.md`, Todo 16 (Wave 4).
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`.
No commit, no staging, no reset, no restore. HEAD unchanged: `a1ed25f`.

## What this task actually proves

`tests/caret-dual-surface.test.ts` runs ONE local Bun session with TWO real
clients attached at the same time:

* the shipped browser workspace in real Chromium (`public/index.html` +
  `public/app.js` + the generated reducers), and
* a real compiled native client that drives the SHIPPING pure Swift modules
  (`macos/TransportClient.swift`, `macos/MinibarProjection.swift`,
  `macos/NativeSurfaceContract.swift`, `macos/AppLifecycle.swift`) over a real
  `URLSessionWebSocketTask`.

Neither is a mock of the other. Every assertion is about one server truth
reaching two independent projections.

## Defects found (RED) and fixed

All four were found by the new suite against the real product, not invented.

### 1. The stop window did not exist on the wire — `server.ts`

`stopCapture()` sets `capturing = false` and broadcasts BEFORE `whisper.stop()`
and `session.flush()`. The flush emits trailing `line` frames. Both surfaces
therefore believed the meeting had already ended while final sentences were
still arriving: the browser tore down the live shell and the timer, and the
native minibar cleared its transcript viewport (`applyCapture` clears on idle)
only to have a ghost line reappear.

Fix: `capturePhase()` names the window `stopping`, and `captureMessage()` keeps
`startedAt` on the wire for as long as the server still owns a capture.
`CaptureUpdate.phase` was ALREADY declared optional in `src/session.ts` and was
never emitted — real inspection confirmed the gap, which is exactly the additive
metadata the todo authorises. Phase-less compatibility is preserved and tested.

`stopRequested` is cleared at the point capture truly ends so the terminal
snapshot reports `idle`, not a lingering `stopping`.

### 2. The browser sent TWO `stopCapture` commands — `public/app.js`

`sendCaptureToggle()` branched on `capturing`, a RENDER flag that only flips when
the server answers. Two activations inside one task both read `capturing === true`
and both sent `stopCapture`. Measured directly: **2 frames on the wire** for one
double activation, while the native surface has always sent exactly 1
(`StopCommandGuard`).

Fix: the record control now routes through the canonical reducer's
`activateCapture()`, whose outbox is the same one-command guard. Payloads are
still built in `app.js` because `meeting_id` is the prepared ATTENDEE draft, not
the library selection — no spelling changed. A refused activation states which
refusal applies instead of leaving a dead button.

### 3. A superseded compile job repainted the running one — `public/app.js`

`renderCompileStatus()` wrote `hidden = false` and `dataset.state = msg.status`
BEFORE its stale-job guard, so a late failure for job-1 painted the running job-2
as `error` and only then returned. Fix: the guard moved above the writes; the two
now-unreachable duplicate guards were removed so one rule has one home.

### 4. The just-ended meeting was never restored — `public/app.js`

After authoritative idle the shell returned to `library` with ZERO meetings
selected. The just-ended meeting's slides and transcript were rendered but
belonged to no selection, so the first library interaction discarded them.

Fix: `liveMeetingId` is learned from the meetings list while capturing (the
server marks exactly the live meeting `open`) and consumed once on the
capturing→idle transition to restore that meeting. Exactly once, scoped to the
capture that just ended: a second capture cycle restores ITS meeting and never
re-selects the first.

## Scenario coverage (28 tests, all green)

reconnect · calendar auto-capture · manual start · Stop from either surface ·
trailing transcript lines · duplicate commands · browser close/reopen ·
history preview / compile overlap · natural recorder failure · authoritative
just-ended-meeting selection · independent disconnect of each client ·
malformed / stale / out-of-order frames · phase-less compatibility ·
command wire capture.

Both surfaces derive the timer from server `startedAt` (`02:05` from a fixed
clock on both). Neither claims capture stopped on transport loss.

## Files

Product (2):
- `server.ts` — `capturePhase()`, `captureMessage()` phase + stop-window `startedAt`, `stopRequested` clear at true end.
- `public/app.js` — reducer-guarded Stop, stop-window handling, stale-compile guard order, just-ended restoration.

Tests / harness (5 new, 1 updated):
- `tests/caret-dual-surface.test.ts` — NEW, 28 tests.
- `tests/helpers/dual-surface-session.ts` — NEW, the one Bun session with per-client control.
- `tests/helpers/native-dual-surface-client.ts` — NEW, compiles + drives the real Swift client.
- `tests/helpers/browser-dual-surface-client.ts` — NEW, long-lived Chromium workspace client.
- `tests/fixtures/native-dual-surface-driver.swift` — NEW, headless real-socket native driver.
- `tests/server-ws-dispatch.test.ts` — UPDATED: asserts the additive `phase`/`startedAt` and the authoritative idle; per-await bound raised (see `green/05` §C); terminal idle anchored past the stop window after the verifier repair (see `red/04`).

Unchanged and hash-verified: every `macos/*.swift` product source, both reducers,
`public/operator-surface.js`, `src/session.ts`. See `green/10-change-surface.txt`.

## Evidence index

| Path | What |
| --- | --- |
| `baseline/00-worktree-before.txt` | worktree + HEAD + toplevel before work |
| `baseline/01-source-hashes.txt` | pre-task SHA-256 of every file in the blast radius |
| `baseline/02-04*.txt` | pre-task GREEN for server/protocol, native, browser suites |
| `red/01-dual-surface-red.txt` | first full run: 20 pass / 5 fail |
| `red/02-duplicate-stop-probe.txt` | direct measurement: browser sent 2 `stopCapture` |
| `red/probe-duplicate-stop.ts` | the probe itself |
| `red/03-mutation-proofs.md` | 8 load-bearing mutations + 3 honest non-failures |
| `red/04-terminal-idle-scan-repair.md` | verifier-found vacuous assertion: defect demo, RED proof, test-only repair |
| `green/02b-server-ws-dispatch-repaired.txt` | focused GREEN after the repair |
| `green/01-dual-surface-green.txt` | 28 pass / 0 fail |
| `green/02-server-protocol-green.txt` | 45 pass / 0 fail |
| `green/03-browser-caret-green.txt` | 255 pass / 0 fail |
| `green/04-browser-legacy-green.txt` | 83 pass / 1 fail (pre-existing, §B of `green/05`) |
| `green/05-preexisting-failures.md` | isolation proofs for all pre-existing failures |
| `green/06-preexisting-*` | transcript-dock run log + attribution |
| `green/07-native-green.txt` | 123 pass / 0 fail |
| `green/08-static-checks.txt` | project tsc, strict tsc, swiftc, generated drift, `git diff --check` |
| `green/09-deliverable-hashes.txt` | post-task SHA-256 |
| `green/10-change-surface.txt` | exact SAME/DIFF/NEW change surface vs baseline |
| `manual/qa-driver.ts` | real Chromium + compiled native QA driver |
| `manual/qa-run.log` | its output |
| `manual/qa/*.png` | 9 same-size 1244x836 screenshots |
| `manual/qa/*.json` | per-step browser + native projected state |
| `manual/qa/summary.json` | timers, commands, cross-surface invariant |
| `cleanup/01-protected-boundary.txt` | HEAD/index/protected dirty work/symlinks |
| `cleanup/02-cleanup.txt` | temp removal + process/port verification |

## Post-approval repair (test quality, no product change)

An independent verifier APPROVED the product behavior above and found one exact
test-quality defect: the terminal idle assertion in
`tests/server-ws-dispatch.test.ts` scanned the message buffer from index `0`, so
it could match this socket's CONNECT-TIME hydration frame — which is byte-
identical to the terminal idle — instead of observing the end of the capture.

The assertion is now anchored at `const idleStart = messages.length`, captured
after the stop-window assertions. Proof that this matters, all three rows run:

| Scan floor | `stopRequested` cleared after the terminal broadcast | Result |
| --- | --- | --- |
| `0` (defective) | yes | 1 pass — vacuous, the defect |
| `idleStart` (repaired) | yes | 1 fail — timed out, terminal idle never arrives |
| `idleStart` (repaired) | no (shipping behavior) | 1 pass, 5/5 runs |

`server.ts` was restored byte-exact after the mutation
(`f373a60f…`, unchanged). Only the test file's hash moved:
`5881f692…` → `a8282758…`.

## Determinism

Browser clock frozen, native clock injected, `ko-KR` / `Asia/Seoul`,
deviceScaleFactor 1, zero off-origin requests. Every awaited state is subscribed
to BEFORE its trigger and bounded by a deadline that can only reject. A test in
the suite enforces this by scanning all five sources for sleeps, polling and
resolving timers. Focused suite: 4/4 green runs.
