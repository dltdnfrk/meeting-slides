# Todo 17 — Rebuild and verify the macOS application bundle

Plan: `.omo/plans/caret-clone-redesign.md` (caret-clone-redesign). Task: `st_019ff1ab`.
Host: macOS 26.5.2 (Build 25F84), arm64 (Apple M5 Pro). All SHA-256; receipt volume in `CHECKSUMS.txt`.

## Result: done

- `scripts/build-app.sh` exits 0 into the canonical install dir (`green/09`, `manual/01*`).
- `$HOME/Applications/Meeting Slides.app` rebuilt from the current post-15/16 sources;
  `codesign --verify --deep --strict` exit 0; ad-hoc, identifier `com.meetingslides.app`,
  no Developer ID, no notarization (`manual/02`, `manual/11`).
- New artifact verifier `scripts/verify-app.sh` passes on the installed bundle and fails on
  every damage class exercised (missing `project-path.txt` / `Info.plist` / executable,
  truncated binary, marker pointing at a dir without `server.ts`) (`manual/04`).
- `tests/app-bundle.test.ts`: 29 pass / 0 fail; combined with the three prior native suites
  153 pass / 0 fail in a single run (`green/09-green-final-focused.txt`).
- Repository `Meeting Slides.app` symlink resolves to the canonical install and is never
  repointed by a redirected build (`tests`, `manual/11`).
- Screen-capture matrix run with public APIs only; decision: ship **no** exclusion claim,
  use **no** exclusion API (`capture-matrix/README.md`, `capture-matrix/CLAIM-DECISION.md`).

## TDD receipts

- RED: `red/01-red-missing-packaging-contract.txt` — 8 fail / 19 pass before the fix
  (calendar usage strings missing, unconditional symlink repoint, no verifier script,
  missing server.ts validation, bare-binary project resolution).
  Plus live defect capture: `baseline/03-probe-build-symlink-defect.log` proves the build
  redirected the repo symlink into a temp install dir on a `MEETING_SLIDES_APP_DIR` build.
- GREEN: `green/01-green-app-bundle.txt` (29/29 after the smallest fix),
  `green/03-green-all-native-and-bundle.txt` (153/153), `green/09-green-final-focused.txt`
  (final re-run after the signal-handler fix, 153/153).
- SIGTERM-orphan fix RED/GREEN: `manual/10-signal-orphan-fix.txt` — pre-fix launcher source
  had zero occurrences of `makeSignalSource`/`handle(.interrupt)`; new bundle-log lines
  `시그널 받음 sig=15` + `런처 종료 code=0`, no orphan bun, port 8789 free.

## Bundle receipts (installed)

| File | SHA-256 |
| --- | --- |
| `Contents/MacOS/meeting-slides` | `f77a58fb22bbe5a63de7ea7fbbfeb79cbbedd12be8674fc78811b8d0fc66b6c2` |
| `Contents/Info.plist` | `1b22a6d3c58c297be772bc6f122b6e83af39cab03f319bedeb9ca0d0443f6df4` |
| `Contents/Resources/project-path.txt` | `55182b91c2255401a77db395b8b7b97c1dccb482721f890337d584693cc7ae0a` |
| `Contents/_CodeSignature/CodeResources` | `ad3c20a34d7ac63497f1f0f79b2e261b22ed4d322d6ac3f8b2fb6d0b62a0c344` |

Info.plist now carries `NSMicrophoneUsageDescription`, `NSCalendarsUsageDescription`,
`NSCalendarsFullAccessUsageDescription`; identity/version preserved
(`com.meetingslides.app`, 0.3.0/3, `meeting-slides`, LSMinimumSystemVersion 13.0,
LSUIElement=false). `project-path.txt` still resolves to this checkout.

## Manual QA through the installed `.app`

- Readiness: project line → `.env` parse (`HTTP_PORT=8789`) → server start →
  `웹앱 ready → 브라우저 오픈 http://localhost:8789/` → `미니바 준비됨 port=8789`
  (`manual/05-launch-readiness.json`, `manual/06-running-state.txt`).
