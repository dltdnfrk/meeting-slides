import type { StandaloneDeckInput } from "./standalone-types.ts";
import type { EmbeddedResources } from "./standalone-resources.ts";
import { escapeHtml, presentationCss } from "./standalone-presentation.ts";

function inertJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

function metadata(input: StandaloneDeckInput): string {
  return inertJson({
    schemaVersion: 1,
    deckId: input.id,
    title: input.title,
    slides: input.slides.map((entry) => ({
      slideId: entry.geometry.slide.slideId,
      notes: entry.notes ?? "",
      evidence: entry.geometry.slide.elements.flatMap((element) => element.evidence === null ? [] : [{
        elementId: element.id,
        fieldPath: element.evidence.fieldPath,
        claimIds: [...element.evidence.claimIds],
      }]),
    })),
  });
}

const RUNTIME = `"use strict";
(() => {
  const slides = Array.from(document.querySelectorAll(".slide"));
  const counter = document.querySelector("[data-slide-counter]");
  const notesPanel = document.querySelector("[data-presenter-notes]");
  const metadata = JSON.parse(document.getElementById("deck-metadata").textContent || "{}");
  let current = 0;
  let overview = false;
  const show = (next) => {
    current = Math.max(0, Math.min(slides.length - 1, next));
    slides.forEach((slide, index) => slide.setAttribute("aria-hidden", overview || index === current ? "false" : "true"));
    counter.textContent = String(current + 1) + " / " + String(slides.length);
    const record = metadata.slides[current];
    notesPanel.textContent = record && record.notes ? record.notes : "No presenter notes";
  };
  const setOverview = (value) => {
    overview = value;
    document.body.classList.toggle("overview", overview);
    show(current);
  };
  const action = (name) => {
    if (name === "previous") show(current - 1);
    if (name === "next") show(current + 1);
    if (name === "overview") setOverview(!overview);
    if (name === "presenter") notesPanel.hidden = !notesPanel.hidden;
  };
  document.querySelector(".controls").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (button) action(button.dataset.action);
  });
  slides.forEach((slide, index) => slide.addEventListener("click", () => {
    if (overview) { current = index; setOverview(false); }
  }));
  addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "PageUp") action("previous");
    if (event.key === "ArrowRight" || event.key === "PageDown") action("next");
    if (event.key === "Home") show(0);
    if (event.key === "End") show(slides.length - 1);
    if (event.key === "Escape") setOverview(false);
  });
  show(0);
})();`;

function head(
  input: StandaloneDeckInput,
  resources: EmbeddedResources,
  bodyMode: "presentation" | "slides-grab" = "presentation",
): string {
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>${presentationCss(input, resources.fontDataUrl, { bodyMode })}</style>
</head>`;
}

export function deckDocument(input: StandaloneDeckInput, resources: EmbeddedResources, sections: readonly string[]): string {
  return `<!doctype html>
<html lang="${escapeHtml(input.lang)}">
${head(input, resources)}
<body>
<main class="deck" aria-label="${escapeHtml(input.title)}">
${sections.join("\n")}
</main>
<nav class="controls" aria-label="Presentation controls">
<button type="button" data-action="previous" aria-label="Previous slide">Previous</button>
<span class="counter" data-slide-counter aria-live="polite">1 / ${input.slides.length}</span>
<button type="button" data-action="next" aria-label="Next slide">Next</button>
<button type="button" data-action="overview" aria-label="Toggle overview">Overview</button>
<button type="button" data-action="presenter" aria-label="Toggle presenter notes">Notes</button>
</nav>
<aside data-presenter-notes hidden></aside>
<script id="deck-metadata" type="application/json">${metadata(input)}</script>
<script id="deck-runtime">${RUNTIME}</script>
</body>
</html>
`;
}

export function grabDocument(input: StandaloneDeckInput, resources: EmbeddedResources, section: string): string {
  return `<!doctype html>
<html lang="${escapeHtml(input.lang)}">
${head(input, resources, "slides-grab")}
<body data-slides-grab>
<main class="deck" aria-label="${escapeHtml(input.title)}">
${section}
</main>
</body>
</html>
`;
}
