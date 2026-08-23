# TIRO-inspired operator surface rebuild

## Scope

Rebuild the browser operator surface in `public/` using TIRO’s runtime interaction grammar
without copying its brand colors, assets, or copy. Preserve the paper deck system, required
DOM IDs, the five-column workspace contract, responsive breakpoints, and every existing
WebSocket action/message.

## Protected work

- Do not edit `server.ts`.
- Do not edit `models/`.
- Do not edit `.omo/ulw-research/`.
- Preserve unrelated dirty changes in source and tests.

## Ordered implementation

### Direction

1. Replace `DESIGN.md` Section 9 with the operator-shell contract.
2. Name zinc/coral/glass tokens, primitives, scroll ownership, motion, accessibility,
   capability-gated debt, and 1180/900 responsive behavior before production UI edits.

### Tests first

1. Add or update public-shell tests for the floating dock structure, waveform state, three-way
   output destinations, bilingual controls, disabled reasons, and required DOM IDs.
2. Run the focused tests and confirm they fail because the new surface is absent.

### Markup and behavior

1. Recompose `public/index.html` into header, five-column workspace, center-only slide stage,
   transcript workbench, three-way output control, floating recording pill, and settings sheet.
2. Keep every existing ID and control wire target.
3. Extend `public/app.js` only where real UI state must mirror existing capture, provider,
   transcript, session, review, or compile messages.
4. Keep unsupported translation and transcript editing visibly disabled with the reasons
   declared in `DESIGN.md`.

### Styling

1. Extend existing `style.css` zinc, coral, glass, focus, and motion tokens.
2. Preserve `workspace-shell.css` five-column grid and 1180/900 breakpoints.
3. Adapt the TIRO floating dock and record-to-waveform morph using transform/opacity/filter
   only, with a reduced-motion path.
4. Keep the bright slide surface isolated inside `#stage-pane` / `#current-slide`.

### Verification

1. Run focused public UI tests, `bunx tsc --noEmit`, then full `bun test`.
2. Start `bun run server.ts` on the project’s real HTTP surface.
3. In a real browser, drive happy path, disconnected/disabled state, record start/stop,
   transcript/view controls, settings open/close, and keyboard focus.
4. Capture fresh complete screenshots at 375×812, 768×1024, and 1280×800.
5. Check dimensions/signatures and inspect horizontal overflow, clipping, CJK wrapping, focus,
   selected state, waveform state, and reduced motion.
6. Dispatch two fresh independent read-only Visual QA reviewers on all captures. Fix and
   recapture until both return PASS with no blockers.

## Observable completion criteria

- All requested UI states render as live DOM and work through the existing contracts.
- Slide drafts exist only in the center stage.
- Unsupported server features are honest disabled-with-reason affordances.
- No horizontal overflow at 375, 768, or 1280.
- Typecheck and related/full tests pass, or only explicitly identified pre-existing failures
  remain.
- Independent Visual QA returns PASS on fresh evidence.
