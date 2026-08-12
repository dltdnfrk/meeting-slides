# caret-clone-redesign - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** A quiet, Caret-grade Meeting Slides workspace for before, during, and after meetings, plus a native macOS minibar that keeps recording control available without turning the whole screen into an operator dashboard. Live presentation slides and transcript remain available together in the full workspace.

**Why this approach:** The working recording, transcript, slide-generation, review, and export engine stays intact. The failed mixture of TIRO, generic glass, and shallow Caret styling is replaced by one measured reference system; native code is limited to the ambient control that a browser cannot provide.

**What it will NOT do:** It will not rewrite the meeting engine, copy Caret branding or private assets, add fake controls, move the full workspace into an embedded browser, or promise universal screen-share invisibility without verified platform support.

**Effort:** XL
**Risk:** High - the visual shell, client state composition, responsive behavior, and macOS lifecycle all change while existing capture/export contracts must remain stable.
**Decisions to sanity-check:** The browser remains the complete workspace; the native surface is a dumb minibar only. Meeting Slides keeps its name and slide identity. Emerald denotes AI/suggestion state while coral/red remains exclusive to recording or destructive actions. Screen-share privacy is compatibility-gated, never claimed universally.

Your next move: after MOMUS approval, run `/start-work .omo/plans/caret-clone-redesign.md`. Full execution detail follows below.

---

> TL;DR (machine): XL/high-risk operator-shell replacement preserving Bun/WS/deck contracts, delivering a Caret-grade browser workspace, native macOS minibar, deterministic browser/native QA, and rebuilt app bundle.

