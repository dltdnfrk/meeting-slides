import { buildDeckHtml, buildSlideFiles, renderSlideSpec, type DeckInput, type SlideFile } from "./deck.js";
import { renderSceneSlideDocument } from "./scene-html.js";
import { scenePublication } from "./scene-store.js";
import type { DeckOutline, SlideSpec } from "./slide-spec.js";
import type { MeetingStore } from "./store.js";

export type ExportDeckSource = "scene" | "compiled" | "legacy";

export interface ExportDeckMaterial {
  source: ExportDeckSource;
  meetingId: number;
  title: string;
  indexHtml: string;
  files: SlideFile[];
  slideCount: number;
  maxBullets: number;
  lineCount: number;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character] ?? character));
}

function contentCount(spec: SlideSpec): number {
  switch (spec.kind) {
    case "section":
    case "summary":
    case "closing":
      return spec.bullets.length;
    case "decision":
      return spec.rationale?.length ?? 0;
    case "actions":
      return spec.actions.length;
    case "cover":
      return 0;
  }
}

/** Reveal shell for the already escaped, standalone registry output. Model values never become raw HTML here. */
export function buildCompiledDeckHtml(outline: DeckOutline, files: SlideFile[]): string {
  const sections = files.map((file, index) => `        <section data-kind="${outline.slides[index]?.kind ?? "unknown"}">
          <iframe src="./slides/${file.filename}" title="${escapeHtml(outline.slides[index]?.title ?? `Slide ${index + 1}`)}" loading="eager"></iframe>
        </section>`).join("\n");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <title>${escapeHtml(outline.title)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4.6.1/dist/reset.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4.6.1/dist/reveal.css" />
  <style>.reveal .slides section{height:100%;padding:0;display:flex!important;align-items:center}.reveal iframe{width:100%;height:auto;aspect-ratio:16/9;border:0;background:#fff}</style>
</head>
<body>
  <div class="reveal"><div class="slides">
${sections}
  </div></div>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@4.6.1/dist/reveal.js"></script>
  <script>Reveal.initialize({ hash: true });</script>
</body>
</html>\n`;
}

/** Prefer only a successfully published compile; an uncompiled or failed compile explicitly falls back to live history. */
export function prepareExportDeck(store: MeetingStore, meetingId: number): ExportDeckMaterial {
  const meeting = store.meeting(meetingId);
  if (meeting === null) throw new Error(`Meeting ${meetingId} was not found`);
  const lines = store.lines(meetingId);
  const publication = scenePublication(store.databaseHandle(), meetingId);
  if (publication !== null) {
    const files = publication.scene.slides.map((slide, index) => ({
      filename: `slide-${String(index).padStart(2, "0")}.html`,
      html: renderSceneSlideDocument(slide),
    }));
    return {
      source: "scene",
      meetingId,
      title: publication.scene.title,
      indexHtml: buildCompiledDeckHtml({
        meetingId,
        title: publication.scene.title,
        style: "scene-graph",
        slides: publication.narrative.slides.map((slide) => ({
          kind: "cover",
          title: slide.title,
        })),
      }, files),
      files,
      slideCount: files.length,
      maxBullets: 0,
      lineCount: lines.length,
    };
  }
  const compiled = store.deckOutline(meetingId);
  if (compiled !== null && compiled.publishedAt !== null) {
    const files = compiled.outline.slides.map(renderSlideSpec);
    return {
      source: "compiled",
      meetingId,
      title: compiled.outline.title,
      indexHtml: buildCompiledDeckHtml(compiled.outline, files),
      files,
      slideCount: files.length,
      maxBullets: Math.max(0, ...compiled.outline.slides.map(contentCount)),
      lineCount: lines.length,
    };
  }

  const input: DeckInput = {
    title: "Meeting Notes",
    startedAt: meeting.started_at,
    provider: meeting.provider,
    slides: store.slides(meetingId),
    lines,
  };
  const files = buildSlideFiles(input);
  return {
    source: "legacy",
    meetingId,
    title: input.title,
    indexHtml: buildDeckHtml(input),
    files,
    slideCount: files.length,
    maxBullets: Math.max(0, ...input.slides.map((slide) => slide.bullets.length)),
    lineCount: lines.length,
  };
}
