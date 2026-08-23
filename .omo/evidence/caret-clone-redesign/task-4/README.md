# Task 4 — Deterministic browser state fixture harness

Plan: `.omo/plans/caret-clone-redesign.md` → Todo 4 (Wave 1). No commit, no staging.
**Revision 2** — repairs all findings from independent verifier `st_019fef96`.

## Deliverables (working tree, uncommitted)

| File | Change |
| --- | --- |
| `tests/public-test-harness.ts` | extended, purely additive (`11-harness-diff.txt`) |
| `tests/fixtures/caret-ui-states.ts` | new — 16 canonical fixtures |
| `tests/helpers/caret-browser-driver.ts` | new — deterministic Chromium driver |
| `tests/public-caret-harness.test.ts` | new — 20 self-tests |
| `tests/public-harness-baseline.test.ts` | new — baseline characterization (5 tests) |

Exact SHA-256 for each: `09-deliverable-source-hashes.txt`.

## Verifier findings and repairs

| # | Finding | Repair | Proof |
| --- | --- | --- | --- |
| 1 | Deterministic 5000ms race with Bun's test timeout | `DEFAULT_STATE_TIMEOUT_MS` lowered to **1500ms**; failure test passes an explicit `timeoutMs: 1500`; a test asserts the default stays below 5000ms | focused suite now runs under **plain `bun test`** with no `--timeout` flag: 25 pass / 0 fail |
| 2 | 1440x900 and 820x900 asserted as constants only | Added real fixtures **`reference-library` (1440x900)** and **`stacked-live` (820x900)** with captures, geometry and the stacked-state contract | `04-*`, `green/reference-library-*`, `green/stacked-live-*` |
| 3 | Subscribe-before-trigger evidence vacuous for click steps | Unified driver **trigger clock** advancing for every trigger kind + **in-page monotonic ordinal** recording arm-vs-click order; assertion-only steps eliminated (every step now has exactly one real trigger) | `green/repair-qa-receipts.json` → `clickOrdering` |
| 4 | Screenshot bytes implied to be deterministic goldens | Measured and documented: machine JSON/geometry are byte-stable, **PNG bytes are not**; no test pins screenshot bytes | `13-screenshot-determinism.txt` |
| 5 | Counts/hashes/indexes/QA stale | 14 → **16** fixtures; all hashes, receipts, RED/GREEN logs, manual Chromium QA regenerated | this file, `04-*`, `red/` |
| 6 | Do not touch unrelated files | `omo-audit-jszip-probe.ts` and all pre-existing code untouched; only the five deliverables changed | `10-worktree-status.txt`, `11-harness-diff.txt` |

## Evidence index

| Artifact | Command | Result |
| --- | --- | --- |
| `00-baseline-source-hashes.txt` | `shasum -a 256` before edits | recorded |
| `01-baseline-characterization.txt` | `bun test tests/public-harness-baseline.test.ts` | 5 pass — lifecycle pinned before extension |
| `02-red-initial.txt` | first run, pre-implementation | RED — fixtures/driver absent |
| `red/red-event-order-mutation.txt` | inverted subscribe/trigger in driver | RED — ordering guard fires; reverted byte-identical |
| `red/red-repair-round.txt` | repair-round tests written first | RED — 11 pass / **9 fail**, mapped to findings 1–4 |
| `03-green-focused-tests.txt` | `bun test tests/public-caret-harness.test.ts tests/public-harness-baseline.test.ts` (**no `--timeout`**) | **25 pass / 0 fail**, one run |
| `04-all-fixture-hashes-run-{a,b}.json`, `04-cross-process-diff.txt` | 16 fixtures captured in two separate processes | `diff` exit 0 — machine JSON + geometry identical |
| `05-adversarial-probes.json` | malformed message, unknown await state, missing click target, stale carry-over, 5× repeat, misleading-success | all bounded/typed; no stale capture |
| `06-resource-cleanup.txt` | process counts before/after | Chromium 12→12, bun 5→5 |
| `07-strict-typescript.txt`, `07-tsconfig.caret-task4.json` | `bunx tsc -p` (strict, noImplicitAny) | **exit 0**, no output |
| `08-preexisting-diagnostics.txt` | pre-existing `src/session.ts` TS6133 | reported, NOT fixed; file untouched |
| `10-worktree-status.txt` | `git status --porcelain` | unrelated dirty work preserved |
| `11-harness-diff.txt` | `git diff tests/public-test-harness.ts` | additive only |
| `12-existing-harness-consumers.txt` | operator-surface / workspace / protocol-reliability | 28 pass / 0 fail |
| `13-screenshot-determinism.txt` | measured PNG vs JSON stability | JSON/geometry stable; PNG **not** stable |
| `green/` | real Chromium at all six required viewports | screenshots, machine JSON, timelines, receipts |
| `manual-qa/` | temporary QA drivers, archived after deletion from `.omo/qa/` | reference only |