## Scope
### Must have
- Capture and hash an official Caret reference packet before implementation: current homepage/runtime, public changelog states, typography, color, material, geometry, motion, and before/live/after-call hierarchy.
- Replace the active operator contract in `DESIGN.md` so Caret is the sole interaction/visual reference; preserve historical research only as non-binding provenance.
- Preserve every existing server action/message type and payload key, including the `meeting_id` spelling for `startCapture`.
- Preserve unique binding DOM IDs and their semantic ownership, especially `#stage-pane > #current-slide`, `#transcript-pane`, `#transcript-stream`, `#session-list`, `#notes-input`, `#btn-record`, settings, review, Ask, and export controls.
- Replace inferred UI state with explicit connection, capture, shell, detail, stage, job, and floating-surface state.
- Deliver a document-centric library/detail shell where Overview, Notes, and Transcript replace one another instead of remaining permanently visible together.
- Deliver a live full workspace with complete 16:9 PPT on the left and finalized/provisional transcript on the right at wide widths; stack stage above transcript below 900px.
- Keep Stop and timer persistent during starting/capturing/stopping; preserve live content until authoritative idle and restore the just-ended meeting afterward.
- Normalize transcript snapshot/line/caption handling, deduplication, reconnect behavior, scroll lock, provisional rows, and new-item affordance.
- Re-home real settings, review, Ask, compile, save, and export capabilities into a sparse contextual action hierarchy without renaming their action IDs.
- Implement one measured Caret-grade visual system: quiet matte near-black surfaces, restrained rules, emerald AI/suggestion state, coral/red recording state, deterministic typography, overlay-only blur, bounded motion, complete reduced-motion behavior, and WCAG AA.
- Preserve 1244px desktop, 960px live, 820/768px stacked, and 375/320px narrow browser behavior with zero root overflow and complete keyboard access.
- Refactor the current Swift launcher into a testable macOS application lifecycle that still owns TCC, calendar auto-capture, Bun supervision, and opening the browser workspace.
- Add an AppKit menu-bar item and native `NSPanel` minibar that projects server capture/transcript/connection state, offers Stop and Open Workspace, and never owns meeting data.
- Rebuild and verify the installed `Meeting Slides.app` bundle, executable, Info.plist, signing state, resource wiring, and repository symlink.
- Produce deterministic RED/GREEN evidence, same-size screenshots, geometry JSON, native bounds receipts, full test/build logs, and independent final-verifier approvals.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No backend STT, LLM, SQLite, scene-graph, deck-generation, or export-algorithm rewrite.
- No Electron, Tauri, CEF, full-native workspace, or `WKWebView` main-window migration.
- No Caret logo, Casper mascot, trademarked copy, shutdown banner, private asset, or pixel-golden reuse.
- No additive fourth visual skin over TIRO/Liquid Glass/current Caret CSS; obsolete active layers must be removed from the runtime.
- No fake Pause, Share, CRM, event, folder, translation, speaker-edit, segmentation, or citation capability.
- No second meeting/capture source of truth in Swift; native state is decoded server state plus transient transport status only.
- No renamed or weakened WebSocket/HTTP/DOM/localStorage contracts and no backward-compatibility shim for an invented format.
- No timer sleeps, Puppeteer `waitForTimeout`, polling delays, flaky screenshot timing, or prose-pinning tests.
- No universal “hidden during screen share” promise. Public API limitations must be documented; only automated compatibility evidence may authorize a narrower statement.
- No external network dependency during regression tests; fonts and fixtures must be deterministic and license-audited.
- No edits, resets, staging, commits, or cleanup of unrelated pre-existing provider/Alibaba work, `models/`, or user handoff/research artifacts.
- No Git commit unless the user separately authorizes commits during execution.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: TDD with Bun test for JS/source contracts, deterministic Puppeteer for browser behavior/geometry/screenshots, Swift compiler/driver tests for native reducers and window geometry, then real app build/launch QA.
- RED discipline: each behavioral todo first adds or mutates a focused contract test and records the expected failure caused by the current implementation; restore/make the smallest implementation change and record GREEN once.
- Async discipline: subscribe to the exact DOM mutation, WebSocket fixture message, process log line, or native notification before triggering; bound every await by timeout; never sleep or retry a flaky pass.
- Browser matrix: 1440x900 reference comparison, 1244x836 library/detail, 960x760 live, 820x900 stacked live, 375x812 and 320x667 narrow, all at deviceScaleFactor 1, `ko-KR`, `Asia/Seoul`, fixed clock and data.
- Native matrix: launcher lifecycle, menu-bar item, collapsed 360x56 minibar, expanded 560x220 minibar, active-display clamping, reconnecting state, browser-open action, Stop idempotence, quit-while-capturing guard, and app-bundle verification.
- Regression: focused tests during each todo; after integration run `bun test` once, `swiftc` checks, `scripts/build-app.sh`, `codesign --verify --deep --strict`, LSP diagnostics, `git diff --check`, and real browser/native workflows.
- Evidence root outside ulw-loop: `.omo/evidence/caret-clone-redesign/`.
- Evidence per task: `.omo/evidence/caret-clone-redesign/task-<N>/` containing RED/GREEN logs, geometry JSON, screenshots or native receipts, source hashes, and exact command output.
- Reference acceptance is structural and measured; official Caret screenshots are not copied into product assets or used as shipped pixel goldens. Approved Meeting Slides captures become the deterministic regression goldens.

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- **Wave 1 — Reference and guardrails (Todos 1-5):** five independent lanes capture the source of truth, protect unrelated work, freeze DOM/protocol contracts, establish deterministic browser fixtures, and establish native test seams.
- **Wave 2 — Pure contracts and foundations (Todos 6-10):** five independent lanes write the binding design contract, build pure UI/transcript reducers, refactor the native lifecycle/transport boundary, and create audited design tokens without integrating shared surfaces yet.
- **Wave 3 — Product surfaces (Todos 11-14):** integrate the reducers into the existing client, rebuild library/live/action surfaces, and implement the native minibar. Use dependency order and file ownership below to avoid shared-file collisions.
- **Wave 4 — Convergence (Todos 15-18):** accessibility/failure states, cross-surface synchronization, packaging/privacy evidence, and obsolete-layer cleanup converge after product surfaces are green.
- **Wave 5 — Final integration (Todo 19):** one final task exercises the whole browser/native user journey and assembles the immutable evidence index before the independent verification wave.
- Never parallelize tasks that both modify `public/app.js`, `public/index.html`, the same CSS file, or `macos/launcher.swift`; the dependency matrix is authoritative when a wave contains sequential unlocks.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 6, 9, 10, 12 | 2, 3, 4, 5 |
| 2 | — | 6, 18 | 1, 3, 4, 5 |
| 3 | — | 6, 7, 8, 11, 13, 14, 16 | 1, 2, 4, 5 |
| 4 | — | 7, 8, 9, 11, 12, 15, 16, 19 | 1, 2, 3, 5 |
| 5 | — | 10, 14, 17 | 1, 2, 3, 4 |
| 6 | 1, 2, 3 | 11, 12, 13, 18 | 7, 8, 9, 10 |
| 7 | 3, 4 | 11, 12, 14, 15, 16 | 6, 8, 9, 10 |
| 8 | 3, 4 | 11, 12, 14, 15, 16 | 6, 7, 9, 10 |
| 9 | 1, 4 | 11, 12, 13, 14 | 6, 7, 8, 10 |
| 10 | 1, 5 | 14, 17 | 6, 7, 8, 9 |
| 11 | 6, 7, 8, 9 | 12, 13, 15, 16, 18, 19 | 14 |
| 12 | 1, 6, 7, 8, 9, 11 | 13, 15, 18, 19 | 14 |
| 13 | 3, 6, 9, 11, 12 | 15, 18, 19 | 14 |
| 14 | 3, 5, 7, 8, 9, 10 | 15, 16, 17, 19 | 11, 12, 13 |
| 15 | 4, 7, 8, 11, 12, 13, 14 | 16, 18, 19 | 17 |
| 16 | 3, 4, 7, 8, 11, 14, 15 | 18, 19 | 17 |
| 17 | 5, 10, 14 | 18, 19 | 15, 16 |
| 18 | 2, 6, 11, 12, 13, 15, 16, 17 | 19 | — |
| 19 | 4, 11, 12, 13, 14, 15, 16, 17, 18 | F1-F4 | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Freeze official Caret reference and current baseline
  Recommended task executor category: `visual-engineering`
  What to do / Must NOT do: Use a real Chromium session against only official Caret sources to capture the public before/live/after hierarchy, minibar/window mockups, computed typography/color/radius/material/motion values, and changelog images. Capture the current Meeting Slides library/live/narrow states at identical deterministic sizes before edits. Store source URL, viewport, capture timestamp, geometry, computed-style JSON, image dimensions, and SHA-256 in `.omo/evidence/caret-clone-redesign/task-1/manifest.json`. Keep official images as evidence only; do not copy them into `public/`, invent missing private states, or substitute third-party redesigns.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 6, 9, 10, 12
  References (executor has NO interview context - be exhaustive): `.omo/drafts/caret-clone-redesign.md:45-107`; `.omo/evidence/live-split-ulw/`; `DESIGN.md:153-178`; `https://caret.so/en`; `https://caret.so/en/changelog`; official runtime facts recorded in `.omo/drafts/caret-clone-redesign.md`.
  Acceptance criteria (agent-executable): A JSON validator confirms every required state has an official URL, viewport, non-zero screenshot, computed-style record, dimensions, and matching SHA-256; current Meeting Slides baseline includes 1440x900, 1244x836, 960x760, 820x900, 375x812, and 320x667; no evidence image appears under `public/`.
  QA scenarios (name the exact tool + invocation): Happy — run the deterministic Puppeteer reference driver and inspect each screenshot with the `visual-qa` skill, recording results in `.omo/evidence/caret-clone-redesign/task-1/green/`. Failure — block external requests after navigation and prove the driver reports the missing official asset/state rather than silently using cached/third-party content; evidence `.omo/evidence/caret-clone-redesign/task-1/failure.json`.
  Commit: N | No commit; evidence and later product changes remain uncommitted unless separately authorized.

- [x] 2. Inventory protected work and obsolete visual layers
  Recommended task executor category: `unspecified-high`
  What to do / Must NOT do: Record physical root, Git top-level, origin, full `git status --short`, and hashes for every unrelated dirty provider/Alibaba/model/handoff artifact before implementation. Map the active stylesheet/script order and attribute each operator rule to legacy Meeting Slides, TIRO, Operational Liquid, current Caret, or required functionality. Produce a deletion/replacement ledger under task evidence. Do not stage, reset, restore, format, or otherwise touch protected files.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 6, 18
  References (executor has NO interview context - be exhaustive): `/Users/hyunjun/Documents/MUNI/PROJECTS.md:1-20`; `public/index.html:24-35,451-461`; `public/style.css:1-280`; `public/workspace-shell.css:1-360`; `public/operational-liquid.css:1-680`; `public/caret-shell.css:1-620`; `.omo/plans/tiro-operator-rebuild.md:1-65`; `.omo/drafts/caret-clone-redesign.md`.
  Acceptance criteria (agent-executable): Evidence contains canonical boundary receipt, pre-work status, protected path/hash table, active CSS/script order, and a rule-level keep/replace/delete ledger; a comparison command at task end reports zero content changes to every protected path.
  QA scenarios (name the exact tool + invocation): Happy — run bounded Git/status/hash commands from the canonical root and validate the ledger paths exist. Failure — run the boundary validator with `/Users/hyunjun/Documents/MUNI` as cwd and prove it exits non-zero before any write; evidence `.omo/evidence/caret-clone-redesign/task-2/`.
  Commit: N | No commit; this task establishes the no-touch boundary.

