import { describe, expect, test } from "bun:test";

import { applyElementBoxOverrides } from "../../src/slides/geometry/box-overrides.ts";
import { compileGeometrySlide } from "../../src/slides/geometry/compiler.ts";
import { geometrySlidesForPlan } from "../../src/slides/geometry/plan-geometry.ts";
import { draftLayout, PRIMARY_LAYOUT_FAMILIES } from "../../src/slides/layouts/registry.ts";
import type { PlanSlide, SlidePlan } from "../../src/slides/model/plan.ts";
import { productionTextPolicies, ScriptAwareTextMeasurer } from "../../src/slides/server-action-support.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../../src/slides/theme/meeting-paper.ts";

function slide(layout: PlanSlide["layout"]): PlanSlide {
  const base = { id: `geometry-${layout}`, storyRole: "argument" as const, title: "Release evidence", editorialPaths: [], assetIds: [] };
  const bind = ["claim-release"];
  switch (layout) {
    case "hero": return { ...base, layout, payload: { variant: "cover", statement: "Friday launch" }, bindings: { title: bind, statement: bind } };
    case "summary": return { ...base, layout, payload: { mode: "overview", items: ["Release ready"] }, bindings: { title: bind, "items[0]": bind } };
    case "decision": return { ...base, layout, payload: { decision: "Launch Friday", rationale: ["Ready"] }, bindings: { title: bind, decision: bind, "rationale[0]": bind } };
    case "comparison": return { ...base, layout, payload: { sides: [{ label: "Before", items: ["Pending"] }, { label: "After", items: ["Ready"] }] }, bindings: { title: bind, "sides[0].items[0]": bind, "sides[1].items[0]": bind }, editorialPaths: ["sides[0].label", "sides[1].label"] };
    case "timeline": return { ...base, layout, payload: { mode: "process", events: [{ label: "Friday", text: "Launch" }] }, bindings: { title: bind, "events[0].text": bind }, editorialPaths: ["events[0].label"] };
    case "metrics": return { ...base, layout, payload: { mode: "cards", metrics: [{ label: "Readiness", value: "Ready", detail: "Reviewed" }] }, bindings: { title: bind, "metrics[0].label": bind, "metrics[0].value": bind, "metrics[0].detail": bind } };
    case "actions": return { ...base, layout, payload: { items: [{ task: "Publish notes", owner: "Mina", due: "Friday" }] }, bindings: { title: bind, "items[0].task": bind, "items[0].owner": bind, "items[0].due": bind } };
  }
}

function plan(slides: PlanSlide[]): SlidePlan {
  return {
    schemaVersion: 1, planId: "geometry-plan", revision: 0, title: "Release",
    snapshot: { meetingId: 17, transcriptVersionId: "v17", contentSha256: "a".repeat(64), lineCount: 1 },
    createdAt: "2026-08-15T10:00:00.000Z", updatedAt: "2026-08-15T10:00:00.000Z",
    theme: MEETING_PAPER_STYLE_PROFILE, claims: [], assets: [], slides,
  };
}

const options = { textMeasurer: new ScriptAwareTextMeasurer(), textPolicies: productionTextPolicies() };

describe("plan geometry restoration characterization", () => {
  for (const overrides of [false, true]) {
    test(`Given all seven families ${overrides ? "with" : "without"} overrides, When restored, Then draft/fit/evidence geometry is unchanged`, () => {
      const input = plan(PRIMARY_LAYOUT_FAMILIES.map((layout) => {
        const source = slide(layout);
        if (!overrides) return source;
        const title = draftLayout(source).elements.find((element) => element.role === "title");
        if (title === undefined) throw new Error("fixture title missing");
        return { ...source, boxOverrides: [
          { elementId: title.id, box: { ...title.box, x: title.box.x + 1.6, width: title.box.width - 2.4 } },
          { elementId: `${source.id}:unknown`, box: { x: 1, y: 1, width: 20, height: 20 } },
        ] };
      }));
      const before = structuredClone(input);
      const expected = input.slides.map((source) => {
        const draft = draftLayout(source);
        return compileGeometrySlide({ ...draft, elements: applyElementBoxOverrides(draft.elements, source.boxOverrides) }, input.theme, options).slide;
      });

      const restored = geometrySlidesForPlan(input, options);

      expect(restored).toEqual(expected);
      expect(restored.map((entry) => entry.layout)).toEqual([...PRIMARY_LAYOUT_FAMILIES]);
      expect(input).toEqual(before);
      for (const [index, entry] of restored.entries()) {
        expect(Object.isFrozen(entry)).toBe(true);
        const source = input.slides[index];
        if (source === undefined) throw new Error("fixture slide missing");
        const original = draftLayout(source).elements.find((element) => element.role === "title");
        const title = entry.elements.find((element) => element.role === "title");
        if (original === undefined || title === undefined) throw new Error("fixture title missing");
        expect(title.box.x).toBe(original.box.x + (overrides ? 2 : 0));
        expect(title.evidence).toEqual(original.evidence);
      }
    });
  }

  test("Given colliding text boxes, When restored, Then geometry is returned without publication preflight", () => {
    const source = slide("hero");
    const box = { x: 80, y: 80, width: 600, height: 200 };
    source.boxOverrides = draftLayout(source).elements.map((element) => ({ elementId: element.id, box }));

    const restored = geometrySlidesForPlan(plan([source]), options);

    expect(restored[0]?.elements.every((element) => JSON.stringify(element.box) === JSON.stringify(box))).toBe(true);
  });

  test("Given production role policies, When consumed, Then role floors and immutable wrapping modes remain stable", () => {
    const policies = productionTextPolicies();
    expect(Object.keys(policies)).toHaveLength(18);
    for (const [role, policy] of Object.entries(policies)) {
      const labels = ["summary-marker", "comparison-marker", "comparison-label", "event-label", "metric-label", "action-owner", "action-due"];
      const prominent = ["statement", "quote", "decision", "metric-value", "action-task"];
      expect(policy).toEqual({ mode: role === "title" ? "shrink" : "wrap", wordBreak: "keep-all", overflowWrap: "break-word", fontFloor: role === "title" ? 28 : labels.includes(role) ? 14 : prominent.includes(role) ? 22 : 18 });
      expect(Object.isFrozen(policy)).toBe(true);
    }
    expect(Object.isFrozen(policies)).toBe(true);
  });

  test("Given mixed scripts, When measured, Then production advances remain script-aware", () => {
    const measured = options.textMeasurer.measure({ text: "\uAC00\u6F22\u3042\u30A2 Aaz!$", fontFamily: "Fixture", fontSize: 20 });
    expect(measured.width).toBeCloseTo((4 + 0.32 + 0.62 + 0.56 + 0.56 + 0.5 + 0.5) * 20);
    expect(measured.height).toBe(20);
  });
});
