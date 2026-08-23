# RED evidence — task 4

1. `../02-red-initial.txt` — the first run of `tests/public-caret-harness.test.ts`
   before any fixture/driver existed: the intended API (`tests/fixtures/caret-ui-states.ts`,
   `tests/helpers/caret-browser-driver.ts`) is missing, so the suite cannot even load.
2. `red-event-order-mutation.txt` — behavioral RED. The driver was temporarily mutated to
   broadcast the trigger frame BEFORE arming the in-page subscription. The
   event-before-trigger test fails with `subscribedAtSeq (1) < triggeredAtSeq (1)` violated,
   proving the guard detects a real synchronization regression rather than passing vacuously.
   The mutation was reverted byte-for-byte (`diff -q` clean) and GREEN re-recorded.
