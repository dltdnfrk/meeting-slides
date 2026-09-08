import { expect, test } from "bun:test";

import type { PlanSlide } from "../../src/slides/model/plan.ts";
import { draftLayout } from "../../src/slides/layouts/registry.ts";

const summary: Extract<PlanSlide, { layout: "summary" }> = {
  id: "status-summary",
  layout: "summary",
  storyRole: "closing",
  title: "확정 1건·실행 1건·확인 1건입니다",
  payload: {
    mode: "takeaways",
    items: ["금요일 출시 확정", "9월 3일 노트 준비", "오류율 기준 확인 필요"],
  },
  bindings: {
    title: ["decision", "action", "open"],
    "items[0]": ["decision"],
    "items[1]": ["action"],
    "items[2]": ["open"],
  },
  editorialPaths: [],
  assetIds: [],
};

const comparison: Extract<PlanSlide, { layout: "comparison" }> = {
  id: "status-comparison",
  layout: "comparison",
  storyRole: "argument",
  title: "확정 사항과 확인 사항이 나뉩니다",
  payload: {
    sides: [
      { label: "확정", items: ["출시일", "노트 담당·기한"] },
      { label: "확인 필요", items: ["오류율 기준"] },
    ],
  },
  bindings: {
    title: ["decision", "action", "open"],
    "sides[0].items[0]": ["decision"],
    "sides[0].items[1]": ["action"],
    "sides[1].items[0]": ["open"],
  },
  editorialPaths: ["sides[0].label", "sides[1].label"],
  assetIds: [],
};

test("summary rows include editable numeric markers that expose their relationship", () => {
  const draft = draftLayout(summary);

  expect(draft.elements.filter((element) => element.role === "summary-marker"))
    .toMatchObject([{ text: "01" }, { text: "02" }, { text: "03" }]);
  expect(draft.elements.filter((element) => element.role === "summary-marker")
    .every((element) => element.accessibility.role === "note")).toBe(true);
});

test("comparison columns include editable indices that reinforce the two-sided grouping", () => {
  const draft = draftLayout(comparison);

  expect(draft.elements.filter((element) => element.role === "comparison-marker"))
    .toMatchObject([{ text: "01" }, { text: "02" }]);
  expect(draft.elements.filter((element) => element.role === "comparison-marker")
    .every((element) => element.accessibility.role === "note")).toBe(true);
});
