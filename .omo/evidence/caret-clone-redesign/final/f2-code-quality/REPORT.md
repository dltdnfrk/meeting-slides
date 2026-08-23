# F2 Code Quality Review

## Verdict

**REJECT**

Approval is blocked by one medium-severity native lifecycle defect and by non-clean required test evidence. No product, governance, test, or source file was edited during F2.

## Findings

### High

None.

### Medium

1. **Quitting is unguarded while the server still owns a capture stop/model-switch window.**
   - Defect: `macos/MinibarWindowController.swift:218` returns true only for `.capturing` and `.starting`; it returns false for `.stopping` and `.switchingModel`.
   - Consequence: `macos/launcher.swift:186-191` skips confirmation, closes the socket, terminates the launcher-owned server, and exits. During `.stopping`, the server explicitly still flushes trailing transcript frames until authoritative idle (`server.ts:1408-1412`, `server.ts:1552-1559`), so quitting in that window can discard the tail. `.switchingModel` is also a non-idle capture phase and receives the same unguarded termination path.
   - Contract: authoritative capture phases must remain truthful through stopping, clean server termination must preserve capture lifecycle, and the minibar must refuse immediate quit while capture work remains active.
   - Smallest repair: make the quit predicate true for every non-idle `CapturePhase` (at line 218, `return phase != .idle`) and add deterministic phase-table coverage proving idle is false while starting/capturing/stopping/switching-model are true.

### Low

None.

## Required-check results

| Check | Result |
| --- | --- |
| `bunx tsc -p tsconfig.json --noEmit` | PASS |
| `swiftc -typecheck -swift-version 5 macos/*.swift` | PASS |
| `bun run scripts/build-public-modules.ts --check` | PASS; both generated reducers match source |
| `scripts/build-app.sh` | PASS |
| `scripts/verify-app.sh` | PASS |
| `codesign --verify --deep --strict "$HOME/Applications/Meeting Slides.app"` | PASS |
| `git diff --check` | PASS |
| Full `bun test` | FAIL: 991 pass / 8 fail across 75 files |
| Bounded aggregate excluding the three independently attributed files | NON-CLEAN: 975 pass / 2 fail; both `tests/pdf.test.ts` failures were browser-spawn `ENOENT` during concurrent execution, while those cases passed in the simultaneous full run. This run is inconclusive, not counted as a product defect. |

The eight full-suite failures remain confined to the three previously independently attributed files: `tests/llm-transport.test.ts` (6), `tests/start-review-action.test.ts` (1), and `tests/attendees-action.test.ts` (1). Their current SHA-256 values match the F1 baseline receipts. Protected provider/config/LLM/minutes files listed in `dirty-work-isolation.txt` also match the task-2 baseline. These are reported separately as pre-existing unrelated failures; under this F2 request's stricter requirement that every required check be clean, they still prevent approval.

## Diagnostics

- TypeScript project compilation: clean.
- LSP: `public/` JavaScript clean; `src/` TypeScript clean; `server.ts` has unused-symbol hints only, no errors/warnings.
- Swift directory SourceKit emitted cross-file unresolved-symbol noise because it analyzed files independently. The authoritative aggregate `swiftc` typecheck and app build both passed.
- Generated artifacts match canonical TypeScript sources.

## Review coverage

Reviewed changed JS/TS/Swift/CSS/HTML/build code for canonical state ownership, exhaustive transitions, additive protocol compatibility, accessibility/focus semantics, error handling, deterministic synchronization, CSS ownership, native transport/process lifecycle, local-network/privacy claims, packaging, generated artifacts, and dirty-work isolation. No additional high/medium architecture, protocol, accessibility, security/privacy, generated-artifact, or ownership finding was established.

## Smallest repair and verification commands

```sh
# Product repair: macos/MinibarWindowController.swift:218
# return phase != .idle
# Add deterministic phase-table coverage to the native minibar seam.

bun test tests/native-minibar.test.ts tests/native-launcher-boundary.test.ts tests/native-surface-contract.test.ts
swiftc -typecheck -swift-version 5 macos/*.swift
scripts/build-app.sh
scripts/verify-app.sh
codesign --verify --deep --strict "$HOME/Applications/Meeting Slides.app"
bun test
git diff --check
```

Run test gates serially; the recorded bounded aggregate overlapped the full suite and therefore is not acceptable as a clean rerun.

## Scope boundary

F3/F4 were not entered. No commit or staging action was performed.
