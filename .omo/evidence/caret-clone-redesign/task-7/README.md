# Task 7 — Pure canonical UI state reducer

Plan `.omo/plans/caret-clone-redesign.md`, Todo 7 (Wave 2). Blocked by 3, 4. No commit, no
staging, no reset. `public/app.js` and the product DOM were **not** modified.

## Deliverables (working tree, uncommitted)

| File | SHA-256 |
| --- | --- |
| `public/ui-state-machine.ts` | `8e524df24d13d5187ad81aa3263fc02042526af0159c811ebe9d1de5cee356f1` |
| `tests/ui-state-machine.test.ts` | `6536f7d5705a3d4ecf0e811c90ee846f044a93689870a07cb56782cea34eea4d` |

File names follow the executing task's ownership grant (`public/ui-state-machine.ts`,
`tests/ui-state-machine.test.ts`), not the plan text's earlier `public/ui-state.js` /
`tests/public-ui-state.test.ts` spelling. Same module, TypeScript instead of JS.

## The twelve canonical states

`startup`, `reconnect`, `idle-library`, `idle-live`, `capture-starting`, `capture-live`,
`capture-stopping`, `capture-error`, `meeting-switching`, `history-preview`,
`compile-running`, `compile-complete`.

`name` is **derived** in exactly one function (`nameOf`) from the state projection, so an
illegal combination such as "idle-library while capturing" is unrepresentable. Callers never
assign a name.

## Design decisions worth reading

| Decision | Why |
| --- | --- |
| Server capture snapshots always outrank local pending intent | Mutating this ordering turns 5 tests RED (`red/02`) |
| `startRequested` (local, unconfirmed) is distinct from server-confirmed `starting` | An unconfirmed start can neither restart nor stop; once the server confirms any non-idle phase, Stop is legal from every substate |
| Stop never claims capture ended | `capture-stopping` persists until an authoritative idle snapshot; a socket drop does not end it |
| `restore` is captured on disconnect | Reconnect is deterministic instead of re-derived from whichever frame lands first; a stop that never landed is re-sent exactly once on reopen |
| Any connection state below `online` is named `reconnect` | The surface must never present a live capture over a socket it does not have |
| No command is emitted over a non-online transport | Prevents a `startCapture`/`stopCapture`/`selectMeeting` disappearing into a dead socket and leaving the surface waiting forever |
| An authoritative snapshot clears a prior transport error | Receiving one is itself proof the transport delivers |
| Compile job status outranks capture in the *name*, never in *actions* | `compile-running` is the foreground concern, but Stop still works from it |
| `idle-live` after a capture ends | The just-ended meeting stays in the live shell until the user explicitly returns to the library |

## Protocol compatibility

Consumed exactly as `src/session.ts` declares it; nothing renamed.

- `startCapture` carries the snake_case `meeting_id`; `selectMeeting`/`meeting` carry `meetingId`.
- `stopCapture` carries no payload.
- `phase` on a capture message stays optional: a phase-less `capturing: true` maps to
  `capturing`, `capturing: false` maps to `idle`.
- All 20 declared server message types parse. The 4 the reducer acts on (`capture`,
  `meetings`, `meeting`, `compile`) are narrowed; the rest reduce to a no-op `other` event so
  a valid-but-unhandled frame can never crash or corrupt state.
- Protected sources byte-identical to baseline: `public/app.js`
  `6a9942ec…`, `src/session.ts` `710be07f…`, `tests/fixtures/public-protocol-contract.json`
  `2c999d76…` (`baseline/01-source-hashes.txt` vs `cleanup/01-worktree.txt`).

## Purity

Enforced by test, not by claim. The module source contains none of: `document`, `window`,
`localStorage`, `sessionStorage`, `WebSocket`, `fetch(`, `Date.now`, `new Date`,
`performance.now`, `setTimeout`, `setInterval`, `Math.random`, `globalThis`, `process.`,
a type-position `any`, `as unknown as`, a `@ts-` directive, or a non-null assertion.
Every varying value (timer origin, ids, reasons) arrives inside an event payload.
Every returned state is deeply frozen; the input state is never mutated.

