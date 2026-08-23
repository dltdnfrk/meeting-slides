# F4 Scope Fidelity Rerun

## Findings

### Medium - M1R: native ambient closure is not fully visible or Caret-grade in the required installed capture set

The material implementation itself is repaired: current `macos/MinibarView.swift` subclasses `NSVisualEffectView`, uses active `.hudWindow` / `.behindWindow` material, removes the opaque utility fill, and the installed executable is the exact repaired hash `7847745f6d94512434c6ac41e3e3352e5c33825aa3c9f921fc8613d86b8e5281`. The collapsed and expanded bounds receipts are also exact (`360x56`, `560x220`).

The required visual closure is nevertheless incomplete:

- `.omo/evidence/caret-clone-redesign/final/f4-repair/native-material-direct-capture/02-collapsed-live.png` (SHA-256 `68d1749a5c0e9ec07f38996f68f424960f70897aee023a5cb6d6403bf4a367c8`) is visibly the idle projection: it says `대기 중`, has no timer or live line, and paints Stop disabled. It is visually identical in state/content to `01-collapsed-idle.png`, despite being the packet's required collapsed-live capture.
- The same-run AX receipt does prove that live truth arrived later (`녹음 중`, `05:38`, current caption, enabled Stop help), but F4's approval condition requires native ambient intent and truthful controls to be **visible in fresh evidence**. An AX/state receipt cannot turn idle pixels into a live screenshot.
- `.omo/evidence/caret-clone-redesign/final/f4-repair/native-material-direct-capture/03-expanded-live.png` does visibly show truthful live controls and transcript over translucent material, but its content is confined to the right side of the `560x220` panel. Most of the expanded material remains unused. That preserves the lopsided, low-density utility-window posture called out by the original rejection rather than reaching the compact ambient hierarchy of the official narrow reference.

This is not a geometry, protocol, or truth-source defect: source and focused tests keep Stop/disclosure/Open Workspace truthful and closed. It is a remaining medium visual/evidence defect in the exact dimension F4 must personally observe.

Exact closure requirement: produce an exact-hash installed collapsed-live screenshot that visibly shows live status, server-derived timer/latest line, enabled Stop, and disclosure on the repaired `360x56` material; make the `560x220` expanded composition use its width as a coherent ambient transcript/control surface rather than leaving most of it blank; retain current geometry and control vocabulary.

## Verdict

**REJECT**

Task: F4 Scope fidelity rerun (`st_019ff4ae`)  
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Audited HEAD: `a1ed25f95980980cd958044b90e739ac45e8280d` plus current dirty product bytes  
Completed: `2026-08-12T06:37:37Z`

F4 permits no high or medium fidelity/scope finding and requires every named dimension to be visible in fresh evidence. M1R remains medium, so approval is prohibited.

## Original finding closure

### M1 native material: PARTIAL

- **Closed:** real native HUD material, rounded/stroked/shadowed silhouette, exact installed executable identity, exact `360x56` / `560x220` bounds, no opaque `windowBackgroundColor` fill, truthful model/control source.
- **Open:** collapsed-live pixels do not show live state; expanded density remains visibly weak. Therefore native ambient intent is not fully visible.

### M2 minimum-width stage: CLOSED

I personally inspected all six current repair screenshots. At `320x667`, both the Korean placeholder and generated slide are fully contained in the exact `296x166.5` 16:9 slide at `(12,143)`. No partial glyph, overlap, or bottom clipping is visible. Stop is a complete `66.09x44` target, and the transcript remains present with a 120px vertically scrollable viewport.

The `375x812` and `820x900` placeholder/generated regressions also preserve complete stages, reachable Stop, transcript, and controls. `geometry.json` reports, for all six states: exact 16:9 aspect, zero slide/root overflow, zero out-of-bounds character ranges, zero hit-test-occluded character ranges, enabled visible Stop, and vertically scrollable transcript.

Current M2 source identity matches the repair receipt:

- `public/caret-operator.css`: `794ed65af8a53cb81cdde9b565c373d7385db6a357bf7f0fbbb73d2a62083dde`
- `tests/public-caret-narrow-stage.test.ts`: `db65f2a93b3bda6931f3b8b4889263402c8986d82286a897c0c794f0fdf1ab3a`

## Dimension audit

