# F1 Plan Compliance Audit

Status: **FAIL**  
Verdict: **REJECT**  
Task: F1, `.omo/plans/caret-clone-redesign.md`  
Auditor: `st_019ff3cf`  
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Date: 2026-08-12

## Decision

F1 cannot approve because Todo 19 has two exact acceptance-evidence gaps:

1. **The required final full `bun test` pass does not exist.** The sole retained full run at `task-19/verification/verification-bun-test.txt` reports **927 pass / 11 fail**. Two Todo-15 narrow target failures and one Todo-17 app-bundle hook failure were plan-related and were repaired afterward, but only focused post-repair runs were retained (`verification/verification-accessibility-targets.txt`, `verification/verification-app-bundle-test.txt`). The remaining eight failures are credibly attributable to protected pre-existing provider/minutes work, but that attribution does not turn the required full run into a passing run. This fails Todo 19's acceptance criterion “`bun test` passes once with zero retries” and the plan success criterion requiring a clean full `bun test`.
2. **Three independent final reviews are not evidenced.** `task-19/visual-reviews.md` contains three review *lenses* in one document, with no distinct reviewer identities, sessions, or independent receipts. It therefore does not establish Todo 19's acceptance criterion “three independent visual/a11y reference reviews approve”.

No product fix was attempted. F2-F4, the plan checkbox, ledger, and Boulder were not edited.

## Governance and boundary audit

- Complete plan read: `.omo/plans/caret-clone-redesign.md` (Todos 1-19 checked; F1-F4 unchecked).
- Complete execution ledger read: `.omo/start-work/ledger.jsonl`.
- Boulder read: `.omo/boulder.json`; work `caret-clone-redesign-019fef5e` remains active at baseline HEAD `a1ed25f95980980cd958044b90e739ac45e8280d`.
- HEAD remains exactly `a1ed25f95980980cd958044b90e739ac45e8280d`; index is empty; no commit was created.
- Todo 19's approved conflict resolution is present in the ledger and current state: browser-only `startCapture`; native projection, disclosure/Open Workspace, and exactly-once `stopCapture`; no native Start was demanded.
- Repository symlink resolves to `$HOME/Applications/Meeting Slides.app`; installed executable, Info.plist, and project marker match Todo 19's recorded hashes.
- A pre-existing Cursor listener owns port 8787. No task-owned Meeting Slides, Todo-19 driver, or task-port process was found. The retained Todo 19 cleanup receipt states its owned process count was zero and task port was free.

## Must-have mapping

| Requirement group | Current evidence/state | Result |
| --- | --- | --- |
| Official Caret packet before implementation | `task-1/manifest.json`, official/reference and baseline captures; fresh validator 304/304; no packet image hash under `public/` | PASS |
| One binding Caret-grade design contract | `DESIGN.md`; `task-6/`; superseded TIRO/Liquid/Caret layers are provenance only | PASS |
| Protocol and DOM compatibility | `tests/fixtures/public-dom-contract.json`, `public-protocol-contract.json`; current focused contract tests 23/23; `meeting_id` spelling and core ancestry present | PASS |
| Explicit UI/capture/transcript state | `public/ui-state-machine.ts`, `public/transcript-state.ts`, generated browser modules; current reducer tests pass | PASS |
| Document library/detail shell | `public/index.html`, `public/operator-surface.js`, `public/caret-operator.css`; task-11 evidence and current focused shell/a11y tests | PASS |
| Live complete PPT + transcript and responsive stack | task-12 geometry/screens; task-15/18 matrices; task-19 960/820/375 captures; current no-overflow/a11y tests | PASS |
| Persistent Stop/timer and restoration | task-12, task-16 dual-surface receipts, task-19 two-cycle wire evidence; current dual-surface tests | PASS |
| Contextual real settings/review/Ask/compile/save/export | task-13 evidence; task-19 real wire actions and exports; unsupported inherited controls remain disabled with machine reasons | PASS |
| Caret-grade matte tokens/fonts/motion/AA | `public/caret-operator.css`, local `public/fonts/`, task-9/15 evidence; current a11y tests | PASS |
| Required browser widths and keyboard access | task-1 baseline, task-12/15/18 matrices, task-19 captures; current accessibility matrix | PASS |
| Testable native lifecycle preserving TCC/calendar/Bun/browser | `macos/AppLifecycle.swift`, `TransportClient.swift`, `launcher.swift`; current native suites | PASS |
| Native menu item/minibar as projection only | `MinibarProjection.swift`, `MinibarView.swift`, `MinibarWindowController.swift`; task-14/16/19 AX/wire evidence; no native Start | PASS |
| Rebuilt installed app | task-17 and task-19 bundle receipts; fresh `scripts/verify-app.sh` and strict codesign pass | PASS |
| Deterministic evidence and final verification | Per-task RED/GREEN evidence exists, checksum samples match, but final full-suite and independent-review gates are missing | **FAIL** |