## RED / GREEN receipts

| Path | What it proves |
| --- | --- |
| `red/01-missing-reducer.txt` | Initial RED — the module did not exist (`Cannot find module`) |
| `red/02-mutation-snapshot-priority.txt` | Mutation: local pending intent outranks the server snapshot → **5 fail / 64 pass** |
| `red/03-mutation-exhaustiveness.txt` | Mutation: one arm removed from the server-message switch → **compile error TS2322 `not assignable to type 'never'`** (exhaustiveness is compiler-enforced, not test-enforced) |
| `red/04-mutation-parse-boundary.txt` | Mutation: unknown message types accepted → **1 fail / 68 pass** |
| `red/05-offline-activation.txt` | RED for the offline-command defect the transition table exposed, against the pre-fix reducer |
| `green/01-focused-green.txt` | `bun test tests/ui-state-machine.test.ts` — **72 pass / 0 fail**, 686 assertions, one run, no retry |
| `green/02-strict-typescript.txt` | `bunx tsc` with `strict`, `noImplicitAny`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noFallthroughCasesInSwitch` — **exit 0** |
| `green/03-neighbouring-suites.txt` | task-3 contract + task-4 harness suites — **48 pass / 0 fail** |
| `green/04-lsp-note.txt` | LSP clean on both files |
| `green/05-deliverable-hashes.txt` | SHA-256 of both deliverables |

All three mutations were reverted; the restored source hashed identical to the pre-mutation
copy before the final GREEN run.

## Manual QA (real module driver)

`manual/driver.ts` imports the real module and executes four journeys; output in
`manual/01-driver-output.txt`:

1. **Happy capture** — `startup → idle-library → capture-starting (startCapture) →
   capture-live → history-preview → capture-live`, timer origin `1710376735000` taken only
   from the server `startedAt`.
2. **Reconnect during capture** — `capture-live → reconnect (capture preserved, timer origin
   preserved) → reconnect → capture-live`.
3. **Stop from live** — one `stopCapture` for two presses, `capture-stopping` held through a
   trailing `line`, `idle-live` only on the authoritative idle, then `idle-library`.
4. **Bad events** — 7 malformed/unknown frames each rejected with a distinct typed reason;
   feeding the resulting `malformed` event to the reducer leaves `capture-live`/`capturing`
   untouched and records `{scope: "protocol", reason: …}`.

`manual/02-transition-table.md` is the complete 12-state x 21-event table with the emitted
commands. `manual/03-table-audit.txt` machine-audits all **273 (seed x event) cells** for:
no command over a non-online transport, no settled state name over a non-online transport, no
idle-with-timer-origin, every result frozen, no duplicate `startCapture`/`stopCapture`.
Result: **violations: none**.

The transition table found two real defects that the hand-written tests had missed
(a command emitted while reconnecting, and `capture-live` presented over an errored socket).
Both were fixed test-first; `red/05` is the RED for the first.

## Scope

- `public/app.js`, `public/index.html` and every product DOM file untouched — this todo
  delivers the pure reducer only; integration is Todo 11/12.
- The task-4 1px geometry risk is a browser-layout concern and deliberately has no
  representation in this module.
- `tsconfig.task7.json` was a temporary root-level verification config; it is archived at
  `green/tsconfig.task7.json` and removed from the repository root.
- `manual/*.ts` are QA drivers kept as evidence, not shipped and not under `.omo/qa/`.
- Unrelated dirty work (providers, Alibaba, models, handoff, and the concurrent macOS
  task's `macos/launcher.swift` / `scripts/build-app.sh`) preserved; nothing staged,
  reset or committed. `git diff --check` exits 0.
