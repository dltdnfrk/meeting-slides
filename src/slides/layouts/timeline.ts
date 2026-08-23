import type { LayoutDraft } from "./contract.ts";
import {
  arrayValue, draft, element, enumValue, evidenceFor, objectValue, slideFields, textValue, titleElement,
} from "./shared.ts";

export function draftTimeline(value: unknown): LayoutDraft {
  const slide = slideFields(value, "timeline");
  const mode = enumValue(slide.payload.mode, "slide.payload.mode", ["process", "chronology"]);
  const events = arrayValue(slide.payload.events, "slide.payload.events");
  const elements = [titleElement(slide)];
  events.forEach((rawEvent, index) => {
    const event = objectValue(rawEvent, `slide.payload.events[${index}]`);
    const label = textValue(event.label, `slide.payload.events[${index}].label`);
    const text = textValue(event.text, `slide.payload.events[${index}].text`);
    const left = Math.floor(index * 1040 / events.length);
    const right = Math.floor((index + 1) * 1040 / events.length);
    const x = 80 + left;
    const width = Math.max(1, right - left - 24);
    elements.push(element(slide.id, elements.length, {
      key: `event-${index}-label`, role: "event-label", text: label,
      box: { x, y: 220, width, height: 52 },
      tokens: { color: mode === "process" ? "colors.coral" : "colors.blue", size: "typography.label.size", font: "font.family" },
      evidence: null, accessibilityLabel: `Event label: ${label}`,
    }));
    elements.push(element(slide.id, elements.length, {
      key: `event-${index}`, role: "event", text,
      box: { x, y: 300, width, height: 190 },
      tokens: { color: "colors.ink", size: "typography.body.size", font: "font.family" },
      evidence: evidenceFor(slide, `events[${index}].text`), accessibilityLabel: `${label}: ${text}`,
    }));
  });
  return draft(slide, mode, elements);
}