## Must-not and scope-guard audit

| Constraint | Evidence/current state | Result |
| --- | --- | --- |
| No backend algorithm rewrite | Diff is shell/state/additive phase/dispatch integration; no STT, SQLite, deck, scene-graph, or export algorithm replacement found | PASS |
| No Electron/Tauri/CEF/full-native/WKWebView | Native/build guards and current source search; executable verifier passes | PASS |
| No Caret private branding/assets | Local fonts are licensed/hash-recorded; no Caret logo/Casper/private packet assets shipped | PASS |
| No additive active skin | `public/index.html` loads only `style.css` and `caret-operator.css`; obsolete layers deleted; active-shell tests 12/12 | PASS |
| No invented functional capability | Native vocabulary is Stop/disclosure/Open Workspace only. Existing translation/edit/citation compatibility controls are explicitly disabled and expose machine reasons, consistent with Todo 13's capability-gating requirement | PASS |
| No Swift source of truth | Native modules decode/project server state and transient transport state; dual-surface tests pass | PASS |
| No weakened protocol/storage/DOM contract | Current manifest tests pass; additive optional phase remains phase-less compatible | PASS |
| No forbidden fixed wait synchronization | Harness/QA source inspection found bounded timeout guards but no Puppeteer `waitForTimeout`, fixed sleep, or polling-delay synchronization in the scoped Caret harnesses | PASS |
| No universal screen-share claim | DESIGN/README/native source and task-17 capture decision make no exclusion promise | PASS |
| No external regression dependency | Fonts/fixtures are local; focused browser suites enforce no off-origin request | PASS |
| Preserve protected dirty work | Recomputed hashes for `.env.example`, `HANDOFF.md`, `src/llm.ts`, `src/providers.ts`, `src/provider-adapters.ts`, `tests/app-settings.test.ts`, and `tests/providers.test.ts` match task-2 before hashes | PASS |
| No commit/staging | HEAD unchanged; index empty | PASS |

## Todo-by-Todo compliance map

| Todo | Exact evidence/current-state conclusion | Result |
| --- | --- | --- |
| 1 | 66 retained files; manifest/reference/baseline/failure proof; validator 304/304 | PASS |
| 2 | 24 files; canonical receipt, 204-row protected table, layer ledger, failure boundary. Current validator's missing-layer errors are the authorized Todo-18 deletions; content-hashed protected paths still match | PASS |
| 3 | 22 files; fixtures, RED mutations, GREEN logs; current 23 contract tests pass | PASS |
| 4 | 47 files; deterministic harness, failure ordering proof; checksum 46/46 | PASS |
| 5 | 35 files; Swift pure seam, malformed geometry receipts, DoneClaim; current native surface suite passes | PASS |
| 6 | 24 files; active contract and adversarial validator evidence; current DESIGN has one active contract | PASS |
| 7 | 21 files; reducer RED/GREEN and transition audit; current reducer suite passes | PASS |
| 8 | 22 files; transcript RED/GREEN and 21 artifact checksums match. `SHA256SUMS` has a known invalid self-entry, but sampled/all non-self entries match | PASS with evidence-format note |
| 9 | 26 files; token/font licenses, hashes, browser measurements, network-font RED | PASS |
| 10 | 32 files; lifecycle/transport DoneClaim and compiled/manual evidence; later current bytes are covered by Todos 14/17/19 and current native tests | PASS |
| 11 | 74 files; browser RED/GREEN, ARIA/geometry captures; current focused shell tests pass | PASS |
| 12 | 31 files; 900/899 seam, 960/820/375/320 evidence; checksum 29/29 | PASS |
| 13 | 109 files; contextual capability/focus/action matrix; checksum 108/108 | PASS |
| 14 | 36 files; native projection DoneClaim, real bounds/AX/wire receipts, reconnect and Stop proofs; current native suite passes | PASS |
| 15 | 778 files; RED/GREEN, 126-cell normal/reduced matrix, native accessibility; checksum 398/398; current a11y suite passes | PASS |
| 16 | 48 files; one-session dual-client RED/GREEN/manual journey; checksum 47/47; current dual-surface suite passes | PASS |
| 17 | 52 files; build, verifier, codesign, Info.plist, failure copy, launch/cleanup, capture decision; checksum 46/46; current installed bundle verifies | PASS |
| 18 | 216 files; deletion manifest, 45 browser triplets, active-shell parser repairs, docs/current bundle; checksum 215/215; current tests 12/12 | PASS |
| 19 | Journey, wire/AX/bundle/checksum/cleanup evidence is substantial and Todo-19 checksum is 71/71. Browser-only Start boundary is correct. Required passing full suite and three independent review receipts are absent | **FAIL** |

