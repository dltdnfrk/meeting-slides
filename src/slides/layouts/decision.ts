import type { LayoutDraft } from "./contract.ts";
import {
  arrayValue, draft, element, evidenceFor, slideFields, textValue, titleElement,
} from "./shared.ts";

export function draftDecision(value: unknown): LayoutDraft {
  const slide = slideFields(value, "decision");
  const decision = textValue(slide.payload.decision, "slide.payload.decision");
  const rationale = arrayValue(slide.payload.rationale, "slide.payload.rationale").map((item, index) =>
    textValue(item, `slide.payload.rationale[${index}]`));
  const elements = [
    titleElement(slide),
    element(slide.id, 1, {
      key: "decision", role: "decision", text: decision,
      box: { x: 80, y: 190, width: 760, height: 384 },
      tokens: { color: "colors.coral", size: "typography.display.size", font: "font.family" },
      evidence: evidenceFor(slide, "decision"), accessibilityLabel: `Decision: ${decision}`,
    }),
  ];
  rationale.forEach((text, index) => {
    const top = Math.floor(index * 528 / rationale.length);
    const bottom = Math.floor((index + 1) * 528 / rationale.length);
    elements.push(element(slide.id, elements.length, {
    key: `rationale-${index}`, role: "rationale", text,
    box: { x: 900, y: 190 + top, width: 300, height: Math.max(1, bottom - top - 8) },
    tokens: { color: "colors.ink", size: "typography.body.size", font: "font.family" },
    evidence: evidenceFor(slide, `rationale[${index}]`), accessibilityLabel: `Rationale ${index + 1}: ${text}`,
    }));
  });
  return draft(slide, "decision-rationale", elements);
}
