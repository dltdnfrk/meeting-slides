import type { SceneDeck, SceneElement, SceneSlide } from "./scene-graph.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

function frameStyle(element: SceneElement): string {
  return `left:${element.x}%;top:${element.y / 56.25 * 100}%;width:${element.w}%;height:${element.h / 56.25 * 100}%`;
}

function renderElement(element: SceneElement): string {
  if (element.type === "shape") {
    const border = element.stroke ? `border:${element.strokeWidth ?? 1}px solid #${element.stroke}` : "";
    const background = element.fill ? `background:#${element.fill}` : "";
    if (element.shape === "line") {
      return `<div class="scene-shape scene-line" data-scene-element="line" style="${frameStyle(element)};border-top:${element.strokeWidth ?? 1}px solid #${element.stroke ?? "000000"}"></div>`;
    }
    const radius = element.shape === "ellipse" ? "border-radius:50%" : "";
    return `<div class="scene-shape" data-scene-element="${element.shape}" style="${frameStyle(element)};${border};${background};${radius}"></div>`;
  }
  const weight = element.weight === "bold" ? 740 : element.weight === "semibold" ? 620 : 400;
  return `<div class="scene-text scene-text--${element.role}" data-scene-element="text" style="${frameStyle(element)};font-size:${element.fontSize}px;color:#${element.color};font-weight:${weight};text-align:${element.align ?? "left"}">${escapeHtml(element.text)}</div>`;
}

export function renderSceneSlideHtml(slide: SceneSlide): string {
  return `<section class="scene-slide" data-scene-slide="${slide.intent}" style="background:#${slide.background}">
  ${slide.elements.map(renderElement).join("\n  ")}
</section>`;
}

export function renderSceneSlideDocument(slide: SceneSlide): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><style>
html,body{margin:0;width:960px;height:540px;overflow:hidden;background:#${slide.background}}
*{box-sizing:border-box}.scene-slide{position:relative;width:960px;height:540px;overflow:hidden;font-family:Pretendard,-apple-system,BlinkMacSystemFont,"Noto Sans KR",sans-serif}
.scene-text,.scene-shape{position:absolute}.scene-text{display:flex;align-items:center;line-height:1.24;word-break:keep-all;overflow:hidden}.scene-line{height:0!important}
</style></head><body>${renderSceneSlideHtml(slide)}</body></html>`;
}

export function renderSceneDeckHtml(deck: SceneDeck): string {
  const sections = deck.slides.map(renderSceneSlideHtml).join("\n");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(deck.title)}</title></head><body>${sections}</body></html>`;
}