- [x] 3. Lock DOM and wire protocol manifests
  Recommended task executor category: `unspecified-high`
  What to do / Must NOT do: Add `tests/fixtures/public-dom-contract.json`, `tests/fixtures/public-protocol-contract.json`, and `tests/public-dom-protocol-contract.test.ts` describing required unique DOM IDs, parent/descendant constraints, control types, client action names and exact payload keys, server message names, compatibility data attributes, and persisted layout keys. Parse the shipped HTML/JS/types and fail on duplicate/missing/moved IDs or renamed protocol values. Test machine-consumed names only, never prose or CSS wording. Do not alter the server protocol to make the fixture pass.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 6, 7, 8, 11, 13, 14, 16
  References (executor has NO interview context - be exhaustive): `public/index.html:58-461`; `public/app.js:119-181,789-864,1174-1478,1544-1690`; `src/session.ts:22-335`; `server.ts:1320-1350`; `public/workspace-split.js:1-170`; `public/transcript-overlay.js:1-520`; `tests/public-operator-surface.test.ts:1-330`; `tests/server-ws-dispatch.test.ts`; `tests/server-handler-map.test.ts`.
  Acceptance criteria (agent-executable): New manifest tests pass with exactly one of every binding ID, `#current-slide` beneath `#stage-pane`, all existing actions/messages and payload spellings present, and layout keys unchanged; mutation proofs for duplicate `#current-slide`, renamed `meeting_id`, and removed `capture` message each produce a focused RED before restoration.
  QA scenarios (name the exact tool + invocation): Happy — `bun test tests/public-dom-protocol-contract.test.ts tests/public-operator-surface.test.ts tests/server-ws-dispatch.test.ts tests/server-handler-map.test.ts` passes once. Failure — apply each temporary source mutation with `apply_patch`, run only `tests/public-dom-protocol-contract.test.ts`, record RED, restore with `apply_patch`, and record GREEN under `.omo/evidence/caret-clone-redesign/task-3/`.
  Commit: N | No commit; manifest and tests remain in the working tree.

- [x] 4. Build deterministic browser state fixture harness
  Recommended task executor category: `unspecified-high`
  What to do / Must NOT do: Extend `tests/public-test-harness.ts`; add `tests/fixtures/caret-ui-states.ts`, `tests/helpers/caret-browser-driver.ts`, and `tests/public-caret-harness.test.ts` with fixed clock injection, fake WebSocket event sequences, deterministic meetings/slides/transcript/jobs, locale/timezone, font readiness, connection/capture subscriptions, geometry capture, and browser screenshot helpers. Define canonical fixtures for empty library, populated Overview/Notes/Transcript, starting/live/stopping/reconnecting, history preview, compile progress/fallback/error, and narrow viewports. Never use `sleep`, `setTimeout` as synchronization, Puppeteer `waitForTimeout`, polling delays, external network, or mutable current time.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 7, 8, 9, 11, 12, 15, 16, 19
  References (executor has NO interview context - be exhaustive): `tests/public-test-harness.ts:1-80`; `tests/public-workspace.test.ts:1-560`; `tests/public-operator-surface.test.ts:1-330`; `tests/public-protocol-reliability.test.ts`; `package.json:1-30`; prior deterministic geometry patterns in `.omo/evidence/live-split-ulw/README.md`.
  Acceptance criteria (agent-executable): Harness self-tests prove the same fixture produces byte-identical machine JSON twice, fixed timer text at a fixed clock, no external request, and exact event-before-trigger synchronization; static test rejects forbidden wait APIs in the harness and QA drivers.
  QA scenarios (name the exact tool + invocation): Happy — run the new harness self-test plus one 1244x836 library and one 960x760 live fixture, comparing JSON hashes. Failure — emit `slide` before the subscribed capture state and prove the harness times out with the named missing state rather than taking a stale screenshot; evidence `.omo/evidence/caret-clone-redesign/task-4/`.
  Commit: N | No commit; deterministic fixtures and helper code remain uncommitted.

- [x] 5. Establish native compiler and geometry test seam
  Recommended task executor category: `unspecified-high`
  What to do / Must NOT do: Add `macos/NativeSurfaceContract.swift`, `tests/fixtures/native-surface-driver.swift`, and `tests/native-surface-contract.test.ts` as a SwiftPM-free seam that compiles pure Swift native surface state/geometry code with a deterministic fixture driver from Bun tests. Lock collapsed/expanded bounds, active-display clamping, saved-frame validity, capture/connection decode subset, one-command guards, and current launcher/build invariants. Keep AppKit window creation out of the pure module and do not require a GUI session for focused tests.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 10, 14, 17
  References (executor has NO interview context - be exhaustive): `macos/launcher.swift:1-236`; `scripts/build-app.sh:1-140`; installed `/Users/hyunjun/Applications/Meeting Slides.app/Contents/Info.plist`; `src/session.ts:129-147,291-335`; Apple `NSPanel` and `NSStatusItem` documentation linked in `.omo/drafts/caret-clone-redesign.md`.
  Acceptance criteria (agent-executable): `swiftc` compiles the pure module and fixture driver; Bun tests assert 360x56 collapsed, 560x220 expanded, 16px display gutters, invalid off-display frame fallback, capture payload decode, and duplicate Stop suppression; malformed payload and impossible display bounds yield typed failures without crash.
  QA scenarios (name the exact tool + invocation): Happy — `bun test tests/native-surface-contract.test.ts` invokes the Swift driver once and passes. Failure — feed a saved frame with less than 50% display intersection and verify the deterministic default frame is returned; evidence `.omo/evidence/caret-clone-redesign/task-5/`.
  Commit: N | No commit; native test seam remains uncommitted.

