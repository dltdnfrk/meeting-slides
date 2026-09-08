import type { PlanSlide } from "../model/plan.ts";

export const PLANNED_SLIDE_COUNT = 7;
export const MINIMUM_DISTINCT_LAYOUT_FAMILIES = 4;

export interface LayoutSelectionFailure {
  readonly message: string;
}

export function findLayoutSelectionFailure(
  slides: readonly Pick<PlanSlide, "layout">[],
): LayoutSelectionFailure | undefined {
  if (slides.length !== PLANNED_SLIDE_COUNT) {
    return {
      message: `must contain exactly ${PLANNED_SLIDE_COUNT} slides; received ${slides.length}`,
    };
  }
  const distinctLayouts = new Set(slides.map((slide) => slide.layout));
  if (distinctLayouts.size < MINIMUM_DISTINCT_LAYOUT_FAMILIES) {
    return {
      message: `must use at least ${MINIMUM_DISTINCT_LAYOUT_FAMILIES} distinct layout families`,
    };
  }
  return undefined;
}