## Focused current verification

Executed read-only against current bytes:

- `bun test tests/public-dom-protocol-contract.test.ts tests/public-active-shell.test.ts tests/ui-state-machine.test.ts tests/transcript-state.test.ts tests/native-surface-contract.test.ts tests/native-launcher-boundary.test.ts tests/native-minibar.test.ts tests/app-bundle.test.ts tests/caret-dual-surface.test.ts tests/public-caret-accessibility.test.ts` -> **427 pass / 0 fail**.
- `bunx tsc -p tsconfig.json --noEmit` -> PASS.
- `scripts/verify-app.sh` -> PASS.
- `codesign --verify --deep --strict "$HOME/Applications/Meeting Slides.app"` -> PASS.
- `git diff --check` -> PASS.
- Task checksum validation: T4 46/46, T12 29/29, T13 108/108, T15 398/398, T16 47/47, T17 46/46, T18 215/215, T19 71/71. T8 has 21/21 valid non-self entries and one stale self-reference.
- Independent first/middle/last checksum samples for T4, T8, T12, T13, T15-T19 all matched current artifact bytes.
- Installed hashes independently matched `task-19/installed-bundle-hashes.txt` for executable and Info.plist; project marker also matched the recorded task-17 hash.

The full suite was not rerun because F1 was instructed not to repeat the expensive suite; the retained required Todo-19 run is the authoritative evidence and is failing.

## Pre-existing/protected failure attribution

The six `tests/llm-transport.test.ts` failures are supported as unrelated: task-2 recorded `src/llm.ts` and provider files dirty before this plan, and their current SHA-256 values exactly match the protected before table. The `start-review-action` and `attendees-action` timeout receipts are documented as unrelated minutes-domain failures, but no pre-plan passing/failing baseline for those exact tests was found in F1's inspected receipts. Regardless, the decisive plan-caused gap is independent: three plan-related failures occurred in the required full run and only focused post-repair evidence exists.

## Exact targeted closure for the two gaps

### Gap 1 - no passing post-repair full suite

Smallest required command, run once from the canonical root on unchanged product bytes:

```bash
bun test 2>&1 | tee .omo/evidence/caret-clone-redesign/task-19/verification/verification-bun-test-post-repair.txt
```

Required closure evidence:

- command exits 0;
- terminal summary records zero failures in that single run;
- SHA-256 of `verification-bun-test-post-repair.txt` is added to Todo 19's checksum index;
- if protected failures still occur, this gap remains open unless the binding plan is explicitly amended. Focused passes cannot substitute for this acceptance criterion.

### Gap 2 - no three independent final review receipts

Smallest required action: dispatch three distinct independent reviewer sessions, one per lens, with no product edits. Each reviewer inspects the final current artifacts and writes one machine-attributed receipt:

1. Desktop/live: `task-19/journey-final/02-live-960.png` and `03-live-compiled-history.png`.
2. Narrow/responsive: `02-live-375.png`, `05-viewport-320.png`, and `05-viewport-375.png`.
3. Native/accessibility: `native-cycle1-ax.txt`, `native-cycle2-ax.txt`, `03b-review.png`, and `08-bad-payload-failure.png`.

Required closure evidence for each receipt:

- distinct reviewer/session ID;
- inspected artifact paths and independently recomputed SHA-256 values;
- explicit APPROVE/REJECT verdict against the corresponding Todo 19/design-contract criteria;
- no reliance on `task-19/visual-reviews.md` as the reviewer conclusion;
- receipt included in an updated Todo 19 checksum index.

Todo 8's stale checksum self-reference is an evidence-format note, not a third F1 blocker: all 21 non-self entries independently match.

## Inspected evidence roots

- `.omo/plans/caret-clone-redesign.md`
- `.omo/start-work/ledger.jsonl`
- `.omo/boulder.json`
- `.omo/evidence/caret-clone-redesign/task-1/` through `task-19/`
- Current product surfaces under `public/`, `macos/`, `scripts/`, `server.ts`, `DESIGN.md`, `README.md`
- Current focused tests and fixtures under `tests/`
- `$HOME/Applications/Meeting Slides.app`
