import type { LayoutDraft } from "./contract.ts";
import {
  arrayValue, draft, element, enumValue, evidenceFor, objectValue, slideFields, textValue, titleElement,
} from "./shared.ts";

export function draftMetrics(value: unknown): LayoutDraft {
  const slide = slideFields(value, "metrics");
  const mode = enumValue(slide.payload.mode, "slide.payload.mode", ["chart", "cards"]);
  const metrics = arrayValue(slide.payload.metrics, "slide.payload.metrics");
  const elements = [titleElement(slide)];
  const columns = Math.max(1, Math.min(3, metrics.length));
  const rows = Math.ceil(metrics.length / columns);
  const grid = { x: 80, y: 190, width: 1120, height: 450, columnGap: 32, rowGap: 24 };
  const slotWidth = (grid.width - grid.columnGap * (columns - 1)) / columns;
  const slotHeight = (grid.height - grid.rowGap * (rows - 1)) / rows;
  metrics.forEach((rawMetric, index) => {
    const metric = objectValue(rawMetric, `slide.payload.metrics[${index}]`);
    const label = textValue(metric.label, `slide.payload.metrics[${index}].label`);
    const valueText = textValue(metric.value, `slide.payload.metrics[${index}].value`);
    const detail = textValue(metric.detail, `slide.payload.metrics[${index}].detail`);
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = Math.floor(grid.x + column * (slotWidth + grid.columnGap));
    const y = Math.floor(grid.y + row * (slotHeight + grid.rowGap));
    const width = Math.floor(slotWidth);
    elements.push(element(slide.id, elements.length, {
      key: `metric-${index}-label`, role: "metric-label", text: label,
      box: { x, y, width, height: 30 },
      tokens: { color: "colors.muted", size: "typography.label.size", font: "font.family" },
      evidence: evidenceFor(slide, `metrics[${index}].label`), accessibilityLabel: `Metric ${label}`,
    }));
    elements.push(element(slide.id, elements.length, {
      key: `metric-${index}-value`, role: "metric-value", text: valueText,
      box: { x, y: y + 42, width, height: 80 },
      tokens: { color: mode === "chart" ? "colors.blue" : "colors.coral", size: "typography.display.size", font: "font.family" },
      evidence: evidenceFor(slide, `metrics[${index}].value`), accessibilityLabel: `${label} value: ${valueText}`,
    }));
    elements.push(element(slide.id, elements.length, {
      key: `metric-${index}-detail`, role: "metric-detail", text: detail,
      box: { x, y: y + 134, width, height: 60 },
      tokens: { color: "colors.ink", size: "typography.body.size", font: "font.family" },
      evidence: evidenceFor(slide, `metrics[${index}].detail`), accessibilityLabel: `${label} detail: ${detail}`,
    }));
  });
  return draft(slide, mode, elements);
}