| Dimension | Result | Independent conclusion |
| --- | --- | --- |
| Caret-grade reference hierarchy | PASS | Browser library remains one quiet rail plus dominant document; live remains stage plus transcript. It is structurally beyond the prior TIRO/dashboard shell. |
| Geometry | PASS | Browser 960 side-by-side and 820/375/320 stacked behavior is intact; M2 has zero measured stage/root overflow; native bounds are exact. |
| Typography | PASS | Local Figtree/Pretendard/DM Mono hierarchy remains deterministic; repaired 320 Korean placeholder and generated-slide glyphs are complete. |
| Material | PASS | Browser main surfaces resolve matte/blur-free; current installed native pixels visibly use translucent HUD material rather than the rejected opaque white fill. |
| Motion | PASS | Token motion remains bounded to 150/200ms and reduced motion collapses it; native disclosure uses the 200ms budget or zero under reduced motion. |
| Progressive disclosure | PASS | Real secondary browser actions remain under contextual More/sheets; native disclosure adds only recent lines and Open Workspace. |
| Native ambient-control intent | FAIL | Material and bounds pass, but the required collapsed-live capture is visibly idle and expanded content density remains lopsided (M1R). |
| Meeting Slides identity/function | PASS | Meeting Slides naming, Korean meeting copy, editable PPT stage, transcript, compile/export, Review, Ask, and settings remain observable. |
| Browser-only Start / native Stop | PASS | Browser retains `startCapture` with `meeting_id`; native vocabulary is only Stop, disclosure, and Open Workspace. |
| Brand/private-asset boundary | PASS | No Caret logo, mascot, official screenshot, or private font is shipped; byte comparison found zero official-reference screenshot matches under shipped product roots. |
| Privacy/screen-share boundary | PASS | No user-facing screen-share invisibility, picker-exclusion, or privacy claim exists in README/product/native sources. DESIGN states only the bounded compatibility result. |
| Unsupported capability boundary | PASS | No native Start/Pause/Share/workspace engine exists; capability-gated browser controls remain disabled with explicit reasons. |

## Reference and source inspection

- Read the complete F4 plan contract, original F4 rejection, DESIGN Section 9, approved F1/F2/F3 reports, both native-material repair reports, narrow-stage repair report, current HTML/CSS/Swift bytes, official task-1 manifest, and source/geometry/AX/bounds receipts.
- Personally inspected official Caret before/live/after/narrow screenshots, the three installed native captures, all six M2 screenshots, and representative final library/live/settings/Ask surfaces.
- Official packet validator: `PASS: 304/304 checks`; all eight official screenshots and computed records remain hash-bound.
- No official screenshot byte is present under `public/`, `macos/`, or `deck/`; shipped non-source assets are only the audited local fonts/licenses.
- Runtime loads `style.css` and one operator hierarchy, `caret-operator.css`; focused active-shell and foundation checks confirm matte main surfaces and overlay-only blur after the final cascade.
- Current installed app resolves the canonical project marker hash `55182b91c2255401a77db395b8b7b97c1dccb482721f890337d584693cc7ae0a`.

## Focused non-destructive verification

| Check | Result |
| --- | --- |
| Task-1 manifest validator | PASS, 304/304 |
| Native direct-capture `SHA256SUMS` | PASS, all entries |
| Narrow-stage `SHA256SUMS` | PASS, all entries |
| Browser F4 aggregate (`narrow-stage`, `live`, `foundation`, `active-shell`) | PASS, 87/87, 864 expectations |
| Native/bundle aggregate (`native-minibar`, `native-surface-contract`, `app-bundle`) | PASS, 121/121, 380 expectations |
| `scripts/verify-app.sh` | PASS |
| strict deep codesign verification | PASS |
| Installed executable identity | PASS, `7847745...5281` |
| Current native material source identity | PASS, `MinibarView.swift` `c83cecb...5140` |
| Current M2 CSS/test identity | PASS, `794ed65...dde` / `db65f2a...ab3a` |
| Private official-reference byte matches in shipped roots | PASS, 0 |
| User-facing unsupported screen-share claim scan | PASS, none |

No product, plan, ledger, Boulder, Todo evidence, or protected unrelated file was edited. No commit, staging, reset, restore, build, app launch, or installed-artifact mutation was performed by this audit. Only this rerun evidence directory was written.

**F4 verdict: REJECT.**
