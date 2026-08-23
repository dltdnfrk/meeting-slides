# F4 Scope Fidelity Audit

**Verdict: REJECT**

Task: F4 Scope fidelity (`st_019ff487`)  
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Audited HEAD: `a1ed25f95980980cd958044b90e739ac45e8280d` plus current dirty product bytes  
Completed: `2026-08-12T05:56:20Z`

## Findings

### Medium - M1: the native minibar is geometrically correct but not the approved Caret-grade ambient material

The current native evidence renders the collapsed and expanded minibar as an opaque standard macOS white toolbar/window. In the expanded state, the `560x220` panel is predominantly blank white space with ordinary rounded push buttons. It does not visually carry the compact translucent ambient-control intent visible in the official Caret narrow reference and required by the approved adaptation.

Evidence:

- Official reference: `.omo/evidence/caret-clone-redesign/task-1/reference/screens/home-narrow.png` (SHA-256 `a7237c9935a81fcbb1618e3864f876dcd701bdc81174720d3fc9ca4f6fd91656`) shows the recording control as a compact, translucent pill integrated over the desktop.
- Current collapsed native surface: `.omo/evidence/caret-clone-redesign/final/f3-repair/menu-toggle/screenshots/03-after-second-restore.png` (SHA-256 `47a9b33379374d435d29cd1a9a196eccfebd12e59f3aaf47d74515923b7be03c`).
- Current expanded native surface: `.omo/evidence/caret-clone-redesign/final/f3-repair/menu-toggle/screenshots/04-expanded.png` (SHA-256 `36f1a66552694f55490471609abfdc976f4bf67d59a5fc587903ec60448d0216`).
- `macos/MinibarWindowController.swift:146-160` correctly creates a clear, borderless nonactivating panel, but `macos/MinibarView.swift:247-250` then fills the complete content view with `NSColor.windowBackgroundColor`. There is no `NSVisualEffectView` or equivalent native material layer anywhere in `macos/`.
- This conflicts with the structural ambient-control posture in `DESIGN.md:173-183` and the native minibar role in `DESIGN.md:393-423`. It is not Caret brand copying; it is an incomplete adaptation of the approved material and ambient hierarchy.

Exact closure requirement: retain the current truthful controls and exact `360x56` / `560x220` geometry, but make the real installed native surface visibly read as a compact ambient minibar rather than a generic opaque utility panel. Fresh collapsed, live, and expanded screenshots must demonstrate the approved material and content density on the installed artifact.

### Medium - M2: the fresh minimum-width live capture visibly clips Korean placeholder copy

The fresh `320x667` live screenshot cuts the final line of the stage placeholder at the bottom edge of the 16:9 surface. The lower Korean sentence is visibly partial rather than contained. This fails the F4 requirement that geometry and typography be visibly complete at the minimum supported width.

Evidence:

- `.omo/evidence/caret-clone-redesign/final/f3-manual-qa-segmented/segment-a-browser/02-live-320x667.png` (SHA-256 `8908e451c85150925a957dc41b1b326e5843a1a8b059c7cd3e6116b4f4c5b9a5`).
- The screenshot is bound to the current browser bytes by `final/f3-manual-qa-approved/current-identity/browser-byte-equivalence.txt`; current hashes still match (`public/caret-operator.css` `5c2ef5f7...`, `public/index.html` `b08d066a...`).
- `public/caret-operator.css:2541-2558` clips the 16:9 surface, `public/caret-operator.css:2644-2665` gives the placeholder fixed token padding and type, and `public/caret-operator.css:3105-3112` constrains the narrow frame height. The combination is visibly insufficient at 320px.
- This contradicts `DESIGN.md:298-300` (no stranded Korean syllable) and the minimum-width geometry acceptance in Section 9.9.

Exact closure requirement: at `320x667`, show the complete placeholder and a complete generated slide inside the 16:9 stage with no partial glyph, while retaining the transcript and all controls in the same fresh capture set.

## Dimension audit

| Dimension | Result | Independent conclusion |
| --- | --- | --- |
| Reference hierarchy | PASS in browser | Library is rail + one dominant document; live is dominant stage + transcript, not the former multi-card TIRO layout. |
| Geometry | FAIL | Wide/stacked structure and native bounds pass, but the 320px stage copy is visibly clipped (M2). |
| Typography | FAIL | Local Figtree/Pretendard/DM Mono hierarchy is present and hashes verify, but minimum-width Korean copy is not fully visible (M2). |
| Material | FAIL | Browser resolves to matte, blur-free main surfaces; native minibar is an opaque utility panel rather than the approved ambient material (M1). |
| Motion | PASS | Browser durations are token-bounded and reduced-motion collapses them; focused foundation checks passed. No forbidden layout animation was found. |
| Progressive disclosure | PASS | Browser keeps real secondary actions under contextual More/sheets; native disclosure changes only minibar detail. |
| Native ambient-control intent | FAIL | Projection/control boundary is correct, but the real installed pixels do not reach the approved ambient material/density (M1). |
| Browser-only Start / native Stop | PASS | `startCapture` exists in browser state/action code; native control vocabulary is Stop, disclosure, and Open Workspace only. |
| Meeting Slides identity and function | PASS | Name, Korean copy, bright slide paper, real transcript, compile, PPTX/export, review, Ask, and settings remain observable. No Caret-facing name or logo appears. |
| Brand/private-asset boundary | PASS | No Caret image/logo/mascot/private font is shipped. Internal `caret-*` implementation names and comments are not user-facing impersonation. |
| Screen-share claim boundary | PASS | README/UI make no invisibility or exclusion promise; DESIGN records only the bounded compatibility result. Native source contains no `sharingType`. |
| Unsupported capability boundary | PASS | No native Start, Pause, Share, or second workspace; disabled translation remains explicitly capability-gated. |

## Provenance and integrity

- All 8 official Caret screenshots and 8 computed-style records match the SHA-256 values in `task-1/reference/states.json`.
- Every font asset and OFL license matches `public/fonts/font-manifest.json`; Google Sans Flex is explicitly not vendored and is substituted with OFL Figtree.
- Current installed executable SHA-256 is `23865fbdc70fcc0d7db65bc995b893854fff1e04ef939d29b513dabdb422538d`, matching the approved F3 artifact.
- `scripts/verify-app.sh "$HOME/Applications/Meeting Slides.app"`: PASS.
- `codesign --verify --deep --strict "$HOME/Applications/Meeting Slides.app"`: PASS.
- Focused non-destructive checks: `bun test tests/public-active-shell.test.ts tests/public-caret-foundation.test.ts tests/app-bundle.test.ts tests/native-minibar.test.ts` -> **127 pass, 0 fail, 688 expectations**.
- Source/docs scan found no shipped private Caret asset reference, Caret-facing brand claim, unsupported screen-share claim, WebKit workspace, or native `startCapture` path. References in DESIGN are explicit guardrails/provenance; `src/ask.ts` contains only a non-shipped implementation comment.

## Decision

The browser is substantially beyond a TIRO/dashboard reskin and correctly retains Meeting Slides identity and real functionality. However, F4 requires every named fidelity dimension to be visible in fresh evidence and permits no medium fidelity issue. M1 leaves the real native surface below the approved ambient material bar, and M2 visibly clips minimum-width Korean copy.

**F4 verdict: REJECT.**
