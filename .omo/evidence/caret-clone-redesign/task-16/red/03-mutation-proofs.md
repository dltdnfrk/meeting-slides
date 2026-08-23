# Task 16 — adversarial mutation proofs

Each row temporarily broke ONE decision, ran the focused suite, then restored the
source byte-for-byte and re-ran to GREEN. Anchors were asserted before patching,
so a silently-missed mutation is impossible.

| # | Mutation | Guarded by | Result |
| --- | --- | --- | --- |
| A | `server.ts:capturePhase()` returns `"idle"` instead of `"stopping"` | `tests/server-ws-dispatch.test.ts` | RED — `Expected "stopping" / Received "idle"` |
| B | `sendCaptureToggle` bypasses `caretShell.activateCapture()` (`intent = undefined`) | dual-surface | RED — browser double activation sends 2 `stopCapture` |
| C | browser collapses the stop window to idle (`serverOwnsCapture = !!msg.capturing`) | dual-surface | RED — trailing line after the stop broadcast is lost |
| D | just-ended restoration disabled (`if (false && …)`) | dual-surface | RED — 2 failures (restore + no-repeat) |
| G | stale selection not replaced (`selectedMeetingId === null` instead of the token rule) | dual-surface | RED — second capture cycle never restores meeting 8 |
| I | BOTH once-only guards removed (restore on any idle AND token retained) | dual-surface | RED — 2 failures (repeat restore, wrong meeting) |
| J | stale-compile guard moved back below the state writes | dual-surface | RED — superseded job repaints the running job as `error` |
| L | phase-less capture frame no longer maps from `capturing` | dual-surface | RED — phase-less compatibility test times out |

## Mutations that did NOT fail, and why that is correct

| # | Mutation | Why it stayed green |
| --- | --- | --- |
| E/F | `liveMeetingId` token not cleared | `endedNow` independently requires a capturing→idle TRANSITION, so a repeated idle cannot re-enter the branch. Mutation I removes both together and IS red: the two guards are deliberately redundant. |
| H | restore on any idle rather than the ending transition | The consumed token independently blocks the repeat. Same pair as above; mutation I is the combined proof. |
| K | `phase` read without the `capturing` fallback | `serverOwnsCapture` still ORs `!!msg.capturing`, so compatibility survives. Mutation L breaks the real compatibility path and IS red. |

A mutation of the fixture SERVER (`tests/helpers/dual-surface-session.ts`) is not a
product proof, so `capturePhase()` is proven against the real `server.ts` through
`tests/server-ws-dispatch.test.ts`, which drives a real spawned server process.
