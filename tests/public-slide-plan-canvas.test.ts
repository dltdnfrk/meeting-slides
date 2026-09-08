import { describe, expect, test } from "bun:test";

import {
  fitCanvasText,
  fitCanvasViewport,
  idsIntersectingRect,
  nudgeBox,
  resizeBox,
  translateBoxes,
} from "../public/slide-plan-canvas.js";

const origin = Object.freeze({ x: 80, y: 72, width: 500, height: 180 });

describe("slide-plan canvas box math", () => {
  test("Given a height-constrained preview, When the canvas is fitted, Then the full 16:9 surface stays centered inside it", () => {
    const fitted = fitCanvasViewport(708, 181.5);

    expect(fitted.scale).toBeCloseTo(181.5 / 720);
    expect(fitted.left).toBeCloseTo((708 - 1280 * fitted.scale) / 2);
    expect(fitted.top).toBe(0);
    expect(1280 * fitted.scale).toBeLessThanOrEqual(708);
    expect(720 * fitted.scale).toBeLessThanOrEqual(181.5);
  });

  test("Given extra vertical space, When the canvas is fitted, Then width remains the limiting dimension", () => {
    expect(fitCanvasViewport(1280, 900)).toEqual({ scale: 1, left: 0, top: 90 });
  });

  test("Given compiled text taller than its geometry box, When it is fitted, Then the font shrinks only until the full text is visible", () => {
    const style = { fontSize: "64px" };
    const node = {
      style,
      clientWidth: 498,
      clientHeight: 178,
      scrollWidth: 498,
      get scrollHeight() {
        return Math.ceil(Number.parseFloat(style.fontSize) * 3 * 1.2 + 8);
      },
    };

    const fitted = fitCanvasText(node, 64);

    expect(fitted).toBeLessThan(64);
    expect(node.scrollHeight).toBeLessThanOrEqual(node.clientHeight);
    expect(fitted).toBeGreaterThan(10);
  });

  test("Given a compiled box, When the southeast handle moves, Then only the far edges grow", () => {
    expect(resizeBox(origin, "se", 40, 20)).toEqual({ x: 80, y: 72, width: 540, height: 200 });
  });

  test("Given a compiled box, When the northwest handle moves, Then origin and size change together", () => {
    expect(resizeBox(origin, "nw", -20, -10)).toEqual({ x: 60, y: 62, width: 520, height: 190 });
  });

  test("Given a box at the canvas edge, When resize would leave 1280x720, Then the box stays inside", () => {
    expect(resizeBox({ x: 1200, y: 680, width: 40, height: 20 }, "se", 80, 80))
      .toEqual({ x: 1200, y: 680, width: 80, height: 40 });
    expect(resizeBox({ x: 0, y: 0, width: 40, height: 20 }, "nw", -10, -10))
      .toEqual({ x: 0, y: 0, width: 40, height: 20 });
  });

  test("Given a selected box, When it is nudged, Then it moves by the step and stops at the paper edge", () => {
    expect(nudgeBox(origin, 8, 0)).toEqual({ x: 88, y: 72, width: 500, height: 180 });
    expect(nudgeBox({ x: 0, y: 0, width: 40, height: 20 }, -8, -8))
      .toEqual({ x: 0, y: 0, width: 40, height: 20 });
  });

  test("Given two selected boxes, When the group is translated, Then relative spacing is kept and the group stays on the paper", () => {
    const title = { id: "opening:title", box: { x: 80, y: 72, width: 500, height: 180 } };
    const body = { id: "opening:statement", box: { x: 80, y: 280, width: 640, height: 120 } };
    expect(translateBoxes([title, body], 40, 16)).toEqual([
      { id: "opening:title", box: { x: 120, y: 88, width: 500, height: 180 } },
      { id: "opening:statement", box: { x: 120, y: 296, width: 640, height: 120 } },
    ]);
    expect(translateBoxes([
      { id: "edge", box: { x: 1200, y: 680, width: 80, height: 40 } },
      { id: "near", box: { x: 1100, y: 600, width: 80, height: 40 } },
    ], 80, 80)).toEqual([
      { id: "edge", box: { x: 1200, y: 680, width: 80, height: 40 } },
      { id: "near", box: { x: 1100, y: 600, width: 80, height: 40 } },
    ]);
  });

  test("Given a marquee, When it covers two boxes, Then both IDs are returned and a click-sized rect returns none", () => {
    const elements = [
      { id: "opening:title", box: { x: 80, y: 72, width: 500, height: 180 } },
      { id: "opening:statement", box: { x: 80, y: 280, width: 640, height: 120 } },
    ];
    expect(idsIntersectingRect(elements, { x: 40, y: 40, width: 200, height: 400 }))
      .toEqual(["opening:title", "opening:statement"]);
    expect(idsIntersectingRect(elements, { x: 10, y: 10, width: 1, height: 1 })).toEqual([]);
    expect(idsIntersectingRect(elements, { x: 900, y: 40, width: 80, height: 40 })).toEqual([]);
  });
});