- Real surfaces: menu-bar extra present at AX with status text
  `Meeting Slides — 대기 중` / glyph `○`; collapsed minibar panel at CGWindow
  (1136,854) 360x56, deterministic 16px gutter on the 1512x910 visible frame,
  layer 3, offered by `SCShareableContent` with readable 360x56 pixels
  (`manual/07*`, `manual/07-real-minibar-bounds-capture.json`).
- Reconnect: two fresh WS handshakes received the identical authoritative
  snapshot (`manual/08b-reconnect-probe.json`).
- Quit: SIGTERM at idle, launcher exits 0, owned bun terminated, port free, no
  orphan (post-fix; pre-fix this orphaned the server — fixed in this task).
- Capture start/stop: **not exercised against the live mic server** — starting a
  real capture would open the MacBook mic and write meeting data to the user's
  database, which is not "if practical" in a non-interactive QA shell. The
  capture command path is covered identically by the bundle's transport/Stop-guard
  suites and task-14 manual/05 (5 real clicks → 1 `stopCapture`).

## Honest environment limits (recorded, not hidden)

1. **GUI `open -a` is TCC-blocked in this context.** Launching the installed app
   via `open -a` stalls the process on the hidden fdma `~/Documents` consent gate:
   the launcher never reaches readiness (`manual/05` shows the timeout). Directly
   executing the same binary from the shell inherits the terminal's consent and
   reaches every readiness milestone. The old pre-refactor bundle behaves
   identically, so this is machine consent state, not a regression of the rebuild.
   *No source/claim was weakened to account for it.*
2. **Synthetic clicks do not reach the panel from this shell** even with
   `AXIsProcessTrusted=true`: `CGEvent` posts from a non-Full-Disk-Access agent
   context are not delivered to the borderless non-activating panel, and the
   borderless panel exposes no AX window to `System Events`. Disclosure/Stop by
   click injection is therefore unobservable here; those actions are covered
   headless by `tests/native-minibar.test.ts` and interactively by task-14
   manual receipts (05/11). `manual/08-click-injection-limits.txt`.
3. **Full-display screen-capture leg**: SCK display filter did not include this
   process's window even at the default sharing type in this context — recorded
   as INCONCLUSIVE with a validity control, not as "excluded"
   (`capture-matrix/02-display-leg.json`, `capture-matrix/README.md`).

## Protected/unrelated state

- `git status` delta vs baseline: two new untracked files only
  (`scripts/verify-app.sh`, `tests/app-bundle.test.ts`); `git diff --check` exit 0
  (`green/11-diff-check.txt`).
- Task-2 protected manifest re-run: differences are (A) 95 `ulw-research` files
  that were dataless at baseline and have since been materialized by macOS
  iCloud hydration — now provable by real content hash — and (B) 8 files whose
  mtimes all predate this task's window (sibling Todos 6/11–16: `DESIGN.md`,
  plan, `server.ts`, `public/app.js`, `public/index.html`, `public/style.css`,
  `public/caret-shell.css`, `public/operator-surface.js`). Nothing under
  `models/`, `provider/Alibaba` files, `HANDOFF.md`, audit dirs, or
  `.omo/plans/`/`.omo/boulder.json` changed during the window
  (`.omo/start-work/ledger.jsonl` was already `M` at baseline; untouched here).
  `green/08-protected-integrity-attribution.txt`.
- Todo-5 `NativeSurfaceContract.swift` and Todo-10 `TransportClient.swift`
  remain byte-identical to their DoneClaim hashes (`green/12-source-hashes.txt`).

## Cleanup

- No launcher/bun process running; no port among 8787/8789/8899/8901/48988 bound.
- Rollback bundle backup (`$TMPDIR/ms-task17-backup`), probe build dirs, sample
  captures, probe binaries and ad-hoc `/tmp` outputs removed. Capture-matrix
  `.swift` sources retained as reproducibility receipts (`capture-matrix/`).
- App defaults: none written by this task's binaries (the rebuilt app persists
  only `minibar.frame.v1` after my launch; that is the app's own normal behavior).
- Pre-existing `/private/tmp/ms-*` files from Aug 7–10 were NOT touched
  (sibling artifacts).
