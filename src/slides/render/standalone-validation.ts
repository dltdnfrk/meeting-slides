import type { StandaloneDeckInput } from "./standalone-types.ts";
import { standaloneFailure } from "./standalone-types.ts";

function requireId(value: string, path: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    standaloneFailure("STANDALONE_INVALID_ID", path, "ID must be a non-empty string");
  }
}

function uniqueId(value: string, path: string, seen: Set<string>): void {
  requireId(value, path);
  if (seen.has(value)) standaloneFailure("STANDALONE_DUPLICATE_ID", path, `ID '${value}' occurs more than once`);
  seen.add(value);
}

function sameCanvas(
  left: Readonly<{ width: number; height: number }>,
  right: Readonly<{ width: number; height: number }>,
): boolean {
  return left.width === right.width && left.height === right.height;
}

export function validateDeck(input: StandaloneDeckInput): void {
  requireId(input.id, "id");
  if (input.slides.length === 0) {
    standaloneFailure("STANDALONE_EMPTY_DECK", "slides", "deck must contain at least one slide");
  }

  const slideIds = new Set<string>();
  input.slides.forEach((entry, slideIndex) => {
    const root = `slides[${slideIndex}]`;
    const slide = entry.geometry.slide;
    uniqueId(slide.slideId, `${root}.geometry.slide.slideId`, slideIds);
    requireId(slide.id, `${root}.geometry.slide.id`);
    requireId(entry.assets.id, `${root}.assets.id`);

    const firstError = entry.geometry.issues.findIndex((issue) => issue.severity === "error");
    if (entry.geometry.status !== "publishable" || firstError >= 0) {
      const issueIndex = firstError >= 0 ? firstError : 0;
      const issue = entry.geometry.issues[issueIndex];
      const detail = issue === undefined ? "preflight status is blocked" : `${issue.code}: ${issue.message} (${issue.path})`;
      standaloneFailure("STANDALONE_GEOMETRY_BLOCKED", `${root}.geometry.issues[${issueIndex}]`, detail);
    }
    if (entry.assets.slideId !== slide.slideId) {
      standaloneFailure("STANDALONE_METADATA_MISMATCH", `${root}.assets.slideId`, `asset layer '${entry.assets.slideId}' does not match slide '${slide.slideId}'`);
    }
    if (!sameCanvas(slide.canvas, input.theme.canvas)) {
      standaloneFailure("STANDALONE_METADATA_MISMATCH", `${root}.geometry.slide.canvas`, "geometry canvas does not match the theme canvas");
    }
    if (!sameCanvas(entry.assets.canvas, slide.canvas)) {
      standaloneFailure("STANDALONE_METADATA_MISMATCH", `${root}.assets.canvas`, "asset layer canvas does not match geometry");
    }

    const elementIds = new Set<string>();
    slide.elements.forEach((element, elementIndex) => {
      uniqueId(element.id, `${root}.geometry.slide.elements[${elementIndex}].id`, elementIds);
      if (element.fitTrace.outcome !== "fit" || element.fitTrace.finalFontSize < element.fitTrace.fontFloor) {
        standaloneFailure("STANDALONE_GEOMETRY_BLOCKED", `${root}.geometry.slide.elements[${elementIndex}].fitTrace`, `element '${element.id}' has unresolved text geometry`);
      }
      if (element.lines.length !== element.fitTrace.lines.length ||
        element.lines.some((line, index) => line !== element.fitTrace.lines[index])) {
        standaloneFailure("STANDALONE_METADATA_MISMATCH", `${root}.geometry.slide.elements[${elementIndex}].lines`, `element '${element.id}' line breaks differ from its compiler trace`);
      }
    });

    const placementIds = new Set<string>();
    entry.assets.placements.forEach((placement, placementIndex) => {
      uniqueId(placement.id, `${root}.assets.placements[${placementIndex}].id`, placementIds);
      requireId(placement.assetId, `${root}.assets.placements[${placementIndex}].assetId`);
    });
  });
}
