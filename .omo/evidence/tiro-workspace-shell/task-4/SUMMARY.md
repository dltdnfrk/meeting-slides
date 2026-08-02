# task-4: listMeetings session rail

## Commit target
`feat(sessions): listMeetings rail and store query`

## Shipped
- `MeetingStore.listMeetings()` → `{id,title,started_at,status}` (title from first slide or `회의 #id`)
- WS action `listMeetings` + `meetings` broadcast on slide/reset/start/stop
- Left rail UI: empty state, rows, count, click highlight, historical toast stub
- Session row styles in `public/workspace-shell.css`

## Verification
- `bun test tests/store.test.ts tests/public-sessions.test.ts` → 9 pass / 0 fail
- `bunx tsc --noEmit` → clean
- `git diff --check` → clean
- Hermetic public test covers empty list, non-empty render + select, malformed payload

## Evidence files
- tests-sessions.txt
- tsc.txt
- diff-check.txt
- edge-notes.md
