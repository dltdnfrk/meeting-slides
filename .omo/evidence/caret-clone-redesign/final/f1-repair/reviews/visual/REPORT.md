# F1 repair - gap #2: independent visual fidelity review

- Reviewer task id: `st_019ff3d5`
- Reviewer task name: F1 repair gap #2 - independent visual fidelity review
- Reviewer session id: `019ff3d4-5bb8-7220-8d81-dfb5f3d0f13c`
- Parent session: `019fef5e-6de0-7b8b-9d1c-e4d629a0379b`
- Reviewed HEAD: `a1ed25f95980980cd958044b90e739ac45e8280d` (working tree dirty; shipped `public/` reviewed as-is on disk)
- Timestamp (UTC): `2026-08-12T03:20:48Z`
- Contract reviewed against: `DESIGN.md` Section 9 (`OMO-CONTRACT-ID: operator-contract-v2-caret-grade`), lines 153-547
- Mode: read-only. No product, plan, ledger, or governance file was edited. No commit was created.

## Verdict

**FAIL.**

Three reproducible visual-fidelity defects are present in the current shipped CSS/HTML and are
directly visible in the current Todo 19 journey screenshots. Two are viewport-specific
regressions that the existing Todo 19 evidence does not cover, and one is a dead-selector defect
introduced by the Todo 19 product fix that first made `#btn-review` reachable.

This review was derived independently from the evidence files and the shipped sources listed
below. It does not restate or inherit the prior combined review prose in
`.omo/evidence/caret-clone-redesign/task-19/visual-reviews.md`; that document is treated here
only as a claim under test.

## Evidence actually inspected

Shipped sources (read on disk at review time):

| File | SHA-256 |
| --- | --- |
| `public/caret-operator.css` | `20dab12a9dbcb22b724ba2da3607d48e2d211a59c580771397536ee5ce322918` |
| `public/style.css` | `d433375487cfae2ec0e6347efd966d27105ffddb0f5d2495641b89884a45fb25` |
| `public/index.html` | `c81c8ed6fe5563dcb24c697cc9013ae462cb73a991556124537a6b8c0c212517` |

Screenshots and geometry/state JSON (read at review time):

| Artifact | SHA-256 |
| --- | --- |
| `task-19/journey-final/02-live-960.png` | `43fe64c09fc31b570a386f3ade9d8bdcd7da0a15dc936d23a2edc7fcb4a97e6c` |
| `task-19/journey-final/02-live-820.png` | `f0c1721f71db6e607f35a932878fc0312d1d62087531e37e3444c4cea9740442` |
| `task-19/journey-final/05-viewport-320.png` | `0b86b83e7f90a22a74e7cd557fabb8523238ae5db7ecab0f8ab6e9ade2a7b7e5` |
| `task-19/journey-final/05-viewport-375.png` | `a484d8db2b7763628e66bbe562daf1b6a0446e6b0de7e03b761b2f8dd173713f` |
| `task-18/screenshots/1280x800-live-capturing.png` | `04b18dce972ea063e9e53a4d2de4b716d88f042f203705889ab7b4ad77476cf4` |

Also inspected, without defect attribution: `task-19/journey-final/02-live-375.png`,
`05-viewport-1280.png`, `viewports.json`, `live-viewports.json`,
`task-19/README.md`, `task-19/visual-reviews.md`,
all 45 `task-18/screenshots/*.styles.json` metric blocks,
`task-18/screenshots/320x667-library-populated.ax.json`,
`task-11/baseline/baseline-geometry.json`, `task-12/green/green-geometry.json`,
`task-18/capture-qa.ts`, and `.omo/evidence/caret-clone-redesign/final/f1-plan-compliance/DoneClaim.json`.

## Findings

### FAIL-V1 - provisional caption row overflows its grid area at live widths >= 900px

Viewport: `960x760` live (`data-shell="live"`, `data-capture-phase="capturing"`). Also applies
to `1440x900` and `1244x836` by the same rule, content-length dependent.

Observed in `task-19/journey-final/02-live-960.png`: the provisional caption row (`#island`,
`#caption-text`) renders at approximately y=573 spanning the full 960px width. Its Korean text is
cut mid-glyph on the left edge (the row begins mid-syllable, rendering `...겠습니다.` with the
leading characters sheared off at x=0) and is cut mid-word on the right (`베타 채널은 목요`),
running underneath the transcript pane rather than terminating inside its own container. There is
no ellipsis and no overflow fade with a clean boundary; glyphs are sheared.

Root cause, located in the shipped CSS/HTML:

- `public/index.html:292` places `<section class="island" id="island">` as a direct child of
  `#document-surface` (`public/index.html:203`).
