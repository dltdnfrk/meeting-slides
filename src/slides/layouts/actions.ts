import type { LayoutDraft } from "./contract.ts";
import {
  arrayValue, draft, element, evidenceFor, objectValue, slideFields, textValue, titleElement,
} from "./shared.ts";

export function draftActions(value: unknown): LayoutDraft {
  const slide = slideFields(value, "actions");
  const items = arrayValue(slide.payload.items, "slide.payload.items");
  const elements = [titleElement(slide)];
  items.forEach((rawItem, index) => {
    const item = objectValue(rawItem, `slide.payload.items[${index}]`);
    const task = textValue(item.task, `slide.payload.items[${index}].task`);
    const owner = textValue(item.owner, `slide.payload.items[${index}].owner`);
    const due = textValue(item.due, `slide.payload.items[${index}].due`);
    const top = Math.floor(index * 460 / items.length);
    const bottom = Math.floor((index + 1) * 460 / items.length);
    const y = 190 + top;
    const height = Math.max(1, bottom - top - 12);
    elements.push(element(slide.id, elements.length, {
      key: `action-${index}-task`, role: "action-task", text: task,
      box: { x: 80, y, width: 610, height },
      tokens: { color: "colors.ink", size: "typography.heading.size", font: "font.family" },
      evidence: evidenceFor(slide, `items[${index}].task`), accessibilityLabel: `Task: ${task}`,
    }));
    elements.push(element(slide.id, elements.length, {
      key: `action-${index}-owner`, role: "action-owner", text: owner,
      box: { x: 740, y, width: 200, height },
      tokens: { color: "colors.blue", size: "typography.body.size", font: "font.family" },
      evidence: evidenceFor(slide, `items[${index}].owner`), accessibilityLabel: `Owner: ${owner}`,
    }));
    elements.push(element(slide.id, elements.length, {
      key: `action-${index}-due`, role: "action-due", text: due,
      box: { x: 980, y, width: 220, height },
      tokens: { color: "colors.coral", size: "typography.body.size", font: "font.family" },
      evidence: evidenceFor(slide, `items[${index}].due`), accessibilityLabel: `Due: ${due}`,
    }));
  });
  return draft(slide, "owner-due", elements);
}