## Measured results — all six required viewports

| Fixture | Viewport | Machine JSON hash | JSON+geometry stable | PNG bytes stable | Layout | Root overflow |
| --- | --- | --- | --- | --- | --- | --- |
| `reference-library` | 1440x900 | `168cf782…` | yes | no | same row | 0 |
| `library-overview` | 1244x836 | `774ac760…` | yes | no | same row | 0 |
| `live-capturing` | 960x760 | `836f0ece…` | yes | no | same row | 0 |
| `stacked-live` | 820x900 | `d73637f3…` | yes | no | **stage above transcript, one column** | 0 |
| `narrow-live` | 375x812 | `4fb9b5cf…` | yes | no | stage above transcript | 0 |
| `narrow-compact` | 320x667 | `7f04680c…` | yes | no | stage above transcript | 0 |

The measured 900px seam is real: 1440/1244/960 share a row; 820/375/320 stack.

## Click-step ordering receipt (`library-overview`)

```
awaitState          triggerKind  subscribed→triggered  harnessSent  pageArmed→pageTriggered
capture:idle        message      1 → 2                 180 → 181    -
meetings:listed     message      3 → 4                 181 → 182    -
meeting:selected    click        5 → 6                 182 → 182    3 → 4
meeting:loaded      message      7 → 8                 182 → 183    -
```

The click step advances the unified trigger clock, leaves the harness broadcast
counter flat (182→182, since a click sends no server frame), and proves ordering
with the in-page ordinal (armed 3 before dispatch 4). `clientActions == ["selectMeeting"]`.

## Determinism mechanisms

1. Frozen `Date`/`performance.now` installed via `evaluateOnNewDocument` before any app script.
2. `ko-KR` + `Asia/Seoul` pinned via `emulateTimezone`, `Accept-Language`, patched `Intl.DateTimeFormat`.
3. Font readiness awaited through `document.fonts.ready`, never a delay.
4. Request interception: the two remote stylesheet links in `public/index.html` are
   answered locally and recorded as *blocked*; `externalRequests` (requests that reached
   the network) is asserted empty for every fixture.
5. Every awaited state is armed as an in-page `MutationObserver` **before** its trigger;
   settlement is pushed to Node via `exposeFunction`. No `waitForTimeout`, no
   `setInterval`, no polling. The only `setTimeout` is the bounded 1500ms deadline.
6. Machine JSON canonically stringified with sorted keys and rounded geometry.

## Canonical fixtures (16)

`reference-library`, `empty-library`, `library-overview`, `library-notes`,
`library-transcript`, `live-starting`, `live-capturing`, `live-stopping`,
`live-reconnecting`, `history-preview`, `compile-progress`, `compile-fallback`,
`compile-error`, `stacked-live`, `narrow-live`, `narrow-compact` — covering all six
plan viewports (1440x900, 1244x836, 960x760, 820x900, 375x812, 320x667) at
deviceScaleFactor 1. All payloads are real `ServerMessage` values from `src/session.ts`.
