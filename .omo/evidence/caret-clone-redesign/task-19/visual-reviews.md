# Todo 19 visual and accessibility reviews

All reviews use the fresh installed-app journey captured 2026-08-12 at deviceScaleFactor 1.

## Review 1 - desktop/live structure: APPROVE

Artifacts: `journey-final/02-live-960.png`, `journey-final/03-live-compiled-history.png`.

The 960x760 live surface preserves a complete stage and transcript side-by-side, a persistent coral Stop/timer, and reachable contextual controls. The compiled history view contains the complete cream 16:9 slide without cropping and a truthful return-to-live notice. No root clipping or competing shell is visible.

## Review 2 - narrow/responsive structure: APPROVE

Artifacts: `journey-final/02-live-375.png`, `journey-final/05-viewport-320.png`, `journey-final/05-viewport-375.png`.

At 375x812, stage precedes transcript, Stop/timer remain visible, transcript rows remain legible, and the action disclosure stays reachable. The focused 320/375 target check subsequently passed 4/4 after the Review control inherited the canonical 44px target token.

## Review 3 - native and accessibility truth: APPROVE

Artifacts: `journey-final/native-cycle1-ax.txt`, `journey-final/native-cycle2-ax.txt`, `journey-final/03b-review.png`, `journey-final/08-bad-payload-failure.png`.

The real installed AppKit process exposes live status, timer, three finalized rows, Stop, disclosure, and Open Workspace in both cycles. Five rapid AX Stop activations per cycle generated one command per cycle. The browser review is a distinct reachable dialog with a real confirmation action; the malformed target is surfaced in a status region without transcript loss. No screen-share exclusion claim is made.