- [x] 6. Replace the binding operator design contract
  Recommended task executor category: `writing`
  What to do / Must NOT do: Rewrite the operator-surface portion of `DESIGN.md` from the measured reference packet and approved architecture. Specify before/live/after IA, explicit state regions, exact browser/native geometry, typography and semantic color roles, overlay-only material, motion budget, focus/ARIA rules, live PPT/transcript behavior, minibar projection, real capability placement, failure/loading/empty states, reference-fidelity acceptance, and screen-share claim limits. Mark TIRO/Liquid Glass/current Caret decisions as superseded provenance rather than active rules. Do not test prose or describe capabilities the backend lacks.
  Parallelization: Wave 2 | Blocked by: 1, 2, 3 | Blocks: 11, 12, 13, 18
  References (executor has NO interview context - be exhaustive): `DESIGN.md:153-430`; `.omo/drafts/caret-clone-redesign.md:45-107`; task-1 reference manifest; task-2 layer ledger; task-3 DOM/protocol manifest.
  Acceptance criteria (agent-executable): One active operator contract names every required state/geometry/token/interaction and every Must-NOT-Have; searches find no active statement calling the product TIRO-inspired, generic Liquid Glass, or “not a clone” as the current endpoint; `git diff --check -- DESIGN.md` passes.
  QA scenarios (name the exact tool + invocation): Happy — render/read the changed Markdown and run a writing proofread against the approved draft and reference manifest. Failure — use a checklist validator to prove a contract missing native minibar geometry or narrow live behavior fails; evidence `.omo/evidence/caret-clone-redesign/task-6/`.
  Commit: N | No commit; documentation remains uncommitted.

- [x] 7. Implement pure canonical UI state reducer
  Recommended task executor category: `unspecified-high`
  What to do / Must NOT do: Test-first add `public/ui-state.js` and `tests/public-ui-state.test.ts` representing connection (`booting|connecting|hydrating|online|reconnecting|error`), capture (`idle|starting|capturing|stopping|switching-model|error`), shell, detail tab, stage, active job, and floating-surface state. Server snapshots outrank local pending state; phase-less capture messages map compatibly from `capturing`; stale job/meeting responses cannot overwrite current selection; repeated start/stop activation emits one existing action. Keep transport/render side effects outside the reducer and do not infer state from text, CSS display, or MutationObserver.
  Parallelization: Wave 2 | Blocked by: 3, 4 | Blocks: 11, 12, 14, 15, 16
  References (executor has NO interview context - be exhaustive): `public/app.js:86-101,925-972,1174-1192,1372-1460,1544-1690`; `src/session.ts:129-147,291-335`; `public/operator-surface.js:1-150`; task-3 protocol manifest; task-4 fixtures.
  Acceptance criteria (agent-executable): Focused Bun tests cover initial hydration, capture start success/failure, stop with trailing lines, reconnect snapshot, stale meeting/job response, historical preview, reset, and duplicate activation; reducer is exhaustive, has no DOM/global clock access, and existing payload names remain byte-identical.
  QA scenarios (name the exact tool + invocation): Happy — `bun test tests/public-ui-state.test.ts` runs once with all canonical fixture sequences. Failure — mutate server-snapshot priority below local pending state and prove reconnect/capture tests RED before restoration; evidence `.omo/evidence/caret-clone-redesign/task-7/`.
  Commit: N | No commit; reducer and tests remain uncommitted.

- [x] 8. Implement pure transcript projection reducer
  Recommended task executor category: `unspecified-high`
  What to do / Must NOT do: Test-first add `public/transcript-state.js` and `tests/public-transcript-state.test.ts` as the pure canonical transcript projection handling snapshot replacement, finalized `line`, provisional `caption`, duplicate/reordered snapshots, reconnect, truncation, speaker labels, last-three-line minibar projection, scroll-follow/new-item count, and reset. Keep export/session storage untouched. Announce finalized lines only; timer and provisional caption are never live regions. Do not virtualize until measured performance requires it and do not create a second transcript store for the minibar.
  Parallelization: Wave 2 | Blocked by: 3, 4 | Blocks: 11, 12, 14, 15, 16
  References (executor has NO interview context - be exhaustive): `public/app.js:468-490,877-920,1559-1635`; `public/transcript-overlay.js:1-520`; `public/transcript-overlay.css:1-520`; `tests/public-transcript-dock.test.ts:1-520`; `tests/public-transcript-feed.test.ts`; task-4 transcript fixtures.
  Acceptance criteria (agent-executable): Focused tests cover caption→line replacement, duplicate snapshots, reconnect ordering, truncation, 15 multiline Korean entries, scroll-away/new-lines, follow-to-bottom, reset, and exactly three or fewer unique minibar finals plus one provisional row; no prose snapshot is pinned.
  QA scenarios (name the exact tool + invocation): Happy — `bun test tests/public-transcript-state.test.ts tests/public-transcript-feed.test.ts` passes once. Failure — mutate snapshot handling from replace to append and prove duplicate-order tests RED before restoration; evidence `.omo/evidence/caret-clone-redesign/task-8/`.
  Commit: N | No commit; reducer and tests remain uncommitted.

- [x] 9. Create deterministic Caret token and font foundation
  Recommended task executor category: `visual-engineering`
  What to do / Must NOT do: From task-1 measurements, add `public/operator-tokens.css` and `tests/public-caret-tokens.test.ts` as a single inactive-yet-testable semantic token/component foundation for canvas, rail, document surface, raised state, rules, text hierarchy, emerald AI/suggestion, coral/red recording, focus, radii, type scale, shadow, and motion. Vendor only open-licensed deterministic Figtree/DM Mono assets under `public/assets/fonts/` if required, include license and hashes, retain Pretendard/system fallbacks, and keep generated-slide styling untouched. Main surfaces must be opaque matte; blur is restricted to minibar/dialog overlays. Do not copy Caret private fonts/assets or load fonts over the network.
  Parallelization: Wave 2 | Blocked by: 1, 4 | Blocks: 11, 12, 13, 14
  References (executor has NO interview context - be exhaustive): task-1 computed-style manifest; `public/style.css:1-280`; `public/caret-shell.css:1-100`; `public/operational-liquid.css:1-120`; `DESIGN.md` operator token section after Todo 6; `package.json:1-30`.
  Acceptance criteria (agent-executable): Computed-style fixture tests assert declared semantic values, no main-pane backdrop blur, deterministic local font readiness, WCAG AA contrast for body text, 3:1 boundaries/focus, and unchanged slide renderer colors; license/hash manifest exists for every vendored font.
  QA scenarios (name the exact tool + invocation): Happy — load the foundation in an isolated deterministic fixture and capture token JSON plus swatch screenshot. Failure — substitute a network font URL and prove the no-external-font test RED before restoration; evidence `.omo/evidence/caret-clone-redesign/task-9/`.
  Commit: N | No commit; token and licensed asset changes remain uncommitted.

