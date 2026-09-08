import { ASSET_PLACEMENT_BOXES } from "../assets/integration.ts";
import type { LayoutDraft } from "./contract.ts";
import {
  arrayValue, draft, element, evidenceFor, slideFields, textValue, titleElement,
} from "./shared.ts";

const MARK_LEFT = ASSET_PLACEMENT_BOXES.summaryMark.x;
const TEXT_GUTTER = 24;

function isQuote(text: string): boolean {
  const trimmed = text.trim();
  return (trimmed.startsWith("“") && trimmed.endsWith("”")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'));
}

export function draftSummary(value: unknown): LayoutDraft {
  const slide = slideFields(value, "summary");
  const items = arrayValue(slide.payload.items, "slide.payload.items").map((item, index) =>
    textValue(item, `slide.payload.items[${index}]`));
  const first = items[0];
  const variant = slide.payload.mode === "takeaways"
    ? "list"
    : first !== undefined && items.length === 1
      ? (isQuote(first) ? "quote" : "statement")
      : "list";
  const elements = [titleElement(slide)];
  items.forEach((text, index) => {
    const role = variant === "quote" ? "quote" : variant === "statement" ? "statement" : "summary-item";
    const top = Math.floor(index * 460 / items.length);
    const bottom = Math.floor((index + 1) * 460 / items.length);
    const listX = 120;
    const featureX = 180;
    if (variant === "list") {
      elements.push(element(slide.id, elements.length, {
        key: `summary-marker-${index}`, role: "summary-marker",
        text: String(index + 1).padStart(2, "0"),
        box: { x: 80, y: 190 + top, width: 28, height: 40 },
        tokens: {
          color: "colors.coral",
          size: "typography.label.size",
          font: "font.family",
        },
        evidence: null,
        accessibilityRole: "note",
        accessibilityLabel: `Summary item ${index + 1}: ${String(index + 1).padStart(2, "0")}`,
      }));
    }
    elements.push(element(slide.id, elements.length, {
      key: `summary-${index}`, role, text,
      box: variant === "list"
        ? { x: listX, y: 190 + top, width: MARK_LEFT - listX - TEXT_GUTTER, height: Math.max(1, bottom - top - 12) }
        : { x: featureX, y: 245, width: MARK_LEFT - featureX - TEXT_GUTTER, height: 250 },
      tokens: {
        color: variant === "quote" ? "colors.blue" : "colors.ink",
        size: variant === "list" ? "typography.body.size" : "typography.display.size",
        font: "font.family",
      },
      evidence: evidenceFor(slide, `items[${index}]`),
      accessibilityLabel: `${role}: ${text}`,
    }));
  });
  return draft(slide, variant, elements);
}
