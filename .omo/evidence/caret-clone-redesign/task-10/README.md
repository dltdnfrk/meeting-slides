# Task 10 — Refactor Swift launcher lifecycle and transport boundary

Plan: `.omo/plans/caret-clone-redesign.md` (Wave 2, Todo 10)
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides` (git toplevel confirmed)
Baseline HEAD: `a1ed25f95980980cd958044b90e739ac45e8280d` (branch `main`, no commit made)
Depends on: Todo 1 (reference) and Todo 5 (native test seam) — both present and preserved.

## What was delivered

| Path | Role |
| --- | --- |
| `macos/AppLifecycle.swift` (new) | Pure lifecycle rules: `.env` port parsing, bun lookup order, log path, Bun launch plan, webapp health signature, startup decision (start vs adopt vs port conflict), readiness fold, process ownership and shutdown effects. Foundation only. |
| `macos/TransportClient.swift` (new) | Pure transport boundary: `/ws` endpoint, connection state machine, reconnect bookkeeping and bounded backoff, decode of the observed subset (reusing Todo 5's `NativeSurfaceDecoder`), outbound command emission with the duplicate-Stop guard. Foundation only. |
| `macos/launcher.swift` (rewritten) | Thin entry point. Keeps every side effect (mic TCC, project resolution, EventKit auto-capture, Process spawn, HTTP probe, browser opening) and asks the pure modules what those results mean. |
| `tests/fixtures/native-launcher-driver.swift` (new) | Headless deterministic driver: scenario batch on stdin, one JSON document on stdout, typed failures instead of crashes. |
| `tests/native-launcher-boundary.test.ts` (new) | Bun suite. Compiles the modules + driver with `swiftc` **once**, runs the driver **once**, asserts on the parsed result. No GUI, no SwiftPM, no sleeps/polling. |
| `scripts/build-app.sh` (1-line change) | The bundle now compiles `macos/launcher.swift macos/AppLifecycle.swift`. |
| `tests/native-surface-contract.test.ts` (1 test block) | Todo-5 invariant test updated: the port/readiness/launch literals moved to their new home; the invariants themselves are unchanged. |

`macos/NativeSurfaceContract.swift` from Todo 5 is **unchanged** (hash matches the Todo-5 DoneClaim:
`d750cd83253b2e6b46dc6a8172769f2b5f3d5c6c0c298da83965f2228df76721`). The transport client reuses its
decoder and `StopCommandGuard` rather than duplicating them.

## Boundaries this task enforces

- **One Bun session.** The launcher probes the configured port first. Unreachable → start and own a
  server. Healthy Meeting Slides response → adopt it and own nothing. Anything else listening →
  typed `portOccupiedByForeignServer`, exit 1, no second server.
- **Termination happens once.** `ServerLifecycle` is the only place a termination is requested;
  reaching `exited` makes every later interrupt/quit a no-op. An adopted server is never terminated.
- **A dead socket is not a stopped meeting.** `closed` moves the connection to `reconnecting` and
  deliberately retains the last authoritative capture projection; only a server snapshot changes it.
- **Malformed input is typed, never fatal.** Truncated JSON, an HTML error body, `null`, a bare array,
  a wrongly typed field and an unknown phase all increment `decodeFailures` with a machine-readable
  `lastDecodeError` and leave the projection intact.
- **No new protocol spellings.** The only outbound frame is `{"action":"stopCapture"}`. `/ws`,
  `api/auto-capture`, `OPEN_BROWSER`, `HTTP_PORT` and the `capture`/`status` subset are unchanged.
- **No second engine.** The pure modules hold no meeting store, no stopwatch (timer derives from
  server `startedAt`), no Pause/share concept, and no AppKit/EventKit/WebKit import.

## Receipts

### baseline/
- `00-boundary.txt` — canonical root, git toplevel/origin/branch/HEAD, pre-work `git status --short`, toolchain versions.
- `01-protected-hashes.txt` — SHA-256 of every pre-existing dirty path before any write.

### red/ (failing-first proof)
- `01-red-missing-seam.txt` — **37 fail / 3 pass**, exit 1. The 3 passes are launcher/build invariants that
  already held at baseline; everything needing the new seam fails because the modules do not exist.
- `02-mutation-adopt.txt` — a healthy running server is "started" again instead of adopted → exactly the
  adoption test goes RED (1 fail / 41 pass).
- `03-mutation-phantom-stop.txt` — socket close clears the capture projection → exactly the
  "retains last known capture state" test goes RED.
- `04-mutation-double-terminate.txt` — the `state == .running` guard removed → exactly the
  "repeated interrupts terminate the child exactly once" test goes RED.
- `05-mutation-offline-stop.txt` — the online check removed from Stop → exactly the
  "Stop while the socket is down emits nothing" test goes RED.

Every mutation was reverted from a byte-identical backup (hash equality shown in the run log).
While probing the double-termination invariant, two redundant guards were found (`state` and a
`terminationRequested` flag) that made each other untestable; the flag was removed so a single
mechanism enforces the rule and the mutation now kills the test.

### green/
- `01-green-focused.txt` / `08-green-final.txt` — `bun test tests/native-launcher-boundary.test.ts tests/native-surface-contract.test.ts`
  → **73 pass / 0 fail**, exit 0, one run, zero retries.
- `02-swiftc-typecheck.txt` — `swiftc -typecheck` of the bundle target (launcher + AppLifecycle) and of the
  full pure seam (contract + lifecycle + transport + driver), both exit 0.
- `03-full-bun-test.txt` — full `bun test`: 548 pass / 36 fail. This task's suites are 42/42 and 31/31 inside that run.
- `04-diff-check.txt` — `git diff --check` exit 0.
- `05-failure-attribution.txt` — the 36 failures are Puppeteer browser, LLM transport, scene/PPTX and
  recorder suites. None loads a macOS Swift source or the build script.
- `06-protected-integrity.txt` — protected-path comparison plus attribution for the three deltas.
- `07-typecheck-ts.txt` — `tsc --strict --noEmit` exit 0; LSP error diagnostics clean.

### manual/ (real compile + run, no production UI opened)
- `00-build.txt` — real `swiftc -O` build of the headless driver, exit 0.
- `01-happy-*` — happy batch: port, launch plan, fresh-start and adopt decisions, a full
  open→capture→status→close→reopen→idle transport run, 5 rapid Stops → **one** `stopCapture`,
  and `interrupt,interrupt,quit,serverExited:9` → **one** termination. exit 0, stderr empty.
- `02-adversarial-*` — port conflict (200 foreign body and 503), missing bun, truncated JSON, HTML body,
  bare `null`, bare array, wrong field type, unknown phase, adopted-server repeat interrupts, unknown
  scenario kind, unknown event kind. All typed failures, exit 0, stderr empty, no crash.
- `03-malformed-batch.txt` — non-JSON stdin, empty stdin and a batch without `scenarios` each exit 1 with a
  typed `malformedBatch` instead of faking success; 5 identical runs produce one identical SHA-256.
- `04-build-app-temp-dir.txt` — real `scripts/build-app.sh` run into a temp install dir with the split
  sources: swiftc, plutil, codesign `--force --deep`, `codesign --verify --deep --strict` and the
  WebKit-linkage rejection all pass, exit 0.
- `05-symlink-restore.txt` — the temp build repoints the repo `Meeting Slides.app` symlink as a side
  effect; it was restored to `$HOME/Applications/Meeting Slides.app` and the temp bundle deleted. The
  installed app was **not** rebuilt (that is Todo 17).
- `06-launcher-port-conflict.txt` — the **real compiled launcher binary** against a foreign HTTP server on
  its configured port: refuses, logs the conflict, exits 1, spawns no Bun.
- `07-launcher-adopts-running-server.txt` — the real binary against a healthy Meeting Slides signature:
  adopts the session, opens the browser once, exits 0, spawns no second Bun.
- `09-process-port-cleanup.txt` — no orphan process or listener left by this task. One `bun run server.ts`
  exists (PID 4380, started 11:19, hours before this task) — a pre-existing user session.
- `10-cleanup.txt` — every temporary binary and temp directory removed; repo-wide search finds no stray artifact.

## Deliberately excluded

- AppKit menu-bar item and `NSPanel` minibar — Todo 14.
- Packaging `NativeSurfaceContract.swift` / `TransportClient.swift` into the shipped bundle and rebuilding
  the installed `.app` — Todo 17. A test asserts they are **not** wired yet.
- Wiring the transport client into the launcher's runtime: nothing in the shipped app consumes native
  server state until the minibar exists. The client is a compiled, tested seam.
- All pre-existing dirty provider/Alibaba/model/handoff work — untouched.
