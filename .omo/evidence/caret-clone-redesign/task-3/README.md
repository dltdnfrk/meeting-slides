# Task 3 — Lock DOM and wire protocol manifests

Evidence for plan `.omo/plans/caret-clone-redesign.md`, Todo 3. No commit, no staging, no reset.

## Deliverables (working tree, uncommitted)

| File | Purpose |
| --- | --- |
| `tests/fixtures/public-dom-contract.json` | 99 binding DOM ids with tag/control type/owner, 26 ancestry constraints, 3 disjoint pane pairs, compatibility data attributes, 2 persisted layout keys |
| `tests/fixtures/public-protocol-contract.json` | 29 client actions with exact payload keys, 5 guarded critical spellings, 20 server message types, capture/transcript shapes, 20 handlerMap actions |
| `tests/public-dom-protocol-contract.test.ts` | 23 tests parsing the real `public/index.html`, `public/*.js`, `src/session.ts`, `server.ts` |

The test parses shipped sources at run time with `readFileSync`; there is no cached copy,
no build step, and no browser. Only machine-consumed identifiers are asserted — never prose,
copy, or CSS wording.

## Receipts

| Path | Contents |
| --- | --- |
| `baseline/00-boundary.txt` | Canonical root, origin, HEAD, pre-work `git status`, pre-work source hashes, tooling |
| `baseline/01-current-spellings.json` | Passing characterization of current unique ids and protocol spellings before any new test |
| `red/01-duplicate-current-slide.txt` | Mutation 1 RED: duplicate `#current-slide` → 2 focused failures, 21 pass |
| `red/02-renamed-meeting-id.txt` | Mutation 2 RED: `meeting_id` → `meetingId` → 2 focused failures, 21 pass |
| `red/03-removed-capture-message.txt` | Mutation 3 RED: removed `capture` message type → 1 focused failure, 22 pass |
| `red/04-probe-malformed-input.txt` | Invalid / duplicate / missing manifest values; duplicate-entry gap found and closed, then re-proved |
| `red/05-probe-stale-state.txt` | Fresh source hashes; proof the test observes live edits immediately |
| `red/06-probes-not-applicable.txt` | Probes marked N/A with reasons |
| `green/01-green-four-suites.txt` | Required four-suite command, single run, plus `git diff --check` and failure interpretation |
| `green/02-preexisting-failures.txt` | Evidence the server-suite failures predate this task |
| `green/03-server-suite-isolated.txt` | Isolated reproduction + root cause (`jszip` `utils.inherits`) |
| `green/04-typecheck.txt` | `tsc` strict + `checkJs` + `noUncheckedIndexedAccess` over the changed test, exit 0 |
| `green/05-final-green.txt` | Contract suite alone, green, `git diff --check` exit 0 |
| `green/06-probe-flaky.txt` | Zero timing constructs; identical ledger hash across three runs |
| `green/07-probe-mutation-proof.txt` | Mutation proof that GREEN is earned, not vacuous |
| `manual/01-manifest-inspection.txt` | Manual QA: exact manifest counts and ancestry chains |
| `cleanup/01-source-restoration.txt` | All three mutated sources restored byte-for-byte |
| `cleanup/02-probe-dirty-worktree.txt` | Unrelated dirty work preserved; HEAD unchanged; nothing staged |
| `cleanup/03-probe-interruptions.txt` | Zero mutation residue; marker scan |
| `cleanup/04-probe-generated-artifacts.txt` | Every created file accounted for; temp config removed |

## Manual QA result

Parsing the shipped HTML/JS/types with the new test reports:

- 119 ids in `public/index.html`, 119 distinct, **0 duplicated**
- 99 pinned binding ids, 26 ancestry constraints, 3 disjoint pairs, 20 structural ids left unpinned
- `#current-slide < #slide-frame < #stage-pane < #workspace`
- `#transcript-stream < #transcript-body < #transcript-card < #transcript-pane < #workspace`
- `#btn-live-stop < #live-topbar < #stage-pane`, `#notes-input < #notes-box < #transcript-card < #transcript-pane`, `#session-list < #session-rail`
- 29 client actions, 21 carrying payload keys; `startCapture` payload key is `meeting_id`
- 20 server message types (17 client-handled, 3 server-only); capture phases `idle, starting, capturing, stopping, switching-model`
- Persisted layout keys `workspace.layout.v1` (`leftPx`, `rightPx`) and `workspace.transcript.v1` (`heightPx`)

## Verification summary

- `tests/public-dom-protocol-contract.test.ts` — 23/23 pass, single run
- `tests/public-operator-surface.test.ts` — 8/8 pass
- `tests/server-ws-dispatch.test.ts`, `tests/server-handler-map.test.ts` — **pre-existing failure**:
  `server.ts` cannot be imported (`utils.inherits is not a function`, jszip 3.10.1). Reproduced in
  isolation without this task's files loaded. `server.ts` is byte-identical to the pre-work
  baseline; this task added no dependency and no import. Not fixed — out of scope.
- Strict TypeScript (`strict`, `checkJs`, `noUncheckedIndexedAccess`) over the changed test: exit 0
- `git diff --check`: exit 0
- No server or product contract was changed to satisfy any test.
