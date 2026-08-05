import PptxGenJS from "pptxgenjs";

import type { SceneDeck, SceneShapeElement, SceneTextElement } from "./scene-graph.js";

const WIDTH_INCHES = 13.333;
const HEIGHT_INCHES = 7.5;

function x(value: number): number {
  return value / 100 * WIDTH_INCHES;
}

function y(value: number): number {
  return value / 56.25 * HEIGHT_INCHES;
}

function addText(slide: PptxGenJS.Slide, element: SceneTextElement): void {
  slide.addText(element.text, {
    x: x(element.x),
    y: y(element.y),
    w: x(element.w),
    h: y(element.h),
    fontFace: "Apple SD Gothic Neo",
    fontSize: element.fontSize,
    color: element.color,
    bold: element.weight === "bold" || element.weight === "semibold",
    align: element.align,
    valign: "middle",
    margin: 0,
    breakLine: false,
    fit: "shrink",
  });
}

function addShape(pptx: PptxGenJS, slide: PptxGenJS.Slide, element: SceneShapeElement): void {
  const kind = element.shape === "ellipse"
    ? pptx.ShapeType.ellipse
    : element.shape === "line"
      ? pptx.ShapeType.line
      : pptx.ShapeType.rect;
  slide.addShape(kind, {
    x: x(element.x),
    y: y(element.y),
    w: x(element.w),
    h: element.shape === "line" ? 0 : y(element.h),
    ...(element.fill ? { fill: { color: element.fill } } : { fill: { color: "FFFFFF", transparency: 100 } }),
    ...(element.stroke ? { line: { color: element.stroke, width: element.strokeWidth ?? 1 } } : { line: { color: "FFFFFF", transparency: 100 } }),
  });
}

export async function writeSceneDeckPptx(deck: SceneDeck, outputPath: string): Promise<void> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Meeting Slides";
  pptx.company = "Meeting Slides";
  pptx.subject = "Editable meeting presentation";
  pptx.title = deck.title;
  pptx.theme = {
    headFontFace: "Apple SD Gothic Neo",
    bodyFontFace: "Apple SD Gothic Neo",
  };

  for (const scene of deck.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: scene.background };
    for (const element of scene.elements) {
      if (element.type === "text") addText(slide, element);
      else addShape(pptx, slide, element);
    }
    if (scene.notes) slide.addNotes(scene.notes);
  }

  await pptx.writeFile({ fileName: outputPath, compression: true });
}
