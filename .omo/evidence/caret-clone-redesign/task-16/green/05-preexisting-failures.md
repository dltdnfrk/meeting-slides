# Task 16 — pre-existing failures, reproduced and attributed (NOT chased)

Plan rule: "Reproduce/attribute pre-existing failures rather than chasing them."

## A. tests/public-transcript-dock.test.ts — 6 failures

Describe block: `전사 패널 다중 모서리 리사이즈` (transcript panel resize grips).
Subject: `public/transcript-resize.js`, persisted key `workspace.transcript.v1`.

Isolation proof (three independent reverts, same result every time):

| Condition | Result |
| --- | --- |
| Full task-16 worktree | 9 pass / 6 fail |
| task-16 `public/app.js` Stop hunk reverted in place | 9 pass / 6 fail |
| task-16 `server.ts` `capturePhase()` reverted to pre-task `captureMessage()` | 9 pass / 6 fail |

`public/transcript-resize.js` is clean in the worktree (last touched by commit
bcf5c7a, which predates this plan). Todo 16 changed `public/app.js`, `server.ts`
and `tests/server-ws-dispatch.test.ts` only; none of them owns a resize grip.

## B. tests/public-shell.test.ts — 1 failure

Test: `라이브 MeetingCard 렌더 > 히스토리 미리보기에서도 같은 카드 레이아웃을 쓴다`.
Symptom: `page.click(".thumbnail")` → "Node is either not clickable or not an Element".

Isolation proof:

| Condition | Result |
| --- | --- |
| Full task-16 worktree | 7 pass / 1 fail |
| `public/app.js` restored to HEAD (all plan work removed from that file) | 7 pass / 1 fail |

Identical at HEAD, so this is not Todo 16's. It is already recorded in
`.omo/evidence/caret-clone-redesign/task-14/green/06-failure-attribution.txt`,
which lists `tests/public-shell.test.ts` among the suites already failing when
Todo 14 ran. The thumbnail is laid out by the shell surfaces Todos 11-13
rebuilt; Todo 18 re-authors those layers.

## C. tests/server-ws-dispatch.test.ts — flake CLOSED by this task

Not left failing. Its single 10s per-await budget bounds REAL work (spawned
server, real capture start/stop, real transcript flush, real file writes) and it
was already marginal BEFORE this task: with the HEAD test body and the pre-task
`captureMessage()`, four isolated runs measured 6881ms, 5105ms, **10029ms (fail)**
and 4277ms.

Todo 16 asserts one further authoritative frame in that same window, so the
budget was raised to 30s per await (test bound 60s) and the two flush-driven
awaits were armed together instead of stacked. Nothing sleeps or polls; the
bound only converts a genuine hang into a failure.

Result after the change: 5/5 isolated runs pass, 2/2 six-suite batch runs pass.
