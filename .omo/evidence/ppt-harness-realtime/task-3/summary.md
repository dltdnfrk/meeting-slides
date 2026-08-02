# Task 3 evidence

Parent: `71f373e32124df955f8f83f223d51bc003ce36de`

Implemented and verified:
- Flat MeetingCard detector contract: `title`, optional `kicker`, 1-6 `bullets`, optional `emphasis`, plus strict boolean `shouldAdvance`.
- Invalid JSON/schema output throws into the existing session fallback path; no parse-failure slide is synthesized.
- HTTP and CLI detectors share the same parser and prompt schema.
- Live `Slide` payload carries MeetingCard fields while preserving the `type: "slide"` envelope.
- Pending advance candidates do not mutate the current card; streaks are isolated by candidate title and require two matching signals.
- Epoch invalidation, threshold 2, fallback behavior, and detecting teardown are covered.

Evidence:
- `targeted-tests.txt`: 32 pass, 0 fail.
- `full-tests.txt`: 80 pass, 0 fail.
- `tsc.txt`: exit 0.
- `diff-check.txt`: exit 0 for product/test files.
