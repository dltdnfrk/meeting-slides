# SlidePlan contract

`SlidePlan` is the persisted authoring IR. Existing live `MeetingCard` capture remains a
separate low-latency surface. `GeometryDeck` is a deterministic, ephemeral compiler output.

## Source identity

```ts
interface TranscriptSnapshotRef {
  meetingId: number;
  transcriptVersionId: string;
  contentSha256: string;
  lineCount: number;
}

interface SourceRef {
  transcriptVersionId: string;
  startSeq: number;
  endSeq: number;
  evidenceQuote: string;
}
```

Every factual field binds to one or more claims. Editorial text is allowed only when its
payload path is listed explicitly in `editorialPaths`.

```ts
interface EvidenceClaim {
  id: string;
  kind: "decision" | "action" | "fact" | "quote";
  text: string;
  sources: SourceRef[];
  method: "verbatim" | "extractive" | "reviewed";
}
```

## Plan

```ts
interface SlidePlan {
  schemaVersion: 1;
  planId: string;
  revision: number;
  snapshot: TranscriptSnapshotRef;
  title: string;
  theme: DeckTheme;
  claims: EvidenceClaim[];
  assets: AssetRecord[];
  slides: PlannedSlide[];
  createdAt: string;
  updatedAt: string;
}
```

Primary layout families:

1. `hero` with `cover | closing` variant
2. `summary` with `statement | quote | overview` mode
3. `decision`
4. `comparison`
5. `timeline` with `timeline | process` mode
6. `metrics` with `metric | chart` mode
7. `actions`

Every slide has a stable ID, story role, title, payload, claim bindings, editorial paths,
asset IDs, and optional notes.

## Design tokens

The theme resolves one source for browser, standalone HTML, PNG/PDF, and PPTX:

- 1280x720 canvas
- local Pretendard font asset and hash
- semantic paper, raised, ink, muted, rule, coral, blue, and focus colors
- semantic spacing, typography, stroke, and radius tokens

Layouts may reference token names only. Renderers never choose independent colors, fonts,
or fitting behavior.

## Assets

Assets compile from verified local bytes only. Every record includes:

- stable asset ID and purpose
- local managed path
- media type, dimensions, byte length, and SHA-256
- alt description
- source kind and provenance
- claim IDs for informative assets

Hotlinks and paths outside the managed asset root are invalid.

## Geometry

Geometry uses integer design pixels on 1280x720. Every text slot declares an explicit fit
policy and records a fit trace. Renderers may not silently clip or independently shrink.

Compile errors include invalid source ranges, quote mismatch, unbound facts, unknown tokens,
asset hash mismatch, unavailable fonts, text overflow, bounds overflow, element overlap, and
unsupported target features.

Any error prevents publication.

## Persistence and migration

New tables are additive and versioned. Existing `scene_publications`, `deck_outlines`,
`deck_slide_specs`, Review tables, and transcript tables remain readable and unchanged.

New reads prefer a valid SlidePlan publication and then fall back to existing scene,
DeckOutline, and live-history sources. Existing user rows are never rewritten implicitly.

## Stage edits

The stage edits SlidePlan revisions, never generated HTML or GeometryDeck. Initial commands:

- set text
- choose layout
- replace asset
- reorder, insert, or delete slide
- regenerate one slide while preserving selected claim IDs

Commands carry an expected revision. Stale commands fail without mutation. Undo creates or
restores a prior immutable plan revision.
