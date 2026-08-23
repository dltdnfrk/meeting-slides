# Task 16 repair — terminal idle assertion scanned from index 0

Raised by the independent verifier AFTER product behavior was approved. This is a
TEST-QUALITY defect only: no product behavior was changed by the repair.

## The defect

`tests/server-ws-dispatch.test.ts` asserted the authoritative idle with:

    waitForMessageAfter(0, (m) => m.type === "capture" && m.phase === "idle")

`waitForMessageAfter(start, …)` scans `messages.slice(start)` before subscribing,
so a floor of `0` scans the WHOLE buffer — including this socket's connect-time
hydration frame from `server.ts:1055`:

    {"type":"capture","capturing":false,"mode":"mic","phase":"idle"}

That frame is byte-identical to the terminal idle being asserted and sits at
index ~3. The assertion therefore matched hydration and could never observe the
end of the capture: it held even if the server never left the stopping phase.

## RED proof (with the corrected floor)

Mutation, exactly as the verifier specified — clear `stopRequested` AFTER the
terminal broadcast in `server.ts`, so the terminal frame reports `stopping`:

        const wasRequestedStop = stopRequested;
-       stopRequested = false;
        broadcast(captureMessage());
+       stopRequested = false;

| Scan floor | Mutation | Result |
| --- | --- | --- |
| `0` (defective) | applied | **1 pass / 0 fail** — vacuous, the defect itself |
| `idleStart` (repaired) | applied | **1 fail** — `timed out after 30000ms`, the terminal idle never arrives |
| `idleStart` (repaired) | reverted | **1 pass**, 5/5 consecutive runs |

The first row is the demonstration that the old assertion proved nothing; the
second is the demonstration that the new one is load-bearing.

## The repair (test only)

    const idleStart = messages.length;   // captured after the stop-window assertions

Both terminal awaits (`capture.phase === "idle"` and the `녹음 중지` status) now
use `idleStart` as their floor. Frames that arrive later reach the live listener,
which is by definition past the floor, so the anchor is sound in both paths.

## Product integrity

`server.ts` restored byte-exact after the mutation:
`f373a60fd60dda285ea36c58fd7754b58b4049d7c9055921b7b4d09a80f99f31`
— identical to the hash recorded in `green/09-deliverable-hashes.txt` before the
repair. No product file was modified by this repair.
