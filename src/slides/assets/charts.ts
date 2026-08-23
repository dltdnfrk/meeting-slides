import type { Theme } from "../model/plan.ts";
import {
  claimIds,
  colorValue,
  escapeXml,
  finishSvg,
  positiveInteger,
  requiredText,
  type RenderedSvgAsset,
  type SemanticColorToken,
} from "./svg-renderer.ts";

export interface ChartSeries {
  readonly id: string;
  readonly label: string;
  readonly color: SemanticColorToken | string;
  readonly values: readonly number[];
}

export interface ChartRenderInput {
  readonly type: "bar" | "line";
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly description: string;
  readonly altDescription: string;
  readonly claimIds: readonly string[];
  readonly categories: readonly string[];
  readonly series: readonly ChartSeries[];
}

interface Plot {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly min: number;
  readonly max: number;
  readonly baseline: number;
}

function number(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function validate(input: ChartRenderInput): void {
  if (input.type !== "bar" && input.type !== "line") throw new TypeError("chart type must be bar or line");
  positiveInteger(input.width, "width");
  positiveInteger(input.height, "height");
  requiredText(input.title, "title");
  requiredText(input.description, "description");
  requiredText(input.altDescription, "altDescription");
  claimIds(input.claimIds);
  if (!Array.isArray(input.categories) || !Array.isArray(input.series) ||
      input.categories.length === 0 || input.series.length === 0) {
    throw new TypeError("chart dataset must not be empty");
  }
  input.categories.forEach((category, index) => requiredText(category, `categories[${index}]`));
  const ids = new Set<string>();
  input.series.forEach((series, seriesIndex) => {
    const id = requiredText(series.id, `series[${seriesIndex}].id`);
    if (ids.has(id)) throw new TypeError(`duplicate series ID '${id}'`);
    ids.add(id);
    requiredText(series.label, `series[${seriesIndex}].label`);
    if (!Array.isArray(series.values) || series.values.length !== input.categories.length) {
      throw new TypeError(`series[${seriesIndex}] value count must match categories`);
    }
    series.values.forEach((value: number, valueIndex: number) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`series[${seriesIndex}].values[${valueIndex}] must be finite`);
      }
    });
  });
}

function plotFor(input: ChartRenderInput): Plot {
  const values = input.series.flatMap((series) => [...series.values]);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const adjustedMax = min === max ? max + 1 : max;
  const left = Math.max(56, Math.round(input.width * 0.1));
  const top = Math.max(72, Math.round(input.height * 0.2));
  const width = input.width - left - Math.max(24, Math.round(input.width * 0.05));
  const height = input.height - top - Math.max(56, Math.round(input.height * 0.18));
  const baseline = top + ((adjustedMax - 0) / (adjustedMax - min)) * height;
  return { left, top, width, height, min, max: adjustedMax, baseline };
}

function y(value: number, plot: Plot): number {
  return plot.top + ((plot.max - value) / (plot.max - plot.min)) * plot.height;
}

function labels(input: ChartRenderInput, plot: Plot, theme: Theme): string {
  const categoryWidth = plot.width / input.categories.length;
  const categories = input.categories.map((category, index) =>
    `<text x="${number(plot.left + categoryWidth * (index + 0.5))}" y="${number(plot.top + plot.height + theme.spacing.md)}" text-anchor="middle">${escapeXml(category)}</text>`).join("");
  const legendGap = Math.max(96, Math.floor(plot.width / input.series.length));
  const legend = input.series.map((series, index) =>
    `<g><line x1="${plot.left + index * legendGap}" y1="${theme.spacing.md}" x2="${plot.left + 16 + index * legendGap}" y2="${theme.spacing.md}" stroke="${colorValue(theme, series.color)}" stroke-width="${theme.stroke.strong}"/><text x="${plot.left + 22 + index * legendGap}" y="${theme.spacing.md + 5}">${escapeXml(series.label)}</text></g>`).join("");
  return `${legend}${categories}`;
}

function bars(input: ChartRenderInput, plot: Plot, theme: Theme): string {
  const groupWidth = plot.width / input.categories.length;
  const width = Math.max(1, groupWidth * 0.72 / input.series.length);
  return input.categories.map((_, categoryIndex) => input.series.map((series, seriesIndex) => {
    const valueY = y(series.values[categoryIndex]!, plot);
    const x = plot.left + categoryIndex * groupWidth + groupWidth * 0.14 + seriesIndex * width;
    return `<rect class="bar" x="${number(x)}" y="${number(Math.min(valueY, plot.baseline))}" width="${number(width)}" height="${number(Math.abs(plot.baseline - valueY))}" fill="${colorValue(theme, series.color)}"/>`;
  }).join("")).join("");
}

function lines(input: ChartRenderInput, plot: Plot, theme: Theme): string {
  const step = input.categories.length === 1 ? 0 : plot.width / (input.categories.length - 1);
  return input.series.map((series) => {
    const points = series.values.map((value, index) => `${number(plot.left + step * index)},${number(y(value, plot))}`).join(" ");
    const color = colorValue(theme, series.color);
    const dots = series.values.map((value, index) => `<circle cx="${number(plot.left + step * index)}" cy="${number(y(value, plot))}" r="${theme.stroke.strong}" fill="${color}"/>`).join("");
    return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${theme.stroke.strong}" stroke-linejoin="round"/>${dots}`;
  }).join("");
}

export function renderChart(input: ChartRenderInput, theme: Theme): RenderedSvgAsset {
  validate(input);
  const width = positiveInteger(input.width, "width");
  const height = positiveInteger(input.height, "height");
  const claims = claimIds(input.claimIds);
  const plot = plotFor(input);
  const title = escapeXml(input.title);
  const description = escapeXml(input.description);
  const marks = input.type === "bar" ? bars(input, plot, theme) : lines(input, plot, theme);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description"><title id="title">${title}</title><desc id="description">${description}</desc><rect width="${width}" height="${height}" fill="${colorValue(theme, "colors.paper")}"/><g font-family="${escapeXml(theme.font.family)}" font-size="${theme.typography.label.size}" fill="${colorValue(theme, "colors.ink")}">${labels(input, plot, theme)}<line x1="${plot.left}" y1="${number(plot.baseline)}" x2="${number(plot.left + plot.width)}" y2="${number(plot.baseline)}" stroke="${colorValue(theme, "colors.rule")}" stroke-width="${theme.stroke.thin}"/>${marks}</g></svg>`;
  return finishSvg(svg, {
    purpose: "informative",
    kind: "chart",
    width,
    height,
    altDescription: input.altDescription,
    source: { kind: "generated", generator: "meeting-chart-svg-v1" },
    claimIds: claims,
  });
}
