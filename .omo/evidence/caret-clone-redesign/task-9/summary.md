# Task 9 - Deterministic Caret token and font foundation

Status: **COMPLETE**. No commit, no staging, no reset, no restore.

## What shipped

| Path | Role |
| --- | --- |
| `public/caret-foundation.css` | The single semantic token layer + bundled `@font-face` declarations |
| `public/fonts/*.woff2` (5) | Locally vendored, license-audited font assets |
| `public/fonts/LICENSE-*.txt` (3) | OFL-1.1 receipts, one per family |
| `public/fonts/font-manifest.json` | Per-asset SHA-256, byte size, source URL, upstream, license |
| `public/index.html` | Font/style wiring only: remote font links removed, local foundation linked |
| `tests/public-caret-foundation.test.ts` | 29 machine contracts |
| `tests/helpers/caret-foundation-probe.ts` | Deterministic real-Chromium probe |
| `tests/public-test-harness.ts` | Serves `public/fonts/` subdirectory (see "Collateral fix") |

The token layer covers colour, typography, spacing, radii, rules, materials, motion,
focus and reduced motion in one reusable layer, grounded in the task-1 measured packet.

## Font licensing and provenance

All three families are **SIL Open Font License 1.1**. Nothing private, no logos, no
proprietary copy, and **no runtime network dependency**.

| Family | Role | Source | License |
| --- | --- | --- | --- |
| Figtree | Latin body + display | google/fonts `ofl/figtree` (woff2 subsets) | OFL-1.1 |
| DM Mono | Telemetry / timers | google/fonts `ofl/dmmono` | OFL-1.1 |
| Pretendard Variable | Hangul body | orioncactus/pretendard v1.3.9 | OFL-1.1 |

**Deliberate substitution.** The task-1 reference uses **Google Sans Flex** for display.
That is a proprietary Google brand family with no open redistribution license, so it was
**not vendored**. The display role uses Figtree at heavier weight and tighter tracking.
This is recorded machine-readably in `font-manifest.json.displaySubstitution`.

Every asset's SHA-256 and byte size are pinned in the manifest and verified by test,
including a `wOF2` magic-number check so a truncated asset fails loudly.

## TDD record

1. **Baseline (`baseline/`)** - real Chromium against the shipped shell before any edit:
   - **15 external font requests** to `fonts.googleapis.com`, `fonts.gstatic.com` and
     `cdn.jsdelivr.net`; rendered typography depended on the network.
   - **78 fragmented custom properties**; canvas/accent/radius/motion each declared
     under unrelated names across three stylesheets, with no single token layer.
2. **RED (`red/focused-red.log`)** - the focused test fails on the missing foundation.
3. **GREEN (`green/focused-green.log`)** - **29 pass / 0 fail** in a single run.

## Verification

| Check | Result |
| --- | --- |
| `bun test tests/public-caret-foundation.test.ts` | 29 pass / 0 fail, single run |
| Combined with task-3 + task-4 contracts | **72 pass / 0 fail**, 3 consecutive runs |
| Task-3 DOM/protocol contract | Preserved; no id duplicated, no protocol value renamed |
| Strict `tsc --noEmit` on changed TS | Clean |
| Project `tsc -p tsconfig.json` | Clean |
| LSP diagnostics | Clean |
| `git diff --check` | Clean |
| Real Chromium, all 6 viewports | `document.fonts.ready` true, **0** external requests, 0 root overflow |
| Visual QA | All 7 screenshots inspected; see `green/visual-qa.md` |

WCAG (measured, sRGB): body text 17.8:1 and muted 7.6:1 on the document surface;
accent-text 10.8:1; record 6.5:1; faint 4.95:1 on canvas; strong rule composites to
3.34:1 and the focus ring to 11.1:1, both above the 3:1 non-text floor.

## Adversarial probes - 9/9 satisfied

`adversarial-probes.json` / `.log`. Each mutates a real input, records the RED, restores,
and re-confirms GREEN.

| Probe | Expectation | Result |
| --- | --- | --- |
| blocked-network | stays green with all off-origin requests aborted | 29p/0f |
| corrupt-font (truncated woff2) | must fail loudly | RED -> GREEN |
| missing-font (deleted asset) | must fail loudly | RED -> GREEN |
| stale-asset-hash | must fail | RED -> GREEN |
| remove-token | must fail | RED -> GREEN |
| remove-motion-token | must fail | RED -> GREEN |
| remove-reduced-motion | must fail | RED -> GREEN |
| network-font-url | must fail | RED -> GREEN |
| **geometry 1px rounding** | **must stay green** | 6p/0f |

The last one is the point: a 1px viewport shift is **not** a golden failure. This task
pins semantics, tokens and zero overflow - never exact pixel geometry - and there is no
screenshot-byte assertion anywhere.

## Defects found by looking at the screenshots

Two defects passed every machine assertion and were caught only by visual inspection:

1. **The focus ring was invisible.** The probe applied focus programmatically, so
   `:focus-visible` never matched; computed-style assertions still passed. The probe now
   drives a real `Tab` keypress, so the measured ring is the ring a keyboard user gets.
2. **The material/state swatches had zero height**, making the materials and semantic
   colours unreviewable. The fixture now lays them out using fixture-local geometry only.

## Collateral fix (outside the stated file list, deliberate)

`tests/public-test-harness.ts` rejected any path containing `/`, so every request for
`/fonts/*.woff2` returned 404 and the bundled fonts silently failed to load in the
task-4 harness. It now serves nested asset paths (still refusing traversal) and resolves
file existence before responding, instead of letting a missing file reject inside the
server and tear the fixture down. Without this the foundation could not load in the very
tests meant to verify it.

`tests/public-caret-harness.test.ts` had one assertion pinning the exact remote font URLs
the driver was expected to block. Since `index.html` no longer links any remote
stylesheet, that list is now empty. This is a contract update caused by the intended
change, not a weakened assertion; the driver's off-origin guard is untouched.

## Pre-existing failures - NOT caused by this task

`bun test` (full suite) shows failures unrelated to Todo 9, including transcript-resize
drag tests. **Proven not mine**: reverting every one of my font changes while keeping the
concurrent Todo 11/12 shell work in `public/index.html` (new `live-topbar`,
`meeting-chrome`, `detail-tabs`, `rail-nav`) still fails those drag tests 3/3. They are
caused by the in-progress shell restructuring landing in parallel, and are reported here
rather than fixed, since that file's shell structure is not this task's ownership.

## Preservation of unrelated work

During bisection I briefly reconstructed `public/index.html` from HEAD, which dropped a
concurrent agent's shell work. It was **detected and fully restored** in the same session;
the final file retains all 21 markers of that work
(`rail-nav` / `meeting-chrome` / `detail-tabs` / `live-topbar`) and its hash matches the
copy taken before bisection began. No commit, staging, reset or restore was performed at
any point. Two pre-existing git stashes were left untouched.
