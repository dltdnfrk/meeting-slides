# Task 6 — Replace the binding operator design contract

Plan: `.omo/plans/caret-clone-redesign.md`, Todo 6 (Wave 2, blocked by 1/2/3, blocks 11/12/13/18)
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`
Ownership: `DESIGN.md` and this directory. No product code, no test file, no commit, no staging.

## What changed

`DESIGN.md` sections 9 and 10 were rewritten. Sections 1 through 8 (the generated-deck system)
are unchanged except for one stale operator-font debt row that now points at 9.17.

| Before | After |
| --- | --- |
| Section 9 mixed three competing systems: a TIRO grammar, an "Operational Liquid Glass" material decision, and a shallow Caret dual-shell overlay described as explicitly not a clone. | Section 9 is one active Caret-grade Meeting Slides operator contract in 17 numbered subsections. Section 10 holds all three retired systems as non-binding provenance. |

`DESIGN.md` sha256: `7894baee3778bd209026324c117c260076a774074c514c149fbd5cb1483b3484`
Pre-work copy: `baseline/DESIGN.before.md` (`c1fb2ba3c9299345dec6d60f7694267074ee85092ac43f67fab91d7b31da6648`)

### Repair pass: shipped font location

The first delivery of 9.2 named `public/assets/fonts/`. Todo 9 ships to `public/fonts/`, served
same-origin from `/fonts/`, and vendors Pretendard along with Figtree and DM Mono. 9.2 now names
the real path, the real serve origin, and the real receipt file `public/fonts/font-manifest.json`.
Two dependent lines were corrected with it: the section 8 pointer now points at 9.2 rather than
9.5, and the 9.17 CDN debt row is scoped to the deck authoring view so it cannot be read as an
operator-surface allowance. Agreement with the shipped tree is recorded in
`green/04-font-path-agreement.txt`: `public/assets` does not exist, `public/fonts/` holds nine
files, `public/caret-foundation.css` loads five `url("/fonts/...")` sources, and `DESIGN.md`
contains zero `assets/fonts` matches.

## Required coverage → where it lives

| Todo 6 requirement | Section |
| --- | --- |
| Visual hierarchy | 9.4 |
| Library / live anatomy | 9.7, 9.8 |
| Wide / narrow geometry | 9.9 |
| Typography / material / motion | 9.5, 9.6 |
| Browser vs native minibar division | 9.10 |
| Progressive disclosure | 9.11 |
| Canonical states | 9.3, 9.13 |
| Focus and accessibility | 9.12 |
| Capture and connection failures | 9.13 |
| Brand and privacy boundaries, vendored font location | 9.2 |
| No private Caret assets, logos, copy | 9.2 |
| No universal screen-share exclusion claim | 9.2, 9.10, 9.17 |
| Active vs historical terminology | 9 preamble, section 10 |
| Preserved DOM / protocol / product capability | 9.14 |
| Deletion order from task-2 | 9.15 |

## Measured inputs (no invented values)

Every number in 9.5 and 9.6 comes from `.omo/evidence/caret-clone-redesign/task-1/manifest.json`
`measuredReferenceTokens`: canvas `#09090b`, text `#fafafa` at 19.06:1, rule steps
`rgba(255, 255, 255, 0.078)` (31), `rgb(39, 39, 42)` (21), `rgba(255, 255, 255, 0.298)` (9),
emerald family `#00c950` / `#05df72` / `#00a63e`, radius steps 2/6/10/14/16/24/32px plus the
capsule step, nine type steps with their occurrence counts, Figtree + Pretendard body stack,
DM Mono at 14px / 0.7px, and motion `0.15s` (47) and `0.2s` (1) on `cubic-bezier(0.4, 0, 0.2, 1)`
(48). The six browser viewports mirror `requiredBaselineViewports`.

Section 9.15 reproduces the deletion order from
`.omo/evidence/caret-clone-redesign/task-2/green/ledger.md` §F verbatim in effect: liquid first,
TIRO block second, workspace + caret shells third, base last.

Section 9.3 and 9.14 quote `tests/fixtures/public-dom-contract.json` and
`tests/fixtures/public-protocol-contract.json`: 99 binding IDs, the five ancestry chains, three
disjoint pane pairs, 29 client actions, 20 server message types, five critical payload
spellings, five capture phases, two persisted layout keys.

## Machine check

`check-design-contract.mjs` is a bounded structural validator. It asserts machine-consumed
structure only: required headings, sentinel identifiers, measured values, binding DOM and wire
names, forbidden active claims, and the presence plus SHA-256 identity of each cited evidence
artifact. It pins no prose, no wording, no tone.

