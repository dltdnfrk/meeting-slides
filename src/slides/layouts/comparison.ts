import type { LayoutDraft } from "./contract.ts";
import { LayoutRegistryError } from "./contract.ts";
import {
  arrayValue, draft, element, evidenceFor, objectValue, slideFields, textValue, titleElement,
} from "./shared.ts";

export function draftComparison(value: unknown): LayoutDraft {
  const slide = slideFields(value, "comparison");
  const sides = arrayValue(slide.payload.sides, "slide.payload.sides");
  if (sides.length !== 2) {
    throw new LayoutRegistryError("invalid-payload", "slide.payload.sides", "must contain exactly two sides");
  }
  const elements = [titleElement(slide)];
  sides.forEach((rawSide, sideIndex) => {
    const side = objectValue(rawSide, `slide.payload.sides[${sideIndex}]`);
    const label = textValue(side.label, `slide.payload.sides[${sideIndex}].label`);
    const items = arrayValue(side.items, `slide.payload.sides[${sideIndex}].items`);
    const x = sideIndex === 0 ? 80 : 680;
    elements.push(element(slide.id, elements.length, {
      key: `side-${sideIndex}-marker`, role: "comparison-marker",
      text: String(sideIndex + 1).padStart(2, "0"),
      box: { x, y: 180, width: 32, height: 54 },
      tokens: {
        color: "colors.coral",
        size: "typography.label.size",
        font: "font.family",
      },
      evidence: null,
      accessibilityRole: "note",
      accessibilityLabel: `Comparison side ${sideIndex + 1}: ${String(sideIndex + 1).padStart(2, "0")}`,
    }));
    elements.push(element(slide.id, elements.length, {
      key: `side-${sideIndex}-label`, role: "comparison-label", text: label,
      box: { x: x + 48, y: 180, width: 472, height: 54 },
      tokens: { color: sideIndex === 0 ? "colors.muted" : "colors.blue", size: "typography.label.size", font: "font.family" },
      evidence: null, accessibilityLabel: `Comparison side: ${label}`,
    }));
    items.forEach((rawItem, itemIndex) => {
      const text = textValue(rawItem, `slide.payload.sides[${sideIndex}].items[${itemIndex}]`);
      const top = Math.floor(itemIndex * 456 / items.length);
      const bottom = Math.floor((itemIndex + 1) * 456 / items.length);
      elements.push(element(slide.id, elements.length, {
        key: `side-${sideIndex}-item-${itemIndex}`, role: "comparison-item", text,
        box: { x, y: 260 + top, width: 520, height: Math.max(1, bottom - top - 8) },
        tokens: { color: "colors.ink", size: "typography.body.size", font: "font.family" },
        evidence: evidenceFor(slide, `sides[${sideIndex}].items[${itemIndex}]`),
        accessibilityLabel: `${label} item: ${text}`,
      }));
    });
  });
  return draft(slide, "two-sided", elements);
}
