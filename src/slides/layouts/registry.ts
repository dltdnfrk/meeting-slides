import type { PlanSlide } from "../model/plan.ts";
import { draftActions } from "./actions.ts";
import { draftComparison } from "./comparison.ts";
import type { LayoutDefinition, LayoutDraft } from "./contract.ts";
import { LayoutRegistryError } from "./contract.ts";
import { draftDecision } from "./decision.ts";
import { draftHero } from "./hero.ts";
import { draftMetrics } from "./metrics.ts";
import { draftSummary } from "./summary.ts";
import { draftTimeline } from "./timeline.ts";

export const PRIMARY_LAYOUT_FAMILIES = Object.freeze([
  "hero",
  "summary",
  "decision",
  "comparison",
  "timeline",
  "metrics",
  "actions",
] as const satisfies readonly PlanSlide["layout"][]);

const DEFINITIONS: Readonly<Record<PlanSlide["layout"], LayoutDefinition>> = Object.freeze({
  hero: Object.freeze({ family: "hero", draft: draftHero }),
  summary: Object.freeze({ family: "summary", draft: draftSummary }),
  decision: Object.freeze({ family: "decision", draft: draftDecision }),
  comparison: Object.freeze({ family: "comparison", draft: draftComparison }),
  timeline: Object.freeze({ family: "timeline", draft: draftTimeline }),
  metrics: Object.freeze({ family: "metrics", draft: draftMetrics }),
  actions: Object.freeze({ family: "actions", draft: draftActions }),
});

function isLayout(value: unknown): value is PlanSlide["layout"] {
  return typeof value === "string" && PRIMARY_LAYOUT_FAMILIES.some((family) => family === value);
}

function shown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return Object.prototype.toString.call(value);
}

export function getLayoutDefinition(layout: unknown): LayoutDefinition {
  if (!isLayout(layout)) {
    throw new LayoutRegistryError(
      "unknown-layout",
      "layout",
      `unknown layout '${shown(layout)}'; expected ${PRIMARY_LAYOUT_FAMILIES.join(", ")}`,
    );
  }
  return DEFINITIONS[layout];
}

export function draftLayout(slide: unknown): LayoutDraft {
  let layout: unknown;
  if (typeof slide === "object" && slide !== null && !Array.isArray(slide)) {
    layout = Object.getOwnPropertyDescriptor(slide, "layout")?.value;
  }
  if (!isLayout(layout)) {
    throw new LayoutRegistryError(
      "unknown-layout",
      "slide.layout",
      `unknown slide.layout '${shown(layout)}'; expected ${PRIMARY_LAYOUT_FAMILIES.join(", ")}`,
    );
  }
  return DEFINITIONS[layout].draft(slide);
}