```bash
cd /Users/hyunjun/Documents/MUNI/meeting-slides
node .omo/evidence/caret-clone-redesign/task-6/check-design-contract.mjs
```

Exit 0 with 115 checks passed. Result: `green/01-validator-green.txt`.

The font-path rules are two-sided: the active contract must name `public/fonts/`,
`public/fonts/font-manifest.json`, and `/fonts/`, and the `no-stale-font-path` rule rejects any
`assets/fonts` occurrence. That one rule ignores the negation window on purpose, because no
phrasing makes a wrong shipped path correct. `public/fonts/font-manifest.json` is checked for
existence only, not content hash, since Todo 9 owns and may legitimately regenerate it.

Forbidden-claim scanning runs on the active section only (section 10 is sliced off first) and
evaluates every occurrence independently against a same-sentence negation window, so a
legitimate prohibition in 9.2 cannot mask a contradictory claim in 9.10.

## Adversarial proofs (each RED, then restored)

| Probe | Mutation | Result | Evidence |
| --- | --- | --- | --- |
| P1 contradictory active contract | Added "The operator surface is TIRO-inspired and its primary material is Liquid Glass." to 9.4 | 2 failures, exit 1 | `red/p1-contradictory.txt` |
| P2 private Caret asset | Added a Casper mascot + caret logo rule to 9.6 | 1 failure listing both offenders, exit 1 | `red/p2-private-asset.txt` |
| P3 unsupported screen-share claim | Added "The minibar is hidden during screen sharing on every platform." to 9.10 | 1 failure, exit 1 | `red/p3-screenshare.txt` |
| P4 stale reference hash | Replaced the recorded task-1 manifest sha256 with 64 zeros | 1 hash-drift failure, exit 1; restored, 115/115 green | `red/p4-p6-p9-hash-and-missing-artifact.txt` |
| P5 missing required sections | Deleted 9.9 (narrow geometry) and 9.10 (minibar geometry) | 10 failures naming both headings and all eight geometry values, exit 1 | `red/p5-missing-sections.txt` |
| P6 missing cited artifact | Moved `tests/fixtures/public-dom-contract.json` aside | 1 missing-artifact failure, exit 1; restored byte-identical | `red/p4-p6-p9-hash-and-missing-artifact.txt` |
| P7 stale font path | Restored the pre-repair 9.2 wording naming `public/assets/fonts/` | 4 failures: three missing required tokens plus `no-stale-font-path`, exit 1 | `red/p7-stale-font-path.txt` |
| P8 negated stale font path | Smuggled `public/assets/fonts/` into 9.6 inside a sentence containing "never" and "no" | 1 failure, exit 1: the always-rule ignores the negation window | `red/p8-negated-stale-path.txt` |
| P9 missing font manifest | Moved `public/fonts/font-manifest.json` aside | 1 missing-artifact failure, exit 1; restored byte-identical | `red/p4-p6-p9-hash-and-missing-artifact.txt` |

Probe inputs live in `red/*.input.md` and were regenerated from the repaired `DESIGN.md`, so
every recorded RED is reproducible against the current file. No probe ever mutated `DESIGN.md`
or a product file in place; probes 1, 2, 3, 5, 7, and 8 ran against temporary copies.

## Human review

One rendered-Markdown review, not a source read: `manual/01-rendered-review.md`, with the
rendered artifacts in `manual/DESIGN.rendered.html` and `manual/DESIGN.rendered.txt`. Two
defects were found by reading and fixed: a casual phrase in 9.1 and a stale operator-font debt
row in section 8 that contradicted 9.5.

## Checks run

| Command | Result |
| --- | --- |
| `node .omo/evidence/caret-clone-redesign/task-6/check-design-contract.mjs` | exit 0, 115/115 |
| `git diff --check -- DESIGN.md` | exit 0 (`green/02-git-diff-check.txt`) |
| em dash / en dash scan over `DESIGN.md` | zero matches (`green/03-anti-slop-scan.txt`) |
| AI-filler phrase scan over `DESIGN.md` | zero matches (`green/03-anti-slop-scan.txt`) |
| shipped font location vs contract | agrees (`green/04-font-path-agreement.txt`) |
| Table pipe-count, backtick balance, heading order over sections 9-10 | clean |

No product test was run: this task changes documentation only and pins no prose.

## Cleanup

`cleanup/01-restoration.txt`. `DESIGN.md` is the only file changed outside this evidence
directory. All probe mutations are reverted; the four cited evidence artifacts hash to their
pre-work values. Unrelated dirty work from sibling tasks was not touched, staged, reset, or
committed.
