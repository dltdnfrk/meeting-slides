# Hybrid PPT harness

The product has two deliberately separate slide responsibilities:

- **Live MeetingCard:** transcript detection updates one stable on-screen card with a title, optional kicker, bullets, and optional emphasis. It is optimized for low-latency meeting use and does not switch among compiled slide kinds.
- **Published deck:** the SlidePlan pipeline described below. The earlier DeckOutline compiler and its `compileDeck` action are retired and unreachable. `exportDeck` remains as a convenience action, but it only resolves the latest SlidePlan standalone publication; it does not invoke the retired compiler or fall back to live-slide history.

## Compile path

1. The client sends `compileSlidePlan` (plan from scratch) or `persistSlidePlan` (re-publish an edited draft before Review confirmation) over the session WebSocket. The slides controller (`src/server/slides.ts`, composed by `src/server/application.ts`) validates the meeting, rejects the job while any compile or export job is active, and calls `runSlidePlanServerAction` (`src/slides/server-action.ts`). A locally edited draft cannot be persisted after Review confirmation: the browser asks whether to cancel or run `compileSlidePlan` once to rebuild from confirmed evidence.
2. The action fingerprints the canonical transcript. Before Review confirmation it publishes a machine-marked `draft`; after confirmation it publishes a `final`. `confirmedReviewEvidence` (`src/slides/server-review-evidence.ts`) folds only confirmed decisions, action items, and open items with transcript provenance into a final deck. A draft Review contributes nothing, and a candidate item inside a confirmed Review is an error.
3. `runSlidePlanPipeline` (`src/slides/server-pipeline.ts`) drives the planner (`src/slides/planning/planner.ts`, temperature 0 over the chat transport, skipped entirely for `persistSlidePlan`), then geometry compilation and preflight under `src/slides/geometry/`.
4. Every slide drafts against one of seven layout families in `src/slides/layouts/registry.ts`: `hero`, `summary`, `decision`, `comparison`, `timeline`, `metrics`, `actions`. Unknown layouts throw at the registry boundary; model-provided HTML is never accepted.
5. Publishers (`src/slides/server-publishers.ts`) emit four formats from the same geometry: standalone HTML (`standalone/index.html` plus per-slide pages), an editable PPTX (`editable/deck.pptx` with manifest and receipt), and deterministic raster PNGs plus a single PDF (`raster/`), rendered by slides-grab inside a network-denying sandbox.
6. The publication is staged in a temporary directory and moved under the runtime `exports/slide-plans/` root. A new publication directory is named `meeting-<meetingId>-<canonical-contentSha256>-<first-12-of-SHA-256(planId)>-<draft|final>`; an edited revision adds `-r<revision>-<first-12-of-SHA-256(canonical-plan-JSON)>`. The `planId` component hashes the stable `planId`, not the plan bytes. Files are served with attachment disposition at `/slide-plan-artifacts/<planId>/<artifact-path>` by `src/slide-plan-artifacts.ts`.
7. Success is broadcast only after the SQLite commit. A failed commit deletes the just-published directory. Rebuilding a final creates a new revision-0 `planId`; the earlier draft and new final are immutable sibling rows and directories, so the draft remains addressable.

## Persisted publication contract

slides-grab captures a 960×540 CSS viewport; its resolution preset changes pixel density, not the design canvas. Per-slide documents fit the complete 1280×720 geometry into that viewport at every density. Dock export adapts the old density-limited viewport rule only in its verified staging copy, preserving immutable publication bytes and hashing the staged bytes used by the design gate.

All new `publication.json` manifests use schema v2 (`schemaVersion: 2`). `publicationStatus` is required; a final also requires `finalityReceipt`, while a draft forbids Review identity and a receipt. Schema v1 is immutable, read-only compatibility input and may omit `publicationStatus`; the reader derives status only from a structurally complete Review identity and never rewrites the old file. Contradictory v1 status, unknown versions, and incomplete or inconsistent v2 manifests fail closed.

A final is not established by a supplied `reviewId`. At the atomic SQLite save and again when a row is read, the store derives and matches a receipt from a confirmed Review in the same database: `reviewId`, `confirmedAt`, canonical `transcriptVersionId`, canonical `contentSha256`, and the lexicographically sorted confirmed decision/action/open-item IDs. The canonical transcript must still be finalized and its content must hash to that receipt. Forged, orphan, cross-meeting, draft-Review, tampered, or changed-item finals are rejected. Immutable v1 manifest bytes remain receipt-less; a valid migrated final has its same-DB-derived receipt in SQLite.

`publication_seq`, allocated atomically at insertion, is the sole recency key for global and meeting `latest`, `list`, per-plan lookup, artifact resolution, and deck/PDF/PNG selection. `publishedAt` is audit/display time only and does not affect ordering. Migration of recognized historical schemas is atomic and idempotent; malformed or orphan history is excluded from publication APIs and quarantined with its original typed SQLite values and bytes intact. Unknown schemas fail closed rather than being renamed or dropped.

## SlidePlan geometry canvas

The workspace paints compiled `GeometrySlide` boxes on the 1280×720 paper. Drag, eight-handle resize, and arrow-key nudge persist as `boxOverrides` via `setBox`. Shift-select and group drag persist as one `setBoxes` revision. Resize grips appear only when a single box is selected. Double-click and refine persist via `setText`. `persistSlidePlan` compiles those overrides into HTML, PPTX, and raster.

## Hermetic QA

```sh
bun test tests/slides/server-action.test.ts
bun test tests/hybrid-path.e2e.test.ts
```

`tests/slides/server-action.test.ts` runs the production action with a fake chat transport and the real registry, geometry, and publishers against temporary roots. It publishes a real four-format deck from confirmed Review evidence and checks durable-commit semantics, revision re-publish without the planner, and failure cleanup. `tests/hybrid-path.e2e.test.ts` covers the live MeetingCard followed by the canonical four-format SlidePlan publication: local static/WebSocket server, real browser client, file-backed temporary SQLite, fake detector and planner, blocked external requests, and cleanup of temporary databases and exports after each test. Its direct `prepareExportDeck` assertion is an archival compatibility check, not a reachable `compileDeck` WebSocket path.
