import { describe, expect, test } from "bun:test";

import {
  BoxOverrideError,
  applyElementBoxOverrides,
  parseBoxOverrides,
} from "../../src/slides/geometry/box-overrides.ts";

describe("box overrides", () => {
  test("Given named element boxes, When an override targets one id, Then only that box moves", () => {
    const elements = [
      { id: "slide-hero:title", box: { x: 80, y: 72, width: 500, height: 180 } },
      { id: "slide-hero:statement", box: { x: 96, y: 330, width: 580, height: 220 } },
    ];
    const next = applyElementBoxOverrides(elements, [
      { elementId: "slide-hero:title", box: { x: 120, y: 100, width: 500, height: 180 } },
    ]);
    expect(next[0]?.box).toEqual({ x: 120, y: 100, width: 500, height: 180 });
    expect(next[1]?.box).toEqual(elements[1]?.box);
    expect(elements[0]?.box).toEqual({ x: 80, y: 72, width: 500, height: 180 });
  });

  test("Given an unknown element id, When overrides are applied, Then the original boxes are unchanged", () => {
    const elements = [{ id: "slide-hero:title", box: { x: 80, y: 72, width: 500, height: 180 } }];
    expect(applyElementBoxOverrides(elements, [
      { elementId: "slide-hero:missing", box: { x: 10, y: 10, width: 40, height: 40 } },
    ])).toEqual(elements);
  });

  test("Given a box that leaves the canvas, When it is parsed, Then the override is rejected", () => {
    expect(() => parseBoxOverrides([
      { elementId: "slide-hero:title", box: { x: 1200, y: 0, width: 200, height: 40 } },
    ], "slides[0].boxOverrides")).toThrow(BoxOverrideError);
  });
});