- `public/caret-operator.css:2284-2292` makes `#document-surface` a grid in live shell.
- `public/caret-operator.css:2311-2329` (`@media (min-width: 900px)`) redefines the columns as
  `minmax(0,1fr) var(--splitter-w,5px) var(--transcript-w, minmax(280px,0.9fr))` and explicitly
  places `#meeting-chrome`, `#stage-pane`, `#splitter-transcript`, and `#transcript-pane`.
  `#island` receives **no** `grid-row`/`grid-column` at this or any other width - verified by
  scanning every `#island` rule in `public/caret-operator.css` (lines 331, 725, 1493, 2782, 2797,
  2806, 2807, 2809, 2818, 3040); none declares grid placement. It is therefore auto-placed into an
  implicit track that does not match the explicit three-column layout.
- `public/caret-operator.css:2797-2804` styles `#island .island__text` with
  `word-break: keep-all` and no `min-inline-size: 0`, no `overflow`, and no `text-overflow`, so a
  long provisional line cannot shrink or ellipsize.

Why this is contained below 900px: `public/caret-operator.css:3025-3044`
(`@media (max-width: 899px)`) puts live shell into a single stacked column, where the island is
full-width and clips cleanly. `02-live-820.png` confirms correct ellipsized rendering at 820, and
`02-live-375.png` confirms it at 375. The defect is exclusive to the side-by-side seam at and
above 900px.

Why it was missed: `task-18/capture-qa.ts:101` defines `rootOverflow` as
`documentElement.scrollWidth - documentElement.clientWidth`. This overflow is inside a grid area,
not at the document root, so all 45 `*.styles.json` files legitimately record `rootOverflow: 0`
while the shear is still visible. `task-18/screenshots/1280x800-live-capturing.png` shows the same
island rendering correctly as a centered pill when the caption is short (`녹음 중 02:05`), which
is why no static capture in task-18 exposed it - the failure requires long provisional text.

Contract violated: Section 9.9 ("no label, capability reason, or command may end as a partial
glyph"; "The document root never overflows horizontally" is satisfied, the partial-glyph rule is
not), Section 9.8 (the provisional caption must live inside the transcript stream and be visually
distinct, not bleed across the stage/transcript boundary), and Section 9.4 rank 3/5 (supporting
content must not visually collide with the document surface).

### FAIL-V2 - `#btn-review` renders as a completely empty control at <= 420px

Viewports: `320x667` and `375x812` library shell, meeting selected.

Observed in `task-19/journey-final/05-viewport-320.png` and `05-viewport-375.png`: the top bar
shows two circular controls left of the status text. The first carries the `◇` attendee glyph.
The second is a **blank** rounded control with no glyph, no label, and no icon - visually an
empty capsule.

Root cause:

- `public/index.html:69-72` defines `#btn-review` with only
  `<span class="review-btn__label">회의록 검토</span>` and a `hidden` count span. There is no
  icon element in the markup.
- `public/style.css:1259` (`.review-btn__label { display: none; }`) hides the sole visible child
  at narrow widths, and `public/style.css:1254-1258` forces the button to
  `min-width/min-height: var(--cf-target-min, 44px)`. The result is a 44x44 control with zero
  rendered content.
- `public/style.css:1233` styles `.review-btn__icon`, a selector that matches nothing - the icon
  span it was written for does not exist in `public/index.html`. The sibling
  `.attendee-btn__icon` (`public/style.css:967`) does have a matching span
  (`public/index.html:66`), which is why the attendee control degrades correctly and the review
  control does not.

Contract violated: Section 9.12 ("Icon-only controls always keep an accessible name" - the
`aria-label` survives, but the control has no visible affordance at all, so it is neither
icon-only nor labelled), Section 9.4 ("Typography carries hierarchy; decoration does not" - this
control carries neither), and Section 9.11 ("Disabled is muted, never invisible" - an enabled
control rendering as empty is a stronger form of the same failure).