- [x] 10. Refactor Swift launcher lifecycle and transport boundary
  Recommended task executor category: `unspecified-high`
  What to do / Must NOT do: Test-first split the monolithic launcher into `macos/MeetingSlidesApp.swift`, `macos/ServerSupervisor.swift`, `macos/CalendarCapture.swift`, and `macos/NativeStateClient.swift`, retaining `macos/launcher.swift` as the minimal entry point; add `tests/native-launcher-transport.test.ts`. Preserve current mic permission, project resolution, port config, EventKit auto-capture, Bun environment, logs, browser opening, and clean server termination. The typed client observes only the existing capture/caption/status subset and sends existing auto-capture/auto-stop controls; native state is a projection, not a store. Keep the browser as the main workspace and do not add `WKWebView`, Electron, Tauri, a new server endpoint, or a protocol rename.
  Parallelization: Wave 2 | Blocked by: 1, 5 | Blocks: 14, 17
  References (executor has NO interview context - be exhaustive): `macos/launcher.swift:1-236`; `scripts/build-app.sh:1-140`; `server.ts:1320-1350`; `src/session.ts:129-147,291-335`; `README.md` macOS launcher section; task-5 native harness; Apple `NSApplication`, `NSStatusItem`, and `URLSessionWebSocketTask` official documentation.
  Acceptance criteria (agent-executable): Pure Swift/native driver tests and `swiftc -typecheck` pass; existing launcher behaviors are represented by focused tests; fake server fixture proves current-state hydration, reconnect status, capture/caption decode, one Stop request under rapid activation, and process termination without second source of truth; no source imports WebKit.
  QA scenarios (name the exact tool + invocation): Happy — compile/run the deterministic native transport fixture against a local Bun harness and observe capture→caption→idle. Failure — close the harness socket mid-capture and prove native state becomes reconnecting while retaining known timer/content, then authoritative snapshot restores state; evidence `.omo/evidence/caret-clone-redesign/task-10/`.
  Commit: N | No commit; native refactor remains uncommitted.

- [x] 11. Rebuild the document-centric library shell
  Recommended task executor category: `visual-engineering`
  What to do / Must NOT do: Add failing `tests/public-caret-library.test.ts`, then integrate the pure UI/transcript reducers into `public/app.js` and rebuild `public/index.html` plus `public/operator-surface.js` as a Caret-grade library/detail shell. Keep a fixed meetings rail and one main document surface; Overview, Notes, and Transcript use complete ARIA tabs/tabpanel behavior and replace one another. Expose explicit `data-connection`, `data-capture-phase`, `data-shell`, `data-detail-tab`, and `data-stage-state` while retaining `.app--capturing` and all binding IDs. No permanent transcript dock in library mode, no duplicate IDs, no stale meeting content during rapid selection, and no fake event/folder/share controls.
  Parallelization: Wave 3 | Blocked by: 6, 7, 8, 9 | Blocks: 12, 13, 15, 16, 18, 19
  References (executor has NO interview context - be exhaustive): `public/index.html:58-461`; `public/app.js:86-181,360-600,877-972,1544-1690`; `public/operator-surface.js:1-150`; `public/workspace-shell.css:1-360`; task-3 DOM/protocol manifest; task-4 fixtures; task-6 design contract; task-7/8 reducers; task-9 token foundation.
  Acceptance criteria (agent-executable): At 1244x836 exactly one rail and one main surface are perceivable; Overview and Transcript never coexist; tabs implement `tablist/tab/tabpanel`, roving tabindex and Arrow/Home/End; IDs/actions/messages remain manifest-clean; rapid meeting selection ignores stale response; initial hydration shows no stale slide/transcript; existing focused session/operator tests plus new library tests pass.
  QA scenarios (name the exact tool + invocation): Happy — deterministic browser fixtures for empty library, populated Overview, typed Notes, and 15-line Transcript capture geometry/ARIA/screenshot evidence. Failure — temporarily leave Transcript visible under Overview and prove the one-surface test RED before restoration; evidence `.omo/evidence/caret-clone-redesign/task-11/`.
  Commit: N | No commit; browser shell and tests remain uncommitted.

- [x] 12. Deliver focused live PPT and transcript workspace
  Recommended task executor category: `visual-engineering`
  What to do / Must NOT do: Add failing `tests/public-caret-live.test.ts`, then implement the full live workspace in `public/caret-shell.css`, `public/workspace-shell.css`, `public/workspace-split.js`, `public/transcript-resize.js`, and the relevant renderer/state wiring using authoritative capture phases. At wide widths present a complete 16:9 slide and transcript side by side with persistent Stop/timer; below 900px stack complete slide above transcript. Preserve last slide while detecting, provisional/final transcript projection, history-preview follow suspension, Return to live, compile-preview recovery, trailing lines during stopping, and just-ended meeting restoration. Do not crop slide content, animate layout dimensions, show library chrome, or let compile/export disable Stop.
  Parallelization: Wave 3 | Blocked by: 1, 6, 7, 8, 9, 11 | Blocks: 13, 15, 18, 19
  References (executor has NO interview context - be exhaustive): `public/app.js:231-520,884-972,1372-1460,1494-1690`; `public/index.html:171-330`; `public/caret-shell.css:386-620`; `public/workspace-shell.css:1-360`; `public/workspace-split.js:1-170`; `tests/public-workspace.test.ts:82,186,496-530`; task-1 live references; task-4 fixtures; task-6 contract.
  Acceptance criteria (agent-executable): 960x760 live has visible stage/transcript each above contract minimum, same row, complete contained slide, exact transcript fixtures, persistent Stop/timer, zero root overflow; 820x900 and 375x812 stack stage above transcript with all controls reachable; capture start/stop/reconnect/history/compile sequences satisfy state tests and library frame returns after authoritative idle.
  QA scenarios (name the exact tool + invocation): Happy — deterministic Puppeteer runs at 960x760, 820x900, 375x812 and 320x667 with geometry JSON and screenshots. Failure — mutate the 900px stack seam and preserve `.app--capturing` after idle; each produces the named RED before restoration; evidence `.omo/evidence/caret-clone-redesign/task-12/`.
  Commit: N | No commit; live surface and tests remain uncommitted.

