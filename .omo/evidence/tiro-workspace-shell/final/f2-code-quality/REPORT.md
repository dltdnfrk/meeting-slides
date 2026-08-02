# F2 Code quality

## LOC (non-blank non-//)

- `public/app.js`: ~679 pure-ish LOC; any-token≈0
- `public/workspace-shell.css`: ~277 pure-ish LOC; any-token≈0
- `public/workspace-split.js`: ~118 pure-ish LOC; any-token≈0
- `public/transcript-resize.js`: ~85 pure-ish LOC; any-token≈0
- `server.ts`: ~581 pure-ish LOC; any-token≈0
- `src/store.ts`: ~284 pure-ish LOC; any-token≈0
- `src/session.ts`: ~367 pure-ish LOC; any-token≈0

## Linear history 4a0b40a..HEAD: 7 commits, merges=0
```
7953a88 test(ui): hermetic tiro workspace shell e2e
d745c16 test(ui): add center-stage responsive evidence captures
eee3713 fix(ui): keep visual stage in center pane under workspace shell
b63fe97 feat(sessions): listMeetings rail and store query
6e753ad feat(ui): dock transcript panel with multi-edge resize
a615100 feat(ui): resizable workspace splitters with persistence
4347227 feat(ui): add tiro-style three-pane workspace shell
```

## Verdict
WATCH
Note oversized candidates: ['public/app.js', 'public/workspace-shell.css', 'server.ts', 'src/store.ts', 'src/session.ts'] (pre-existing shell/server size; no new god modules this plan)
