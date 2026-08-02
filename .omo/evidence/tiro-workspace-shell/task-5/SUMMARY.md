# task-5: center visual materials lock + responsive

## Shipped
- Confirmed MeetingCard/`#current-slide` render only inside `.stage-pane`
- Compile/export dock controls remain visible
- ≤900/820: session rail collapses (`display:none` at 1180 breakpoint), stage+transcript stack, stage survives
- Fix: `.dock__tabs { flex-wrap: wrap }` so 375px no longer creates document horizontal scroll

## Verification
- `bun test tests/public-workspace.test.ts tests/public-shell.test.ts` → 21 pass
- compile-control regression log attached
- `bunx tsc --noEmit` clean
- Screenshots: narrow-820.png, stage-lock-1440.png
- measurements.txt from 820px live probe

## Commit
`fix(ui): keep visual stage in center pane under workspace shell`