- [x] 13. Re-home real contextual controls and panels
  Recommended task executor category: `visual-engineering`
  What to do / Must NOT do: Add `tests/public-caret-actions.test.ts`, then collapse the current multi-row dashboard/dock/tool chrome into one contextual action bar and More menu while keeping all real settings, attendee, review, Ask, compile, save, and export IDs/actions reachable in the correct idle/live/detail contexts. Preserve capability-gated disabled controls and exact machine reasons. Ensure modal/sheet focus trapping, Escape/topmost close, trigger-focus restoration, and unsaved draft preservation. Do not add Caret-looking fake controls or move slide content outside `#stage-pane`.
  Parallelization: Wave 3 | Blocked by: 3, 6, 9, 11, 12 | Blocks: 15, 18, 19
  References (executor has NO interview context - be exhaustive): `public/index.html:60-170,330-450`; `public/app.js:600-864,995-1478`; `public/review-panel.js`; `public/review-panel-render.js`; `tests/public-settings-panel.test.ts`; `tests/public-review*.test.ts`; `tests/public-compile-control.test.ts`; `tests/public-operator-surface.test.ts:1-330`; task-3 manifest; task-6 contract.
  Acceptance criteria (agent-executable): Manifest tests find every existing action once; one dominant primary action appears per shell; settings/review/Ask/export workflows send exactly their existing payloads; disabled reasons remain in `title`/`aria-label`; modal focus/Escape/draft-preservation tests pass; no text/button advertises unsupported capability.
  QA scenarios (name the exact tool + invocation): Happy — browser-drive settings open/close, review edit/confirm, Ask, compile and export fixture flows in library and live modes. Failure — rapidly activate compile twice and close a settings sheet with unsaved input; prove one outbound action and restored input/focus; evidence `.omo/evidence/caret-clone-redesign/task-13/`.
  Commit: N | No commit; contextual controls and tests remain uncommitted.

- [x] 14. Implement native macOS minibar projection
  Recommended task executor category: `visual-engineering`
  What to do / Must NOT do: Test-first add `macos/CaretMinibarController.swift`, `macos/StatusItemController.swift`, and `tests/native-minibar.test.ts` using the typed native transport. Collapsed 360x56 shows recording state, timer, one latest/provisional line, Stop, and disclosure; expanded 560x220 shows at most three finalized lines plus one provisional line and Open Workspace. Preserve 16px display gutters, per-display frame restoration, drag threshold, expanded-only resize, Escape collapse, browser activation, automatic-capture no-focus-steal, reconnect state, one Stop request, and quit-while-capturing confirmation. Keep app Dock identity unchanged, do not render slides or persist meeting/transcript state, do not add Pause, and do not claim public-API screen-share exclusion.
  Parallelization: Wave 3 | Blocked by: 3, 5, 7, 8, 9, 10 | Blocks: 15, 16, 17, 19
  References (executor has NO interview context - be exhaustive): native modules from Todos 5 and 10; `macos/launcher.swift:1-236`; `public/transcript-overlay.js:1-520` only as behavior reference; `tests/public-transcript-dock.test.ts:1-520`; Apple `NSPanel`, `NSStatusItem`, accessibility, screen APIs; task-6 geometry/state contract.
  Acceptance criteria (agent-executable): Swift driver/native tests and `swiftc` pass; real panel bounds match 360x56 and 560x220 within 1px, remain on-screen across display fixtures, do not activate on automatic capture, project exact server timer/transcript/connection state, send one Stop, open the browser workspace, and refuse immediate quit while capturing; no WebKit import or second state store exists.
  QA scenarios (name the exact tool + invocation): Happy — launch local harness and native app, emit starting→capturing→caption→line→stopping→idle, expand/collapse/drag/open/stop, and record AX/bounds/log receipts. Failure — disconnect mid-capture and drag a saved panel frame off-display; verify reconnecting content retention and deterministic clamping; evidence `.omo/evidence/caret-clone-redesign/task-14/`.
  Commit: N | No commit; native panel and tests remain uncommitted.

- [x] 15. Complete accessibility, motion, and failure states
  Recommended task executor category: `visual-engineering`
  What to do / Must NOT do: Add `tests/public-caret-accessibility.test.ts` and extend `tests/native-minibar.test.ts`; test-first complete keyboard/focus/announcement semantics and every booting, hydrating, empty, loading, starting, stopping, reconnecting, capture error, compile/export fallback/error, malformed-message, provider/STT, reduced-motion, and short-height state across browser and minibar. User-started capture focuses visible Stop; automatic capture never steals OS focus; finalized transcript and errors announce once; timer/provisional caption are not live; Escape priority is modal → expanded minibar/history preview → no-op. Do not weaken contrast, hide failure detail only in logs, or use color as the sole cue.
  Parallelization: Wave 4 | Blocked by: 4, 7, 8, 11, 12, 13, 14 | Blocks: 16, 18, 19
  References (executor has NO interview context - be exhaustive): task-6 accessibility/failure contract; `public/app.js:569-600,708-864,925-1045,1372-1460,1544-1690`; `public/index.html`; native panel from Todo 14; `tests/public-operator-surface.test.ts:1-330`; `tests/public-fresh-workspace.test.ts`; `tests/public-protocol-reliability.test.ts`; `tests/public-settings-panel.test.ts`.
  Acceptance criteria (agent-executable): Automated tests cover complete tab ARIA, focus restoration, Escape order, target sizes, disabled reasons, one-time announcements, contrast, no color-only status, reduced motion, short-height reachability, every listed loading/failure sequence, malformed payload state retention, and no root overflow; browser and native accessibility trees contain only visible/reachable surfaces.
  QA scenarios (name the exact tool + invocation): Happy — emulate keyboard-only and `prefers-reduced-motion`, run Axe/DOM geometry plus native AX inspection through each canonical state. Failure — inject malformed JSON and capture failure while a modal is open; verify last valid content remains, one actionable error appears, focus is deterministic, and no duplicate announcement occurs; evidence `.omo/evidence/caret-clone-redesign/task-15/`.
  Commit: N | No commit; accessibility/failure work remains uncommitted.

