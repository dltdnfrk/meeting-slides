# Manual visual QA — task-1 packet

Method: real Chromium (Puppeteer, bundled Chrome `mac_arm-150.0.7871.24`), every capture
opened and visually inspected image-by-image. Captured official-site text is inert
reference data only.

## Official Caret reference (8/8 inspected — PASS)

| State | Verdict |
| --- | --- |
| `home-hero` | PASS — official nav/hero, matte near-black canvas, native macOS window framing, `[01] LIVE SUGGESTION` rule visible. |
| `home-live-suggestion` | PASS — live-suggestion stage with two-column feature grid and emerald accent chips. |
| `home-before-the-call` | PASS — `[02] BEFORE THE CALL` briefing surface plus the "Meeting detected / Transcribe" collapsed pill. |
| `home-after-the-call` | PASS — `[03] AFTER THE CALL` review/memory stage. |
| `home-narrow` (375x812) | PASS — narrow hero stacks; collapsed recording minibar visible in the product still. |
| `changelog-index` | PASS — Changelogs index heading and first entry with official changelog imagery. |
| `changelog-mini-recording-popup` | PASS — the mini recording popup / screen-share section, the key minibar reference. |
| `changelog-new-ui` | PASS — New UI library/notes screenshots. |

Measured reference facts (runtime `getComputedStyle`, sRGB resolved by canvas readback):
canvas `#09090b`, body text `#fafafa` (contrast 19.06:1), body Figtree, display
Google Sans Flex, telemetry DM Mono, emerald family `#00bc7d` / `#00c950` / `#05df72`,
rules `rgb(39,39,42)` and `rgba(255,255,255,0.078)`, motion `0.15s cubic-bezier(0.4,0,0.2,1)`.

## Current Meeting Slides baseline (12/12 captured, 6 inspected in detail — PASS as characterization)

All six required viewports produced both a `library` and a `live` state with a frozen clock
(timer reads `12:34` in every live capture), 15 finalized transcript lines, and no root
overflow at any width.

Characterization findings recorded for later todos (defects in the CURRENT UI, not in this packet):
- `.session-rail` is `display:none` below 1244px, so the meetings rail is unreachable at 960/820/375/320.
- `live-960x760` crops the slide: only the first of three bullets renders inside the stage.
- `live-320x667` clips the slide title mid-glyph.
- Live mode is coral/red dominant with multi-row dock chrome — the fidelity gap versus the reference above.
