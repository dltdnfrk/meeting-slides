import { draftLayout } from "../layouts/registry.ts";
import type { LayoutDraft } from "../layouts/contract.ts";
import type { PlanSlide, SlidePlan, Theme } from "../model/plan.ts";
import { compileGeometrySlide } from "./compiler.ts";
import type { GeometryCompileResult, GeometryCompilerOptions, GeometrySlide } from "./contract.ts";
import { applyElementBoxOverrides } from "./box-overrides.ts";

interface PreparedPlanSlideGeometry {
  readonly draft: LayoutDraft;
  readonly compile: (theme: Theme, options: GeometryCompilerOptions) => GeometryCompileResult;
}

// Keep drafting separate from measurement so publication can report its layout
// phase and retain the original publisher draft before compiling overridden boxes.
export function preparePlanSlideGeometry(slide: PlanSlide): PreparedPlanSlideGeometry {
  const draft = draftLayout(slide);
  return {
    draft,
    compile: (theme, options) => compileGeometrySlide({
      ...draft,
      elements: applyElementBoxOverrides(draft.elements, slide.boxOverrides),
    }, theme, options),
  };
}

export function geometrySlidesForPlan(
  plan: SlidePlan,
  options: GeometryCompilerOptions,
): readonly GeometrySlide[] {
  return plan.slides.map((slide) => preparePlanSlideGeometry(slide).compile(plan.theme, options).slide);
}
