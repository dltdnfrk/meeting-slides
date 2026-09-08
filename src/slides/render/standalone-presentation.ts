import { toCssCustomProperties } from "../theme/css-tokens.ts";
import type { StandaloneDeckInput } from "./standalone-types.ts";
import type { EmbeddedResources } from "./standalone-resources.ts";

const GRAB_VIEWPORT_MEDIA = "@media (width: 960px) and (height: 540px)";
const LEGACY_GRAB_VIEWPORT_MEDIA =
  `${GRAB_VIEWPORT_MEDIA} and (min-resolution: 1.3dppx) and (max-resolution: 1.4dppx)`;

/** Adapt a verified legacy document only in the renderer's staging copy. */
export function fitSlidesGrabViewport(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/, stylesheet =>
    stylesheet.replace(LEGACY_GRAB_VIEWPORT_MEDIA, GRAB_VIEWPORT_MEDIA));
}

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function cssString(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\3c ");
}

function px(value: number): string {
  return Number.isFinite(value) ? `${value}px` : "0px";
}

export function presentationCss(
  input: StandaloneDeckInput,
  fontDataUrl: string,
  options: Readonly<{ bodyMode?: "presentation" | "slides-grab" }> = {},
): string {
  const properties = toCssCustomProperties(input.theme);
  const tokens = Object.entries(properties).map(([name, value]) =>
    `  ${name}: ${name === "--theme-font-localPath" ? `url(\"${fontDataUrl}\")` : value};`).join("\n");
  const { width, height } = input.theme.canvas;
  const grabBodyCss = options.bodyMode === "slides-grab"
    ? `
html, body { width: ${width}px; height: ${height}px; min-height: ${height}px; overflow: hidden; background: #${input.theme.colors.paper}; }
@media (min-width: ${width}px) { html, body { min-width: ${width}px; } }
body[data-slides-grab] { display: block; padding: 0; }
body[data-slides-grab] .deck { width: ${width}px; height: ${height}px; }
body[data-slides-grab] .slide { display: block; box-shadow: none; }
${GRAB_VIEWPORT_MEDIA} {
  body[data-slides-grab] .slide { transform: scale(.75); transform-origin: top left; }
}`
    : "";
  return `@font-face { font-family: ${cssString(input.theme.font.family)}; src: url("${fontDataUrl}") format("woff2"); font-display: block; }
:root {
${tokens}
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: #${input.theme.colors.muted}; color: #${input.theme.colors.ink}; font-family: ${cssString(input.theme.font.family)}, sans-serif; }
body { display: grid; place-items: center; padding: 56px 16px 72px; }${grabBodyCss}
.deck { position: relative; }
.slide { position: relative; flex: none; background: #${input.theme.colors.paper}; box-shadow: 0 12px 40px rgba(0,0,0,.24); }
.slide[aria-hidden="true"] { display: none; }
.geometry-text { white-space: normal; user-select: text; }
.text-line { white-space: pre; }
.geometry-decoration { background: currentColor; }
.asset { position: absolute; display: block; }
.controls { position: fixed; z-index: 10; inset: auto 16px 16px; display: flex; justify-content: center; align-items: center; gap: 8px; }
.controls button, .counter { border: 1px solid #${input.theme.colors.rule}; border-radius: ${input.theme.radius.small}px; padding: 8px 12px; background: #${input.theme.colors.raised}; color: #${input.theme.colors.ink}; font: inherit; }
:focus-visible { outline: 3px solid #${input.theme.colors.focus}; outline-offset: 3px; }
body.overview .deck { display: flex; flex-wrap: wrap; justify-content: center; gap: 24px; }
body.overview .slide { display: block; transform: scale(.32); transform-origin: top left; margin-right: -${width * 0.68}px; margin-bottom: -${height * 0.68}px; cursor: pointer; }
[data-presenter-notes] { position: fixed; z-index: 20; right: 16px; bottom: 72px; width: min(460px, calc(100vw - 32px)); padding: 16px; border: 2px solid #${input.theme.colors.focus}; border-radius: ${input.theme.radius.small}px; background: #${input.theme.colors.raised}; white-space: pre-wrap; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0ms; transition-duration: 0ms; scroll-behavior: auto; } }
@media print {
  @page { size: ${width}px ${height}px; margin: 0; }
  html, body { display: block; padding: 0; background: white; }
  .controls, [data-presenter-notes] { display: none; }
  .slide { display: block; width: ${width}px; height: ${height}px; break-after: page; box-shadow: none; }
  .slide:last-child { break-after: auto; }
}`;
}

function elementHtml(element: StandaloneDeckInput["slides"][number]["geometry"]["slide"]["elements"][number]): string {
  const box = element.box;
  const base = `position:absolute;left:${px(box.x)};top:${px(box.y)};width:${px(box.width)};height:${px(box.height)}`;
  if (element.accessibility.role === "presentation") {
    const color = typeof element.resolvedTokens.color === "string" ? `#${element.resolvedTokens.color}` : "currentColor";
    return `<div class="geometry-decoration" data-element-id="${escapeHtml(element.id)}" style="${base};color:${escapeHtml(color)}" role="presentation" aria-hidden="true"></div>`;
  }
  const size = element.fitTrace.finalFontSize;
  const lineHeight = element.resolvedTokens.lineHeight;
  const lineHeightCss = typeof lineHeight === "number" && Number.isFinite(lineHeight)
    ? `;line-height:${px(lineHeight)}` : "";
  const color = typeof element.resolvedTokens.color === "string" ? `#${element.resolvedTokens.color}` : "inherit";
  const font = typeof element.resolvedTokens.font === "string" ? element.resolvedTokens.font : "inherit";
  const lines = element.lines.map((line) => `<span class="text-line">${escapeHtml(line)}</span>`).join("<br>");
  return `<div class="geometry-text" data-element-id="${escapeHtml(element.id)}" style="${base};font-size:${px(size)}${lineHeightCss};color:${escapeHtml(color)};font-family:${escapeHtml(font)}" role="${escapeHtml(element.accessibility.role)}" aria-label="${escapeHtml(element.accessibility.label)}">${lines}</div>`;
}

export function renderSlideSection(input: StandaloneDeckInput, resources: EmbeddedResources, index: number): string {
  const entry = input.slides[index]!;
  const slide = entry.geometry.slide;
  const elements = slide.elements.map(elementHtml).join("\n");
  const assets = resources.slides[index]!.placements.map(({ placement, dataUrl }) => {
    const { box } = placement;
    const alt = placement.accessibility.role === "presentation" ? "" : placement.accessibility.label;
    return `<img class="asset" data-placement-id="${escapeHtml(placement.id)}" src="${dataUrl}" alt="${escapeHtml(alt)}" role="${placement.accessibility.role}" style="left:${px(box.x)};top:${px(box.y)};width:${px(box.width)};height:${px(box.height)};object-fit:${placement.fit}">`;
  }).join("\n");
  const hidden = index === 0 ? "false" : "true";
  return `<section class="slide" data-slide-index="${index}" data-slide-id="${escapeHtml(slide.slideId)}" data-variant="${escapeHtml(slide.variant)}" role="group" aria-roledescription="slide" aria-label="Slide ${index + 1} of ${input.slides.length}" aria-hidden="${hidden}" style="width:${slide.canvas.width}px;height:${slide.canvas.height}px">
${elements}${assets === "" ? "" : `\n${assets}`}
</section>`;
}
