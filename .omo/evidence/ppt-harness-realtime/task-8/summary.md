# Task 8 evidence

Parent: `fdadd6b49c6df2f372a096edf30cdbbfb26a0c3a`

Added a hermetic Hybrid-path E2E harness using the real `MeetingSession`, browser client, file-backed SQLite store, compiler/publisher, registry renderer, and export material selector. Only detector and planner calls are faked. The browser blocks every request outside the local test origin.

Coverage:

- fake transcript -> detector -> WebSocket `slide` -> browser MeetingCard title/kicker/bullets/emphasis
- live transcript and slide anchor persistence
- no-published-compile legacy export selection
- `compileDeckToDisk` -> canonical outline/spec persistence -> six kinded standalone registry files on disk
- SQLite close/reopen round trip
- published compiled export preference
- invalid runtime outline rejection
- two invalid planner responses, including model HTML, -> deterministic safe fallback and publish
- typed `compile-busy` export event -> client error surface with no new export output

Verification:

- Focused: 2 pass, 0 fail, 35 assertions (`focused-tests.txt`)
- Full: 102 pass, 0 fail, 370 assertions across 17 files (`full-tests.txt`)
- TypeScript: exit 0 (`typescript.txt`)
- Public JS: no public JS was changed; existing real `public/app.js` is loaded by both browser suites.
- `slides-grab validate`: not run in this harness because the task worktree has no local Playwright browser (`vendor/ms-playwright` absent); installing one would require a network/browser download and break the hermetic gate. Registry HTML structure and all kind markers are asserted directly.
- Whitespace: staged diff clean (`diff-check.txt`)

Operator responsibilities are documented in `docs/ppt-harness.md`.
