import type { LayoutDraft } from "./contract.ts";
import { draft, element, enumValue, evidenceFor, slideFields, textValue } from "./shared.ts";

export function draftHero(value: unknown): LayoutDraft {
  const slide = slideFields(value, "hero");
  const variant = enumValue(slide.payload.variant, "slide.payload.variant", ["cover", "statement"]);
  const statement = textValue(slide.payload.statement, "slide.payload.statement");
  const cover = variant === "cover";
  return draft(slide, variant, [
    element(slide.id, 0, {
      key: "title", role: "title", text: slide.title,
      box: cover ? { x: 80, y: 72, width: 500, height: 180 } : { x: 760, y: 80, width: 440, height: 150 },
      tokens: { color: "colors.ink", size: "typography.display.size", font: "font.family" },
      evidence: evidenceFor(slide, "title"), accessibilityLabel: `Slide title: ${slide.title}`,
    }),
    element(slide.id, 1, {
      key: "statement", role: "statement", text: statement,
      box: cover ? { x: 620, y: 330, width: 580, height: 220 } : { x: 80, y: 270, width: 800, height: 250 },
      tokens: { color: "colors.coral", size: "typography.heading.size", font: "font.family" },
      evidence: evidenceFor(slide, "statement"), accessibilityLabel: `Key statement: ${statement}`,
    }),
  ]);
}
