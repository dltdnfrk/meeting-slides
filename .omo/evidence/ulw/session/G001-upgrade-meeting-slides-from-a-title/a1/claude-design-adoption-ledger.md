# Claude Design adoption ledger

Pinned corpus: `asgeirtj/system_prompts_leaks@d023164d75ef9f88a638b3780f7b7baa78266d0a`

Public inventory: one system prompt, 22 skills, and 10 starter components. The requested
23rd skill is not present in the pinned tree or its complete Claude Design skill history.

## System prompt

| Source | Decision | Meeting Slides target |
| --- | --- | --- |
| `Anthropic/claude-design.md` | Adapt quality and artifact-lifecycle rules | Typed planning, validation-before-publication, semantic HTML, notes, and target parity |

## Skills

| Source | Decision | Meeting Slides target |
| --- | --- | --- |
| `3d-object.md` | Defer | No current meeting-deck requirement |
| `animated-video.md` | Defer | No current video timeline/export surface |
| `claude-api-in-prototypes.md` | Reject browser bridge | Keep all model calls behind Bun server transports |
| `create-design-system.md` | Adapt | Typed deck tokens, asset provenance, deterministic target values |
| `export-as-pptx-editable.md` | Port | Extend native PptxGenJS objects, notes, font and package validation |
| `export-as-pptx-screenshots.md` | Adapt | Validate PNG count, dimensions, hashes, and full-bleed parity |
| `flier.md` | Defer | Outside meeting-slide product surface |
| `frontend-design.md` | Adapt | Deck composition rules, anti-generic patterns, accessibility |
| `handoff-to-claude-code.md` | Reference | Publication manifest and developer handoff metadata |
| `hi-fi-design.md` | Adapt | Stable deck-style variants and explicit assumptions |
| `html-email.md` | Defer | Distribution integration is out of scope |
| `interactive-prototype.md` | Adapt | Reducer-based stage states, focus, loading, and errors |
| `make-a-deck.md` | Port first | Narrative planning, title coherence, density and projection gates |
| `make-a-doc.md` | Reference | Existing minutes PDF pagination and print hygiene |
| `make-tweakable.md` | Port | Small high-impact theme/layout controls |
| `maps-geography.md` | Defer | Add only with an explicit geography slide requirement |
| `options.md` | Adapt | Stable style IDs and persisted layout choices |
| `read-pdf.md` | Defer | Attachment ingestion is not part of current engine |
| `save-as-pdf.md` | Adapt | Fresh-source deterministic PDF publication and fit checks |
| `save-as-standalone-html.md` | Port | Offline self-contained deck without CDN dependencies |
| `web-research.md` | Defer | Transcript facts remain authoritative by default |
| `wireframe.md` | Reference | Structural layout variants before visual polish |
| Missing public skill 23 | Unavailable | Never invent a filename or behavior contract |

## Starter components

| Source | Decision | Meeting Slides target |
| --- | --- | --- |
| `deck-stage.js` | Extract and port | Scaling, filmstrip navigation, notes, print, lifecycle cleanup |
| `doc-page.js` | Selective port | Fixed-size printable meeting briefs |
| `image-slot.js` | Adapt | Meeting-scoped local asset storage with hashes and validation |
| `animations-v2.jsx` | Defer | Video runtime is outside current product scope |
| `tweaks-panel.jsx` | Rewrite in vanilla JS | Accessible typed deck controls |
| `three-d-stage.js` | Defer | WebGL and 3D export are outside current product scope |
| `browser-window.jsx` | Reference | Static browser-frame slide primitive only |
| `macos-window.jsx` | Reference | Static macOS-frame slide primitive only |
| `ios-frame.jsx` | Defer | MacBook-only product; deck-content primitive only if requested |
| `android-frame.jsx` | Defer | MacBook-only product; deck-content primitive only if requested |

## Current implementation seam

Preserve live `MeetingCard` capture. Replace the active
`compileNarrativeDeck -> composeNarrativeDeck -> saveScenePublication` interior with a
source-bound typed plan, deterministic geometry, shared renderers, additive persistence,
and target-specific validation. Keep Review and canonical transcript ownership unchanged.
