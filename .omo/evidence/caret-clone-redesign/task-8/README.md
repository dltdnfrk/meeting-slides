# Task 8 — Pure transcript projection reducer

Deliverables (the only files this task wrote outside its own evidence directory):

| File | SHA-256 |
| --- | --- |
| `public/transcript-state.ts` | `a940c77f517f0bb755a4eb67b4e3275fe44c3fd6c11c1acfa7ec80cfdda7c695` |
| `tests/transcript-state.test.ts` | `e9cc4841fa9982cab38a9d78bbdccc4dcd0a51ac142ec0025d4479dc59bfc52d` |

## Naming deviation from the plan text

The plan line for todo 8 names `public/transcript-state.js` / `tests/public-transcript-state.test.ts`.
The dispatched task ownership names `public/transcript-state.ts` / `tests/transcript-state.test.ts`,
and todo 7 already shipped its sibling reducer as TypeScript (`public/ui-state-machine.ts`).
TypeScript was chosen for consistency with todo 7 and because the plan requires strict typing,
a typed parse boundary and no `any`/unsafe casts, which a `.js` module cannot enforce.

## Contract

- `parseTranscriptEvent(raw: unknown)` — the boundary. Every untrusted frame becomes either a typed
  `TranscriptServerEvent` or `{ ok: false, error: { reason } }`. Never throws.
- `reduceTranscript(state, event)` / `reduceTranscriptAll(state, events)` — pure, returns frozen state.
- `minibarProjection(state)` — derived last-3 finals + one provisional, from the same store.
- `initialTranscriptState()`, `normalizeTranscriptText()`, `MINIBAR_LINE_LIMIT`.

Protocol spellings are consumed unchanged: `line`, `caption`, `transcript` with
`reason: "snapshot" | "export"` and `truncated`, `meeting` with `meetingId` and `transcript`,
numeric 1-based `speaker`. Nothing is renamed and no new message is invented.

Rules implemented (each grounded in `baseline/02-characterization.md`):

| Rule | Behavior |
| --- | --- |
| Finalized ordering | Stable insertion by server `ts`; a late older final lands chronologically; equal `ts` keeps arrival order. |
| Duplicate suppression | Key `ts:speaker:normalizedText` (the shipped `entryKey` rule); a re-sent `line` collapses. |
| Interim → final | `caption` is a single provisional row; a final for the same speaker turn supersedes it, including corrected wording. |
| Snapshot | `reason:"snapshot"` **replaces** the projection, sorts, drops in-snapshot duplicates, clears the provisional row, carries `truncated`. |
| Export | `reason:"export"` (and a reason-less transcript) never touches the projection. |
| Meeting boundaries | Live `line`/`caption`/snapshot are rejected while a history meeting is active; `meeting` detail for a superseded selection is rejected; switching meetings isolates and clears. |
| Empty / reset | Blank text never occupies a row; empty snapshot clears; `reset` returns the initial state including counters. |
| Errors | Rejections increment `rejected` and record `lastError` without moving content. |

No DOM, network, clock, storage, global, `any`, unsafe cast, sleep or poll appears in either file
(`green/03-forbidden-api-scan.txt`; the single match is the word "document" inside a comment).

## Commands run

| Command | Result | Evidence |
| --- | --- | --- |
| `bun test tests/transcript-state.test.ts` (before implementation) | RED — `Cannot find module '../public/transcript-state.ts'` | `red/01-missing-reducer.txt` |
| `bun test tests/transcript-state.test.ts` | 56 pass / 0 fail, one run | `green/01-focused-green.txt` |
| `bunx tsc --noEmit -p green/tsconfig.caret-task8.json` | exit 0 under `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noUnusedLocals` | `green/02-strict-typescript.txt` |
| LSP diagnostics on both files | no diagnostics | recorded in this README |
| `bun test tests/transcript-state.test.ts tests/public-dom-protocol-contract.test.ts` | 79 pass / 0 fail | `green/05-final-focused-green.txt` |
| `bun run manual/driver.ts` (real module, twice) | byte-identical across processes | `manual/01-driver-output.txt`, `manual/02-determinism.txt` |
| `git diff --check` | exit 0 | `green/04-worktree-status.txt` |

## Mutation proofs (RED before restoration)

| Mutation | Failing assertions | Evidence |
| --- | --- | --- |
| A: remove duplicate suppression in `applyLine` | 4 fail (3 duplicate-suppression tests + minibar no-duplicate) | `red/02-mutation-a-dedupe.txt` |
| B: final no longer supersedes the provisional caption | 2 fail (matching-final and corrected-final replacement) | `red/03-mutation-b-replacement.txt` |
| C: snapshot appends instead of replacing | 2 fail (snapshot replacement, empty-snapshot clear) | `red/04-mutation-c-snapshot-append.txt` |
| D: accept stale `meeting` detail | 1 fail (stale meeting rejection) | `red/05-mutation-d-stale-meeting.txt` |

After each mutation the file was restored from a byte-copy and re-hashed to
`a940c77f...c695`, the exact pre-mutation content.

## Manual QA

`manual/driver.ts` drives the real module through: Korean interim → longer interim → final;
misheard interim corrected by a differently worded final; duplicate final replay; multiline final
(whitespace collapsed, content preserved); out-of-order late final; snapshot replacement with
truncation; export transcript (no effect); history meeting activation; stale meeting-77 detail;
live line during history; meeting-101 detail; three malformed payloads (string speaker, `null`
frame, unknown type); return to live; reset. Output in `manual/01-driver-output.txt` matches the
contract table above at every step.

## Boundary

- Physical root and `git rev-parse --show-toplevel` recorded in `baseline/00-boundary.txt`.
- `public/app.js`, `public/transcript-overlay.js`, `src/session.ts` and the protocol fixture were
  re-verified byte-identical to the task-8 baseline (`cleanup/01-protected-unchanged.txt`).
- `public/ui-state-machine.ts` changed during this task; it is owned by the parallel todo-7 agent
  and was only read here, never written.
- No commit, staging, reset or restore was performed. Temporary copies under `/tmp` were removed
  (`cleanup/02-temp-cleanup.txt`); `manual/driver.ts` is intentionally retained as evidence.
