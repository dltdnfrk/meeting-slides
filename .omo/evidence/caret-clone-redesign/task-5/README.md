# Task 5 — Establish native compiler and geometry test seam

Plan: `.omo/plans/caret-clone-redesign.md` (Wave 1, Todo 5)
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides` (git toplevel confirmed)
Baseline HEAD: `a1ed25f95980980cd958044b90e739ac45e8280d` (branch `main`, no commit made)

## What was delivered

| Path | Role |
| --- | --- |
| `macos/NativeSurfaceContract.swift` | Pure Swift state/geometry module. Imports **Foundation only** — no AppKit, no window creation, no screen query, no clock, no networking. |
| `tests/fixtures/native-surface-driver.swift` | Deterministic fixture driver. Reads a scenario batch on stdin, emits one JSON document on stdout. Typed failures instead of crashes. |
| `tests/native-surface-contract.test.ts` | Bun suite. Compiles the module + driver with `swiftc` **once** in `beforeAll`, runs the driver **once**, asserts on the parsed result. No GUI, no SwiftPM, no sleeps/polling. |

The seam is a test seam only. `scripts/build-app.sh` is intentionally **not** wired to the new
module (asserted by a test); packaging belongs to Todo 17.

## Contract locked by this task

- Collapsed bounds exactly `360x56`; expanded exactly `560x220`.
- `16px` gutter on every display edge; default frame is the bottom-trailing corner of the active display.
- Saved frame keeping `>= 50%` of its area on a display is restored there and clamped into the gutters.
- Saved frame below the 50% threshold (or degenerate/off-display) returns the deterministic default frame.
- Multi-display: the display holding the largest share wins; the frame stays on that display.
- Decode subset: `capture` (capturing/mode/phase/startedAt) and `status`. Phase-less capture messages map
  compatibly (`capturing` -> `capturing`, otherwise `idle`). Messages outside the subset are ignored, not errors.
- Typed failures, never crashes: `malformedPayload`, `unknownPhase`, `invalidDisplayBounds`, `noActiveDisplay`.
- Duplicate Stop guard: rapid activations emit exactly one `stopCapture`; idle/stopping/switching-model emit none;
  the guard rearms only on an authoritative snapshot leaving the `stopping` phase.
- Timer is always derived from the server `startedAt`; the module holds no stopwatch and no meeting store.

## Receipts

### baseline/
- `00-boundary.txt` — canonical root, git toplevel/origin/branch/HEAD, pre-work `git status --short`, toolchain versions.
- `01-launcher-build-invariants.txt` — SHA-256 of every pre-existing dirty file (protected work), plus the
  characterized launcher/build invariants: imports, default port 8787, `runtime-bootstrap` readiness signature,
  no WebKit, `api/auto-capture`, `swiftc -O` compile line, codesign verify, WebKit-linkage rejection, installed Info.plist.

### red/ (failing-first proof)
- `01-red-missing-seam.txt` — **27 fail / 4 pass**, exit 1. The 4 passes are the launcher/build invariants
  (already true at baseline); every assertion needing the seam fails because the sources do not exist.
- `02-mutation-gutter.txt` — gutter `16 -> 12`: exactly the 2 gutter tests go RED.
- `03-mutation-visibility.txt` — threshold `0.5 -> 0.1`: exactly the `<50%` intersection test goes RED.
- `04-mutation-stop-guard.txt` — suppression removed: exactly the 2 duplicate-Stop tests go RED.
- `05-mutation-unknown-phase.txt` — unknown phase coerced to idle: exactly the typed-failure test goes RED.

Each mutation was reverted from a byte-identical backup (hash equality shown in the run log).

### green/
- `01-green-focused.txt` / `07-green-final.txt` — `bun test tests/native-surface-contract.test.ts` -> **31 pass / 0 fail**, exit 0, one run, zero retries.
- `02-swiftc-typecheck.txt` — `swiftc -typecheck` on module + driver, exit 0; `macos/launcher.swift` also typechecks clean.
- `03-full-bun-test.txt` — full `bun test`: 370 pass / 36 fail. The seam suite is **31/31 pass** inside this run.
- `04-diff-check.txt` — `git diff --check` exit 0.
- `05-failure-attribution.txt` — attribution: this task created 3 files and modified **zero** existing files;
  no other file references the seam; the seam opens no server/port/DB. `tests/public-shell.test.ts` fails
  identically with the seam test file removed -> the 36 failures are pre-existing / owned by concurrently
  running sibling Wave-1 tasks, not caused here.
- `06-protected-integrity.txt` — all 19 protected dirty paths byte-identical to baseline (`changed_count=0`);
  `macos/launcher.swift` and `scripts/build-app.sh` hashes unchanged.
- `08-typecheck-ts.txt` — `tsc --strict` on the seam test, exit 0. LSP diagnostics clean.
- `09-unrelated-failures.txt` — the 36 full-suite failures itemized by name, **recorded and not fixed**
  (out of scope for this todo), with attribution and the seam suite's 31/31 result inside the same run.

### manual/ (real Swift fixture driver, compiled and executed by hand)
- `00-build.txt` — manual `swiftc -O` compile into a temp dir, exit 0, 131720-byte binary.
- `01-happy-*` — happy batch: collapsed `360x56`, expanded `560x220`, default frame `x=1352,y=1045` on a
  1728x1117 display (both `16px` gutters), capture decode with `phase=starting`, 5 Stop activations -> `emitted=1`.
  exit 0, **stderr empty**.
- `02-bad-json-*` — truncated JSON, HTML body, bare `null`, bare array, wrong field type, unknown phase.
  All six return typed failures (`malformedPayload` x5, `unknownPhase`), exit 0, **stderr empty**, no crash.
- `03-bad-bounds-*` — zero-size, negative, too-small-for-surface displays -> `invalidDisplayBounds`;
  empty display list -> `noActiveDisplay`; off-display and degenerate saved frames -> deterministic default
  `usedSavedFrame=false`. exit 0, **stderr empty**, no crash.
- `04-malformed-batch-*` / `05-empty-stdin-*` — non-JSON and empty stdin -> `malformedBatch`, exit 1, still valid JSON on stdout.
- `06-stale-state-and-repeat.txt` — stale-state probe (`stopping`/`switching-model` snapshots emit nothing,
  `starting` emits one), byte-identical output across repeated runs (`DETERMINISTIC=yes`), 5 sequential
  invocations with identical SHA-256, SIGINT mid-run exits 130 with no partial stdout.
- `07-cleanup.txt` — manual build dir removed; no stray driver binary anywhere in the repo; no leftover
  temp dirs in `TMPDIR`; only the 3 source files remain untracked.

## Adversarial probes

| Probe | Result |
| --- | --- |
| `malformed_input` | Truncated/non-JSON/null/array/wrong-type payloads and a non-JSON stdin batch all produce typed failures with clean stderr and no crash (`manual/02`, `manual/04`, `manual/05`). |
| `stale_state` | `stopping` and `switching-model` snapshots never rearm the Stop guard; the guard rearms only on authoritative non-stopping snapshots (`manual/06`, GREEN test "rearms only after an authoritative idle snapshot"). |
| `dirty_worktree` | 19 pre-existing dirty paths hashed before work and re-verified byte-identical after (`green/06`). No staging, reset, restore or commit performed. |
| `generated_artifacts` | The Bun suite builds into `mkdtemp` and removes it in `afterAll`; the manual binary was deleted; repo-wide search finds no stray binary (`manual/07`). |
| `misleading_success_output` | The driver exits 1 on a malformed batch rather than reporting empty success; the suite asserts `driverStderr === ""` and `driverExit === 0`; four source mutations each produce targeted RED, proving assertions bind real behavior (`red/02`-`red/05`). |
| `repeated_interruptions` | 5 sequential driver runs give identical SHA-256; SIGINT mid-run yields exit 130 with no partial stdout (`manual/06`). |
| `flaky_tests` | No sleep, no polling, no timing dependency: compile and run happen once in `beforeAll`, all assertions read a pure in-memory parse. Focused suite run 4x, always 31/31. |
| `long commands` | Full `bun test` (624 s) ran to completion with output captured to file; `timeout(1)` is absent on macOS, so the tool-level timeout was used instead. |
| `prompt_injection` | **N/A** — no untrusted external content is read. All inputs are literals authored in this task; the driver consumes only stdin supplied by the test/manual commands. |

## Verification summary

- `bun test tests/native-surface-contract.test.ts` -> 31 pass / 0 fail, one `swiftc` invocation, one driver invocation.
- `swiftc -typecheck` and `swiftc -O` compile -> exit 0.
- Malformed payloads and impossible display bounds -> typed failures, no crash, empty stderr.
- Off-display and `<50%` intersection saved frames -> deterministic default frame.
- `git diff --check` -> exit 0. `tsc --strict` on the new test -> exit 0. LSP diagnostics clean.
- All temporary binaries removed. No commit, no staging, no reset. Protected dirty work untouched.
