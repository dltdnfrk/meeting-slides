import type { LayoutDraft } from "./contract.ts";
import {
  arrayValue, draft, element, evidenceFor, slideFields, textValue, titleElement,
} from "./shared.ts";

function isQuote(text: string): boolean {
  const trimmed = text.trim();
  return (trimmed.startsWith("“") && trimmed.endsWith("”")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'));
}

export function draftSummary(value: unknown): LayoutDraft {
  const slide = slideFields(value, "summary");
  const items = arrayValue(slide.payload.items, "slide.payload.items").map((item, index) =>
    textValue(item, `slide.payload.items[${index}]`));
  const variant = items.length === 1 ? (isQuote(items[0]!) ? "quote" : "statement") : "list";
  const elements = [titleElement(slide)];
  items.forEach((text, index) => {
    const role = variant === "quote" ? "quote" : variant === "statement" ? "statement" : "summary-item";
    const top = Math.floor(index * 460 / items.length);
    const bottom = Math.floor((index + 1) * 460 / items.length);
    elements.push(element(slide.id, elements.length, {
      key: `summary-${index}`, role, text,
      box: variant === "list"
        ? { x: 120, y: 190 + top, width: 1040, height: Math.max(1, bottom - top - 12) }
        : { x: 180, y: 245, width: 920, height: 250 },
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
