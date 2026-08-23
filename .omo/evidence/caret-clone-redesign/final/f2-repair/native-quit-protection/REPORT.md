# F2 native quit-protection repair

Status: **PASS**
Task: `st_019ff43a`
Parent/root session: `019fef5e-6de0-7b8b-9d1c-e4d629a0379b`
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`
Commit: none created

## Finding repaired

`MinibarWindowController.isCapturing` protected quit only during `.starting` and `.capturing`. During `.stopping` and `.switchingModel`, `LauncherAppDelegate.applicationShouldTerminate` could therefore close the socket and terminate the launcher-owned server before capture work reached authoritative idle, including the server's trailing transcript flush window.

The quit decision now delegates to the pure `CapturePhase.requiresQuitProtection` seam. Its complete rule is `self != .idle`; no wire value, product capability, transport action, process ownership rule, or provider/minutes source changed.

## TDD proof

A deterministic five-row phase table was added through the headless native fixture driver:

| phase | quit protection |
| --- | --- |
| idle | false |
| starting | true |
| capturing | true |
| stopping | true |
| switching-model | true |

The RED run retained the old two-phase predicate and produced **54 pass / 2 fail**. The only failures were the required `.stopping` and `.switching-model` rows. `red-native-minibar.txt` and `red-native-minibar.exit` preserve the output and non-zero status.

After the one-line correction, the same suite produced **56 pass / 0 fail**. The changed test/driver scan contains no sleeps or polling waits.

## Verification

| Check | Result |
| --- | --- |
| `bun test tests/native-minibar.test.ts` | PASS, 56/56 |
| `bun test tests/native-launcher-boundary.test.ts` | PASS, 42/42 |
| `bun test tests/native-surface-contract.test.ts` | PASS, 31/31 |
| Serial native execution | PASS; each file ran separately and in order |
| Focused native aggregate (three files) | PASS, 129/129, 350 assertions |
| `swiftc -typecheck -swift-version 5 macos/*.swift` | PASS |
| LSP, `NativeSurfaceContract.swift` and TypeScript test | clean |
| SourceKit standalone controller/fixture diagnostics | cross-file unresolved-symbol noise; authoritative aggregate typecheck passed |
| `scripts/build-app.sh` | PASS; installed `$HOME/Applications/Meeting Slides.app` |
| `scripts/verify-app.sh` | PASS |
| independent `codesign --verify --deep --strict` | PASS; ad-hoc identifier `com.meetingslides.app` |
| `git diff --check` | PASS |

Installed-app interactive quit QA was not feasible without crossing the explicit microphone boundary: launcher startup unconditionally calls `requestMicAccess()` before minibar connection. Starting the real server could also touch the user meeting database. No app process was launched and no permission/database was touched; see `installed-app-quit-qa.txt`. This does not block the repair because the exact phase decision, controller delegation, aggregate compilation, installed artifact, and signing are all verified.

## Scope and isolation

Pre- and post-repair `git status --short` are byte-identical. The target native/test files were pre-existing untracked dirty work, so baseline and final SHA-256 receipts are included. No plan, ledger, F2 checkbox, F3/F4 artifact, provider source, minutes source, unrelated test, commit, or staging state was changed.