- [x] 16. Synchronize browser and native capture restoration
  Recommended task executor category: `unspecified-high`
  What to do / Must NOT do: Add `tests/caret-dual-surface.test.ts`; integrate browser and native projections against one local Bun session and test reconnect, calendar auto-capture, manual start, Stop from either surface, trailing transcript lines, duplicate commands, browser close/reopen, history preview, compile job overlap, natural recorder failure, and authoritative just-ended-meeting selection. Both surfaces must derive timer from server `startedAt`; neither may claim capture stopped on transport loss. Add only additive server phase metadata if existing optional `CaptureUpdate.phase` is not emitted, and preserve compatibility with phase-less messages.
  Parallelization: Wave 4 | Blocked by: 3, 4, 7, 8, 11, 14, 15 | Blocks: 18, 19
  References (executor has NO interview context - be exhaustive): `src/session.ts:129-147,291-335`; `server.ts:1320-1350`; `public/app.js:925-972,1174-1192,1544-1690`; native transport/panel from Todos 10 and 14; `tests/public-protocol-reliability.test.ts`; task-4 deterministic event harness.
  Acceptance criteria (agent-executable): One fixture server drives browser and native clients through every listed scenario with matching phase/timer/latest-line; rapid Stop produces one existing command; reconnect snapshot deduplicates transcript and selects correct shell; browser reload during capture re-enters live; idle restores just-ended meeting once; existing server/WS tests remain unchanged and green.
  QA scenarios (name the exact tool + invocation): Happy — launch the deterministic dual-client harness, subscribe to exact server/client events, run the full start/live/stop/reopen sequence, and compare state JSON. Failure — sever each client independently and send stale meeting/job events out of order; verify no phantom stop, duplicate row, or stale preview; evidence `.omo/evidence/caret-clone-redesign/task-16/`.
  Commit: N | No commit; cross-surface integration remains uncommitted.

- [x] 17. Rebuild and verify the macOS application bundle
  Recommended task executor category: `unspecified-high`
  What to do / Must NOT do: Update `scripts/build-app.sh`, generated Info.plist/resource wiring, packaging inputs, and add `tests/app-bundle.test.ts` for the split native sources, menu-bar item, browser workspace opening, and panel assets. Rebuild `$HOME/Applications/Meeting Slides.app`, preserve the repository symlink, verify executable/resource hashes, version metadata, ad-hoc signing, TCC usage strings, and clean startup/shutdown. Test public-API screen-capture behavior with an automated local capture matrix; record supported/unsupported results and expose no stronger UI/README claim. Do not add notarization, Developer ID, a new distribution channel, or external meeting-app accounts.
  Parallelization: Wave 4 | Blocked by: 5, 10, 14 | Blocks: 18, 19
  References (executor has NO interview context - be exhaustive): `scripts/build-app.sh:1-140`; `macos/launcher.swift:1-236` and split native sources; `/Users/hyunjun/Applications/Meeting Slides.app/Contents/Info.plist`; root `Meeting Slides.app` symlink; Apple `NSWindow.SharingType.none` legacy documentation and current ScreenCaptureKit docs; task-5/14 native evidence.
  Acceptance criteria (agent-executable): `scripts/build-app.sh` exits 0; `codesign --verify --deep --strict "$HOME/Applications/Meeting Slides.app"` exits 0; executable and resources are non-empty with recorded SHA-256; Info.plist has intended identity/permissions/version; symlink resolves to rebuilt app; launch log reaches server-ready/menu-bar/panel-ready without orphan process; automated capture matrix and claim decision are recorded.
  QA scenarios (name the exact tool + invocation): Happy — build, codesign-verify, launch, observe exact readiness log via monitor, exercise menu/panel, quit, and confirm server termination. Failure — remove one packaged native resource in a temporary build copy and prove bundle verifier fails before installation; test capture visibility and record an explicit unsupported result rather than hiding it; evidence `.omo/evidence/caret-clone-redesign/task-17/`.
  Commit: N | No commit; rebuilt installed app and source changes remain uncommitted.

- [x] 18. Remove obsolete shells and reconcile documentation
  Recommended task executor category: `unspecified-high`
  What to do / Must NOT do: Add `tests/public-active-shell.test.ts`; remove active TIRO/Operational Liquid/current shallow-Caret stylesheet/script layers, selectors, duplicate dock/header structures, temporary mutation probes, obsolete QA drivers, and stale “browser-only launcher” claims after replacement surfaces are green. Keep only one operator source of truth and one generated-slide source of truth. Update README run/build/usage docs, DESIGN contract references, evidence index, and bundle verification instructions. Preserve historical research/evidence and unrelated user handoff files; do not delete tests merely because old geometry changed—replace only assertions that intentionally pin the superseded shell.
  Parallelization: Wave 4 | Blocked by: 2, 6, 11, 12, 13, 15, 16, 17 | Blocks: 19
  References (executor has NO interview context - be exhaustive): task-2 layer ledger/protected manifest; `public/index.html:24-35,451-461`; `public/operational-liquid.css`; `public/caret-shell.css`; `public/workspace-shell.css`; `public/operator-surface.js`; `DESIGN.md`; `README.md`; `.omo/evidence/caret-clone-redesign/`; existing `.omo/evidence/live-split-ulw/`.
  Acceptance criteria (agent-executable): Runtime loads one operator stylesheet hierarchy with no obsolete active layer; searches find no mutation probe, temporary driver, duplicate core ID, stale TIRO/current-clone contract, unsupported screen-share claim, or unused shipped overlay; protected path hashes match task-2; `git diff --check` and focused tests pass; evidence remains non-empty.
  QA scenarios (name the exact tool + invocation): Happy — load library/live/native surfaces after cleanup and compare state/geometry hashes to pre-cleanup GREENs. Failure — temporarily re-add one obsolete stylesheet link and prove the active-layer uniqueness test RED before restoration; evidence `.omo/evidence/caret-clone-redesign/task-18/`.
  Commit: N | No commit; cleanup and docs remain uncommitted.

