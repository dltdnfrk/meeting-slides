import { describe, expect, test } from "bun:test";

import type { PlanSlide } from "../../src/slides/model/plan.ts";
import { draftLayout } from "../../src/slides/layouts/registry.ts";

type SummarySlide = Extract<PlanSlide, { layout: "summary" }>;

function base(): SummarySlide {
  return {
    id: "slide-summary-mode",
    layout: "summary",
    storyRole: "context",
    title: "The release gate is explicit",
    payload: { mode: "overview", items: ["The beta launches Friday."] },
    bindings: { title: ["claim-launch"], "items[0]": ["claim-launch"] },
    editorialPaths: [],
    assetIds: [],
  };
}

describe("summary layout honours payload.mode", () => {
  test("takeaways mode selects the list variant even for one quoted item", () => {
    // Given: a summary slide whose mode names the list presentation, with one quoted item
    const slide: SummarySlide = {
      ...base(),
      payload: { mode: "takeaways", items: ["“Quality is the release gate.”"] },
    };

    // When: the layout registry drafts the slide
    const draft = draftLayout(slide);

    // Then: the mode-selected list variant wins over the quote heuristic
    expect(draft.variant).toBe("list");
    expect(draft.elements.map((element) => element.role)).toEqual([
      "title", "summary-marker", "summary-item",
    ]);
  });

  test("overview mode with one plain item selects the statement variant", () => {
    // Given: an overview summary with a single plain item
    const slide = base();

    // When: the layout registry drafts the slide
    const draft = draftLayout(slide);

    // Then: a single plain overview item presents as a statement
    expect(draft.variant).toBe("statement");
    expect(draft.elements.map((element) => element.role)).toEqual(["title", "statement"]);
  });

  test("overview mode keeps the quote presentation for one quoted item", () => {
    // Given: an overview summary with a single quoted item, a mode that names no variant
    const slide: SummarySlide = {
      ...base(),
      payload: { mode: "overview", items: ["“Quality is the release gate.”"] },
    };

    // When: the layout registry drafts the slide
    const draft = draftLayout(slide);

    // Then: the item heuristic still names the quote presentation
    expect(draft.variant).toBe("quote");
    expect(draft.elements.map((element) => element.role)).toEqual(["title", "quote"]);
  });

  test("overview mode with several items keeps the list presentation", () => {
    // Given: an overview summary with multiple plain items
    const slide: SummarySlide = {
      ...base(),
      payload: {
        mode: "overview",
        items: ["Retention increased.", "Quality is the gate.", "The beta launches Friday."],
      },
      bindings: {
        title: ["claim-launch"],
        "items[0]": ["claim-retention"],
        "items[1]": ["claim-gate"],
        "items[2]": ["claim-launch"],
      },
    };

    // When: the layout registry drafts the slide
    const draft = draftLayout(slide);

    // Then: item count still names the list presentation for overview
    expect(draft.variant).toBe("list");
    expect(draft.elements.map((element) => element.role)).toEqual([
      "title",
      "summary-marker", "summary-item",
      "summary-marker", "summary-item",
      "summary-marker", "summary-item",
    ]);
  });
});
