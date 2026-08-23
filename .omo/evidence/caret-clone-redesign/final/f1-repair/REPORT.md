# F1 rejection gap #1 repair report

Status: **CLOSED WITH PRE-EXISTING/UNRELATED EXCEPTIONS**  
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Task: `st_019ff3d4`  
Date: 2026-08-12

## Decision

Exactly one current post-fix full `bun test` attempt was run and retained under `full-suite/`. It completed **972 pass / 9 fail** (exit 1, 981 tests across 74 files). Every failure was attributed against the captured dirty baseline.

One failure was Caret/Todo 15 related: the shipped page referenced `/focus-trap.js`, but that product module was absent in the baseline source inventory. The real-keyboard regression then exposed review-dialog focus traversal. The smallest repair supplies the DOM-neutral focus trap and makes the existing regression identify repeated review controls uniquely. Focused verification is **14 pass / 0 fail**, with clean error diagnostics for the product and test files.

The other eight failures are the same protected provider/minutes failures retained before this repair. No provider, Alibaba, minutes, plan, ledger, F1 checkbox, or F2-F4 file was changed for them. A bounded aggregate containing all other current test files completed **966 pass / 0 fail** in one command, including the repaired Todo 15 suite and every other plan-related suite.

This meets the task's alternate acceptance route: every remaining full-run failure is precisely evidenced as pre-existing/unrelated, while all plan-related tests are green together in the post-repair aggregate.

## Required full-suite attempt

Artifacts:

- `full-suite/attempt-metadata.txt` - canonical root, HEAD, Bun version, timestamps, command, exit.
- `full-suite/dirty-baseline-status.txt` and `dirty-baseline.patch` - dirty state at invocation.
- `full-suite/dirty-baseline-source-sha256.txt` - source/test hashes at invocation.
- `full-suite/bun-test.txt` - complete output.
- `full-suite/exit-status.txt` - `1`.

Result: **972 pass / 9 fail / 4864 expectations / 981 tests / 74 files**.

No second whole-suite attempt was made.

## Failure attribution

| Current full-run failure | Attribution | Proof and disposition |
| --- | --- | --- |
| Todo 15 review dialog wraps Tab forward | **Plan-related; repaired** | The captured baseline inventory has no `public/focus-trap.js`, although `public/index.html` requests it. The focused RED receipt demonstrates focus escape/incorrect traversal. The repaired module recomputes current tabbables on every real Tab keydown, wraps only at boundaries, and keeps no inert/tabindex residue. Repeated review controls now receive unique test probe identities. Focused final: 14/14; aggregate: green. |
| LLM detectBlock HTTP parses provider content | **Pre-existing protected provider mismatch** | Same failure appears in Todo 19's retained full run and isolated characterization. `src/llm.ts` still exactly matches Todo 2's protected hash. No provider code changed. |
| LLM detectBlock CLI parses stdout | **Pre-existing protected provider mismatch** | Same prior and current failure; protected `src/llm.ts` hash matches Todo 2. |
| LLM detectBlock CLI nonzero error wording | **Pre-existing protected provider mismatch** | Stale Korean expectation versus protected implementation's current English/path-bearing error; identical prior/current failure. |
| Generic HTTP chat defaults | **Pre-existing protected provider mismatch** | Test expects temperature 0.3 / 4000; protected implementation emits 0 / 6000. Identical prior/current failure. |
| Generic CLI chat nonzero error wording | **Pre-existing protected provider mismatch** | Identical stale wording mismatch before and during this repair. |
| Generic CLI chat timeout wording | **Pre-existing protected provider mismatch** | Identical stale Korean timeout expectation versus protected implementation. |
| `startReview` action integration timeout | **Pre-existing unrelated minutes test** | Exact 10s timeout exists in Todo 19's isolated pre-repair receipt and both retained full runs. This repair changes only focus containment/test identity; the bounded aggregate exercises all shared server/minutes code outside this known test and is clean. |
| `setAttendees` action integration timeout | **Pre-existing unrelated minutes test** | Exact 10s timeout exists in Todo 19's isolated pre-repair receipt and both retained full runs. No attendees/minutes/server product file was changed by this repair; all remaining shared-code suites are aggregate-green. |

`protected-provider-hash-comparison.tsv` independently records MATCH for `src/llm.ts`, `src/providers.ts`, and `src/provider-adapters.ts` against Todo 2's before table.

## Repair and focused verification

Hypothesis: the page declared a focus-trap asset but lacked the asset, allowing native Tab traversal to leave dialogs; the initial regression's class-only identities also conflated repeated review controls.

Repair:

- `public/focus-trap.js`: one active-dialog stack, current-DOM tabbable calculation per keydown, real Tab/Shift+Tab boundary wrapping, no DOM residue.
- `tests/public-caret-accessibility.test.ts`: retained real-keyboard regression with bounded traversal and unique per-control identities; no sleeps or polling delays.

Verification:

- `bun test tests/public-caret-accessibility.test.ts --test-name-pattern 'every shipped dialog traps'` -> **14 pass / 0 fail** (`accessibility-repair/focused/focus-trap-final.txt`).
- LSP error diagnostics for both changed files -> **clean**.
- `git diff --check` -> **exit 0**.

## Post-repair aggregate

Command construction and exact included/excluded manifests are retained in `aggregate/`.

- Included: every `src/**/*.test.ts` and `tests/**/*.test.ts` except the three files owning the eight independently evidenced unrelated failures.
- Excluded only: `tests/llm-transport.test.ts`, `tests/start-review-action.test.ts`, `tests/attendees-action.test.ts`.
- Result: **966 pass / 0 fail / 4852 expectations / 71 files**, exit 0.
- The aggregate includes the complete Todo 15 accessibility file; its dialog-trap block is green in the same output.

## Governance

- HEAD remains `a1ed25f95980980cd958044b90e739ac45e8280d`.
- No commit or staging operation was performed.
- No protected provider/Alibaba changes were touched.
- No plan, ledger, F1 checkbox, or F2-F4 work was performed.
- `CHECKSUMS.txt` authenticates the report, DoneClaim, and retained command evidence.
