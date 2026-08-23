import PptxGenJS from "pptxgenjs";

import type { GeometryElement } from "../geometry/contract.ts";
import type { Theme } from "../model/plan.ts";
import type {
  EditablePptxManifest,
  EditablePptxManifestAsset,
  EditablePptxManifestSlide,
} from "./editable-pptx-types.ts";
import type { VerifiedEditablePptxRequest, VerifiedPlacement } from "./editable-pptx-validation.ts";

const INCHES_PER_PIXEL_X = 13.3333333333 / 1280;
const INCHES_PER_PIXEL_Y = 7.5 / 720;

function inches(box: Readonly<{ x: number; y: number; width: number; height: number }>): { x: number; y: number; w: number; h: number } {
  return {
    x: box.x * INCHES_PER_PIXEL_X,
    y: box.y * INCHES_PER_PIXEL_Y,
    w: box.width * INCHES_PER_PIXEL_X,
    h: box.height * INCHES_PER_PIXEL_Y,
  };
}

function resolvedString(element: GeometryElement, key: string, fallback: string): string {
  const value = element.resolvedTokens[key];
  return typeof value === "string" && value !== "" ? value : fallback;
}

function weight(element: GeometryElement, theme: Theme): number {
  const value = element.resolvedTokens.weight;
  if (typeof value === "number") return value;
  if (element.role === "title") return theme.typography.heading.weight;
  return theme.typography.body.weight;
}

function addText(slide: PptxGenJS.Slide, element: GeometryElement, theme: Theme): void {
  const lines = element.lines.length > 0 ? element.lines : [element.text];
  const runs: PptxGenJS.TextProps[] = lines.map((line, index) => ({
    text: line,
    options: { breakLine: index < lines.length - 1 },
  }));
  slide.addText(runs, {
    ...inches(element.box),
    objectName: element.id,
    fontFace: resolvedString(element, "font", theme.font.family),
    fontSize: element.fitTrace.finalFontSize,
    color: resolvedString(element, "color", theme.colors.ink),
    bold: weight(element, theme) >= 600,
    margin: 0,
    breakLine: false,
    fit: "none",
    wrap: true,
    valign: "top",
    line: { color: resolvedString(element, "color", theme.colors.ink), transparency: 100 },
    fill: { color: theme.colors.paper, transparency: 100 },
  });
}

function addDecoration(slide: PptxGenJS.Slide, element: GeometryElement, theme: Theme): void {
  slide.addShape("rect", {
    ...inches(element.box),
    objectName: element.id,
    fill: { color: resolvedString(element, "color", theme.colors.coral) },
    line: { color: resolvedString(element, "color", theme.colors.coral), transparency: 100 },
  });
}

function addImage(slide: PptxGenJS.Slide, verified: VerifiedPlacement): void {
  const box = inches(verified.placement.box);
  slide.addImage({
    data: `data:${verified.placement.mediaType};base64,${Buffer.from(verified.bytes).toString("base64")}`,
    ...box,
    objectName: verified.placement.id,
    altText: verified.placement.accessibility.label,
    sizing: { type: verified.placement.fit, x: box.x, y: box.y, w: box.w, h: box.h },
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function notesFor(verified: VerifiedEditablePptxRequest, slideIndex: number): string {
  const entry = verified.request.slides[slideIndex]!;
  const lines = [`slide-id=${entry.geometry.slide.slideId}`, `geometry-id=${entry.geometry.slide.id}`];
  for (const element of entry.geometry.slide.elements) {
    lines.push(`element-id=${element.id}`);
    if (element.evidence !== null) {
      lines.push(`field-path=${element.evidence.fieldPath}`);
      for (const claimId of element.evidence.claimIds) lines.push(`claim-id=${claimId}`);
    }
  }
  for (const placement of entry.assets.placements) {
    lines.push(`asset-id=${placement.assetId}`, `placement-id=${placement.id}`);
    for (const claimId of placement.evidence?.claimIds ?? []) lines.push(`claim-id=${claimId}`);
  }
  if (entry.notes?.trim()) lines.push("speaker-notes=", entry.notes);
  return `${lines.join("\n")}\n`;
}

function manifestFor(verified: VerifiedEditablePptxRequest): EditablePptxManifest {
  const slides: EditablePptxManifestSlide[] = [];
  const assets: EditablePptxManifestAsset[] = [];
  let textObjects = 0;
  let nativeShapes = 0;
  verified.request.slides.forEach((entry, slideIndex) => {
    const elements = entry.geometry.slide.elements;
    textObjects += elements.filter((element) => element.lines.length > 0 || element.text !== "").length;
    nativeShapes += elements.filter((element) => element.lines.length === 0 && element.text === "").length;
    const placements = verified.slides[slideIndex]!.placements;
    const claims = unique([
      ...elements.flatMap((element) => element.evidence?.claimIds ?? []),
      ...entry.assets.placements.flatMap((placement) => placement.evidence?.claimIds ?? []),
    ]);
    slides.push({
      slideId: entry.geometry.slide.slideId,
      slideNumber: slideIndex + 1,
      geometryId: entry.geometry.slide.id,
      objectIds: [...elements.map((element) => element.id), ...placements.map(({ placement }) => placement.id)],
      assetIds: placements.map(({ placement }) => placement.assetId),
      evidenceClaimIds: claims,
    });
    for (const { placement, bytes } of placements) assets.push({
      assetId: placement.assetId,
      placementId: placement.id,
      slideId: entry.geometry.slide.slideId,
      mediaType: placement.mediaType,
      byteLength: bytes.byteLength,
      sha256: placement.sha256.toLowerCase(),
      alternativeText: placement.accessibility.label,
      evidenceClaimIds: [...(placement.evidence?.claimIds ?? [])],
    });
  });
  return {
    schemaVersion: 1,
    format: "editable-pptx",
    deckId: verified.request.deckId,
    renderer: { name: "pptxgenjs", version: "3.12.0" },
    canvas: { width: 1280, height: 720, layout: "LAYOUT_WIDE" },
    slideIds: slides.map((slide) => slide.slideId),
    counts: { slides: slides.length, textObjects, nativeShapes, images: assets.length, notes: slides.length },
    slides,
    assets,
  };
}

export async function buildEditablePptx(verified: VerifiedEditablePptxRequest): Promise<{ readonly bytes: Uint8Array; readonly manifest: EditablePptxManifest }> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "MUNI";
  pptx.company = "MUNI";
  pptx.subject = "Editable meeting presentation";
  pptx.title = verified.request.deckId;
  pptx.revision = "1";
  pptx.theme = { headFontFace: verified.request.theme.font.family, bodyFontFace: verified.request.theme.font.family };

  verified.request.slides.forEach((entry, slideIndex) => {
    const slide = pptx.addSlide();
    slide.background = { color: verified.request.theme.colors.paper };
    for (const element of entry.geometry.slide.elements) {
      if (element.lines.length > 0 || element.text !== "") addText(slide, element, verified.request.theme);
      else addDecoration(slide, element, verified.request.theme);
    }
    for (const placement of verified.slides[slideIndex]!.placements) addImage(slide, placement);
    slide.addNotes(notesFor(verified, slideIndex));
  });

  const output = await pptx.write({ outputType: "uint8array", compression: false });
  if (!(output instanceof Uint8Array)) throw new TypeError("pptxgenjs returned a non-byte output");
  return { bytes: output, manifest: manifestFor(verified) };
}
