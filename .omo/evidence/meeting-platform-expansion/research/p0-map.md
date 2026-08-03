# P0 Audit Map Evidence

Worker: `st_019fc56b`
Status: completed
Date: 2026-08-03

## Remaining

- Transcript button still sends `saveNotes`; server already has a distinct `transcript` action.
- Filmstrip totals do not consistently fold in `currentSlide`.
- Historical session click changes selection/status only and does not hydrate meeting state.
- PNG/PDF export exposes coarse strings, not typed job/progress/retry state.
- Compile control is disabled during compile; PNG/PDF controls are not covered equivalently.

## Already fixed before this work

- Whisper meta-token, similarity dedupe, and loop-hallucination filters.
- Low-quality meeting-card rejection.
- Compile button busy-state behavior.

## Source map

- `public/app.js`
- `server.ts`
- `src/session.ts`
- `src/whisper.ts`
- `tests/public-compile-control.test.ts`
- `tests/public-sessions.test.ts`
- `tests/session.test.ts`
- `tests/whisper-dedupe.test.ts`
- `tests/hybrid-path.e2e.test.ts`
