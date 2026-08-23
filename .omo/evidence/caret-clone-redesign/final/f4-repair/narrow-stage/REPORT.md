# F4 M2 narrow-stage repair

**Result: PASS — direct M2 closure**

Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Viewport contract: Chromium, `320x667`, device scale factor 1, `ko-KR`, `Asia/Seoul`  
Rejected source screenshot SHA-256: `8908e451c85150925a957dc41b1b326e5843a1a8b059c7cd3e6116b4f4c5b9a5`

## Root cause and repair

The live placeholder inherited `min-height: 38vh` from the generated-slide stylesheet while also declaring `block-size: 100%` and token padding inside an overflow-clipped 16:9 slide. At 320x667 its measured internal overflow was 88px, placing the final Korean line behind the stage edge.

The focused live-shell CSS repair:

- resets the live placeholder's inherited minimum with `min-block-size: 0`;
- includes its existing `--cf-space-6` padding in its 100% block size with `box-sizing: border-box`;
- at the existing `max-width: 599px` seam, tightens only generated-slide spacing and padding using the existing `cqw` responsive scale, preventing the final bullet from painting under the emphasis block.

No copy changed. Placeholder type remains 14px/13px. Generated-slide type floors remain 8px or higher. No DESIGN, governance, F4 audit, native, server, or protocol file was edited for this repair.

## Exact browser proof

`geometry.json` records placeholder and generated-slide geometry at 320x667, 375x812, and 820x900. Every state reports:

- exact 16:9 slide aspect;
- zero slide overflow and zero root overflow on both axes;
- zero out-of-bounds character ranges;
- zero hit-test-occluded character ranges;
- visible, enabled Stop;
- reachable, vertically scrollable transcript.

At 320x667 specifically, the slide is `296x166.5` at `(12,143)`, Stop is a complete `66.09x44` target, and the transcript remains present with a 120px scroll viewport.

## Visual inspection

Personally inspected all fresh screenshots in this directory:

- `320x667-placeholder.png`: both Korean placeholder blocks are complete and centered; no bottom-edge clipping.
- `320x667-generated.png`: title, all three bullets, and emphasis are complete with no overlap or partial glyph.
- `375x812-placeholder.png` / `375x812-generated.png`: complete stage and retained transcript/control layout.
- `820x900-placeholder.png` / `820x900-generated.png`: complete stacked-stage regression with full transcript and controls.

## Verification

- RED: `tdd-red.txt` — placeholder slide overflow reproduced at 88px (`1 fail, 1 pass`).
- GREEN: `tdd-green.txt` — `2 pass, 0 fail`, 34 assertions.
- Related browser suites: `related-tests.txt` — `191 pass, 0 fail`, 1105 assertions across narrow stage, live, accessibility, library, and operator surface.
- TypeScript: `typecheck.txt` — `bunx tsc --noEmit`, exit 0.
- Evidence capture: `capture.txt` — `NARROW STAGE EVIDENCE PASS`, exit 0.
- Diff whitespace check: `diff-check.txt` — clean.
- Browser execution validates final CSS parsing. CSS LSP was unavailable because the configured Biome server is not installed; no suppression or installation was performed.

`SHA256SUMS` binds this report, screenshots, geometry, source hashes, and verification receipts.