- [x] 19. Prove the complete Caret-grade user journey
  Recommended task executor category: `unspecified-high`
  What to do / Must NOT do: Create temporary `.omo/qa/caret-e2e-driver.ts`, run the full final integration once on the real web and installed macOS surfaces, then delete the driver before completion: launch app and server, inspect empty/populated library, start recording from browser and minibar, receive deterministic slide/caption/line data, inspect 960/820/375 layouts, history preview, reconnect one client, compile/export while live, open full transcript from minibar, stop, restore just-ended meeting/library frame, exercise settings/review/Ask, inspect bad-input/failure states, quit, and verify no orphan process/port. Run all diagnostics/tests/build checks and assemble a checksum-indexed evidence README. Fix only regressions caused by this plan; report unrelated pre-existing failures separately.
  Parallelization: Wave 5 | Blocked by: 4, 11, 12, 13, 14, 15, 16, 17, 18 | Blocks: F1, F2, F3, F4
  References (executor has NO interview context - be exhaustive): all prior task evidence; `package.json:1-30`; `scripts/build-app.sh`; test files mapped in `.omo/drafts/caret-clone-redesign.md`; final design contract; final installed app bundle; `visual-qa` skill.
  Acceptance criteria (agent-executable): LSP error diagnostics are clean for every changed supported file or an exact environment gap is recorded; `bun test` passes once with zero retries; Swift focused tests/typecheck pass; app build/codesign pass; `git diff --check` passes; all browser/native scenario assertions pass; three independent visual/a11y reference reviews approve final desktop/live/narrow/native captures; process/port cleanup is verified; evidence README lists command, result, dimensions, and SHA-256 for every artifact.
  QA scenarios (name the exact tool + invocation): Happy — execute the deterministic real-surface driver and actual `.app` workflow described above, then run `visual-qa` on fresh evidence. Failure — run one bad payload, start failure, disconnect, off-display saved frame, and unsupported screen-capture case; each must surface truthful bounded behavior without data loss or false promise; evidence `.omo/evidence/caret-clone-redesign/task-19/`.
  Commit: N | No commit; final verified working tree and installed bundle remain uncommitted.

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
  Recommended task executor category: `unspecified-high`
  Verify: Independently map every Must have, Must NOT have, Todo acceptance criterion, evidence directory, and approved architecture decision to the final diff and receipts. Confirm task-2 protected hashes, no omitted task, no unapproved server/product expansion, no fake capability, and no missing RED/GREEN proof.
  Approval condition: APPROVE only when all 19 todos have exact passing evidence and zero unexplained deviation; otherwise return file/criterion-specific blockers.
- [x] F2. Code quality review
  Recommended task executor category: `unspecified-high`
  Verify: Review the complete JS/TS/Swift/CSS/HTML/build-script diff for single-source state, exhaustive transitions, protocol compatibility, accessibility, error propagation, deterministic tests, source size/ownership, native process lifecycle, security/privacy claims, and unrelated dirty-work isolation. Re-run changed-file diagnostics, focused tests, full `bun test`, Swift checks, build, codesign, and `git diff --check`.
  Approval condition: APPROVE only with clean checks and no high/medium finding caused by this work; report pre-existing findings separately.
- [x] F3. Real manual QA
  Recommended task executor category: `unspecified-high`
  Verify: Personally use the installed `.app` and real browser surfaces through happy path, one bad input, reconnect, off-display restoration, `--help`/documented launcher surface where applicable, menu-bar/minibar interactions, live PPT/transcript at every required width, stop restoration, compile/export, and process cleanup. Inspect fresh screenshots and native bounds/AX output, not only automated assertions.
  Approval condition: APPROVE only when observable behavior matches the design contract and the real app bundle used is the newly built artifact.
- [x] F4. Scope fidelity
  Recommended task executor category: `deep`
  Verify: Compare final surfaces against the task-1 official Caret packet and approved Meeting Slides adaptation. Confirm the result is structurally Caret-grade rather than another TIRO/dashboard skin, while retaining Meeting Slides identity, real PPT/transcript functionality, and explicit brand/privacy boundaries. Confirm no Caret private asset or unsupported screen-share claim shipped.
  Approval condition: APPROVE only when reference hierarchy, geometry, typography, material, motion, progressive disclosure, and native ambient-control intent are all visible in fresh evidence.

## Commit strategy
- The user has not authorized commits. Every implementation todo is `Commit: N`; `/start-work` must not stage or commit.
- Preserve unrelated pre-existing dirty files byte-for-byte and include before/after status/hash receipts.
- If the user later requests commits, stop and load `git-master`; create small verified commits in dependency order rather than one omnibus commit. This future authorization is not implied by plan approval or `/start-work`.
- Rebuilding `$HOME/Applications/Meeting Slides.app` is an installed-artifact update, not Git authorization.

## Success criteria
- Official Caret reference packet is complete, hashed, source-cited, and was captured before implementation.
- `DESIGN.md` contains one active Caret-grade operator contract with no competing TIRO/Liquid Glass/current shallow-clone source of truth.
- Library mode shows a meetings rail plus exactly one document surface; Overview, Notes, and Transcript replace one another with complete ARIA behavior.
- Live mode shows complete PPT and transcript side by side at wide widths and stacked below 900px, with persistent truthful Stop/timer and no root overflow at 320px+.
- Capture, reconnect, transcript, meeting selection, history preview, compile/export, and stop restoration are explicit deterministic states rather than inferred UI side effects.
- Every existing WebSocket/HTTP action/message/payload, core DOM ID, generated-slide contract, localStorage key, review/settings/Ask/export capability, and server engine behavior remains compatible.
- Native minibar is always-available ambient control over the existing Bun session, never a second source of truth, never a full workspace, and never a fake Pause/share surface.
- Current `Meeting Slides.app` bundle is rebuilt, resource-complete, hash-recorded, codesign-valid, launchable, and connected to the current source/runtime; the repository symlink resolves to it.
- Screen-share privacy behavior is represented only by the exact automated compatibility result; no universal claim ships.
- WCAG AA, keyboard/focus, reduced-motion, Korean multiline transcript, deterministic font, target-size, and announcement contracts pass in browser and native evidence.
- Focused tests, full `bun test`, Swift compile/tests, app build, codesign, LSP diagnostics, `git diff --check`, real browser QA, and real native QA are clean without retries or fixed waits.
- Task evidence is checksum-indexed, final visual/a11y reviewers approve, no QA driver/process/port is left behind, protected dirty work is untouched, and no commit was created.