Why prior evidence does not cover it: `#btn-review` ships `hidden` by default
(`public/index.html:69`). In `task-18/screenshots/320x667-library-populated.ax.json` the button
is absent from the accessibility tree entirely, so the task-18 narrow sweep
(`narrowTargetFailures: []`, `minTarget: 44` at 320/375) never measured or rendered it. The Todo
19 product fix (`task-19/README.md`, defect 2: "Review had no first-use path: the button stayed
hidden until a review already existed") is what first made this control visible at narrow widths,
and the accompanying target-size repair (defect 4) corrected its 28x14 box to 44px without
restoring any visible content.

### FAIL-V3 - `.action-card__btn` label truncated mid-word at 320px

Viewport: `320x667` library shell, Overview tab, ACTIONS region.

Observed in `task-19/journey-final/05-viewport-320.png`: the first action button renders
`Send follow-` with the label cut mid-word at the button's right edge; the remainder is not
visible and no ellipsis is shown. Two further action buttons to its right are rendered as empty
boxes with no legible label.

Root cause: `public/caret-operator.css:603-616` gives `.action-card__btn` a fixed
`padding: 0 12px` with `border-radius: 999px` and no `min-inline-size: 0`, `overflow`, or
`text-overflow`; `public/caret-operator.css:598-601` sets the container to `display: flex;
flex-wrap: wrap; gap: 8px`. At 320px the flex items are compressed below their content width
without any shrink-safe text handling, and `public/caret-operator.css:3194-3198`
(`@media (max-width: 375px)`) only enforces `min-block-size/min-inline-size: 44px`, which
constrains the box but not the text.

Contract violated: Section 9.9 ("At `375px` and `320px` no label, capability reason, or command
may end as a partial glyph behind an overflow fade") and Section 9.13 (a real capability must be
legible in the surface where the action lives).

## Findings that PASSED

These were checked and are sound; they are recorded so the FAIL verdict is not read as a blanket
rejection of the redesign.

- **Live stage containment, 820 and 375.** `02-live-820.png` and `02-live-375.png` show the
  complete 16:9 stage above the transcript with the provisional row correctly ellipsized, Stop and
  timer persistent and coral, and no clipped control. Matches Section 9.8 and 9.9 stacking rules.
- **Single dominant primary action.** Across `05-viewport-1280.png`, `05-viewport-375.png`, and
  `05-viewport-320.png` exactly one coral control is present per shell per viewport
  (`녹음 시작` in library, `Stop` in live). No two coral controls compete. Matches Section 9.4.
- **Tonal elevation, no glass in the main pane.** The library and live captures show matte tonal
  steps with hairline rules; no shadowed floating card and no blur on the document surface.
  Matches Section 9.4 and 9.5 material rules.
- **Root overflow.** All 45 `task-18/screenshots/*.styles.json` records report
  `rootOverflow: 0`, `duplicateIds: []`, and `activeRemovedReferences: []` across
  `320x667`, `375x812`, `820x900`, `960x760`, and `1280x800` in nine shell/phase states each.
  `minTarget` is 44 at 320 and 375. Section 9.9's root-overflow rule holds; the partial-glyph rule
  does not (FAIL-V1, FAIL-V3).
- **Stop persistence.** `stopVisible: true` in every `live-*` styles record across all five
  captured widths, including `starting`, `stopping`, `error`, and `disconnected`. Matches
  Section 9.8.
- **Focus ring.** The `focused` block in the styles records shows a solid 2px outline with no
  shadow on `#btn-settings`; visible in `1280x800-live-capturing.png` as a non-coral ring. Matches
  Section 9.12's requirement that focus color be independent of the recording color.

## Residual risks

1. **No `1440x900` or `1244x836` post-redesign capture exists in LIVE shell.** Section 9.9 names
   `1440x900` as the reference-comparison viewport and `1244x836` as the library reference. The
   task-18 sweep and the Todo 19 journey both cover only `320/375/820/960/1280`, and every
   `1440x900`/`1244x836` artifact under `task-1`, `task-4`, `task-9`, `task-11`, and `task-15`
   predates the final shell convergence.

   During this review a concurrent sibling repair session published two current captures at these
   widths: `final/f1-repair/accessibility-repair/installed-viewports/viewport-1440x900-library.png`
   and `viewport-1244x836-library.png`. Both were inspected. Both are **library** shell with an
   idle capture phase, so neither exercises the live side-by-side seam that produces FAIL-V1. In
   both, the library reference layout renders cleanly: one meetings rail plus one document
   surface, a single coral primary action, correct tonal separation, and no clipped label. The
   remaining gap is therefore narrower than "no receipt at all" but still open: **no current
   `1440x900` or `1244x836` capture exists in live shell with a long provisional caption**, which
   is precisely the state FAIL-V1 predicts will shear. FAIL-V1 at those two widths remains
   reasoned from the CSS rule rather than directly observed.
2. **The overflow harness cannot detect intra-grid shear.** As long as `rootOverflow` remains the
   only geometric assertion, any future defect confined to a grid area or pane will pass. A
   per-element `scrollWidth > clientWidth` check on text-bearing nodes would be needed to close
   this class.
3. **Content-length dependence.** FAIL-V1 only manifests with a long provisional caption. Any
   re-capture using short synthetic text will render clean and falsely confirm a fix.
4. **`.review-btn__icon` is a dead selector.** Its presence in `public/style.css:1233` suggests
   the empty-control state was not intended. Until markup and CSS are reconciled, the same class
   of defect can recur for any control whose only visible child is a responsively hidden label.
5. **Todo 19 visual approval provenance.** `task-19/visual-reviews.md` records three APPROVE
   lenses in a single document with no distinct reviewer identity, session id, or independent
   receipt, and its Review 2 explicitly approves `05-viewport-320.png` and `05-viewport-375.png` -
   the same two files in which FAIL-V2 and FAIL-V3 are plainly visible. This is consistent with
   the F1 plan-compliance blocker already recorded in
   `final/f1-plan-compliance/DoneClaim.json` and is independently confirmed here.

## Scope statement

Read-only. Files written by this review, and nothing else:

- `.omo/evidence/caret-clone-redesign/final/f1-repair/reviews/visual/REPORT.md`
- `.omo/evidence/caret-clone-redesign/final/f1-repair/reviews/visual/DoneClaim.json`
- `.omo/evidence/caret-clone-redesign/final/f1-repair/reviews/visual/CHECKSUMS.txt`

No product source, plan, ledger, boulder, or governance file was modified. No commit was created.
No F2-F4 phase was entered.
