# Task 9 - visual QA of the deterministic token and font foundation

Reviewer: executing agent (real Chromium captures, inspected image-by-image).
Method: `bun .omo/evidence/caret-clone-redesign/task-9/capture-green.mjs` renders the
isolated foundation fixture at all six canonical viewports plus one reduced-motion
state, then every PNG under `green/screens/` was opened and inspected.

**No screenshot is asserted byte-for-byte anywhere in this task.** Font
rasterization is not a regression signal; the machine contracts live in
`tests/public-caret-foundation.test.ts`, and these images exist for human judgement.

## What the fixture shows

The fixture is deliberately not the product shell (Todo 11/12 own that). It renders
exactly the roles the token layer declares, so each can be judged on its own:
type ramp, material ladder, semantic state colours, rules, focus, motion.

## Findings

### Typography - PASS
- Latin body renders in **Figtree**, Hangul body in **Pretendard Variable**, and the
  telemetry row in **DM Mono**. All three are visually distinct at a glance, which is
  the point: telemetry must never read as prose.
- Confirmed against the renderer itself (CDP `CSS.getPlatformFontsForNode`), not
  guessed from advance widths: Latin body is 100% Figtree, telemetry 100% DM Mono,
  and Hangul is dominated by Pretendard Variable.
- The display heading is visibly heavier and tighter than body without changing
  family, which is the intended substitution for the proprietary reference display
  face (see `displaySubstitution` in `public/fonts/font-manifest.json`).

### Materials - PASS
- rail / surface / raised / overlay form a legible dark elevation ladder. Each step is
  distinguishable from its neighbour without any step becoming a light "card on white".
- Only the overlay swatch shows blur. Rail, surface and raised are flat matte, which is
  the contract: main planes are opaque, blur is an overlay-only material.
- The canvas reads as a true matte near-black, not a tinted or gradient field.

### Semantic state colour - PASS
- The emerald "AI suggestion" chip and the coral "REC 02:05" chip are unmistakably
  different roles. There is no viewing angle at which they could be confused, which is
  what the plan requires of the AI-vs-recording distinction.
- Both chips pair colour with a text label, so neither state is communicated by colour
  alone.
- Accent and record text roles remain legible against the canvas.

### Text hierarchy - PASS
- body -> muted -> faint descends in three clearly separable steps. Faint is dimmer but
  still readable at body size; no step disappears into the background.

### Focus - PASS (defect found and fixed)
- The first capture showed **no focus ring at all**, because the probe applied focus
  programmatically and `:focus-visible` therefore never matched. The computed-style
  assertion still passed, so the machine contract alone would have shipped an
  invisible ring.
- The probe now drives focus with a real `Tab` keypress. The re-capture shows a
  clearly visible sky-blue ring, offset from the control edge - what a keyboard user
  actually gets.
- This is exactly the class of defect that screenshot review exists to catch.

### Responsive behaviour - PASS
- 1440x900, 1244x836, 960x760, 820x900, 375x812 and 320x667 were each inspected.
- At 320x667 the swatch rows wrap cleanly and nothing is clipped or pushed off-axis.
- No horizontal scrollbar appears at any width, corroborating the measured
  `rootOverflow.horizontal === 0` at all six viewports.

### Reduced motion - PASS
- The reduced-motion capture is visually identical to the standard one. This is the
  desired outcome: reduced motion collapses durations to zero without degrading the
  visual system. Measured `--cf-motion-quick` and `--cf-motion-state` are both `0ms`,
  and computed transition/animation durations are `0s`.

## Second defect found by review

The initial fixture rendered the material and state swatches as zero-height elements,
so the screenshots showed almost nothing and the material/colour roles could not be
judged at all. The fixture now lays those roles out with fixture-local geometry only -
it declares no colour, type, radius or motion of its own, so every visual property
under inspection still comes from `public/caret-foundation.css`.

## Verdict

APPROVED. The foundation is deterministic, fully local, legible, and correct at every
canonical viewport. Two real defects (invisible focus ring, unreviewable swatches) were
found by looking at the images rather than by reading assertions, and both are fixed.
