import { deepFreeze } from "../theme/immutable.ts";
import type {
  AllowedOverlap,
  CompileIssue,
  GeometryCompileResult,
  GeometryElement,
  GeometryPreflightOptions,
  GeometryPreflightResult,
} from "./contract.ts";

function boundaryPath(
  element: GeometryElement,
  canvas: { readonly width: number; readonly height: number },
  index: number,
): string | null {
  if (element.box.x < 0) return `elements[${index}].box.x`;
  if (element.box.y < 0) return `elements[${index}].box.y`;
  if (element.box.width <= 0) return `elements[${index}].box.width`;
  if (element.box.height <= 0) return `elements[${index}].box.height`;
  if (element.box.x + element.box.width > canvas.width) return `elements[${index}].box.width`;
  if (element.box.y + element.box.height > canvas.height) return `elements[${index}].box.height`;
  return null;
}

function intersects(left: GeometryElement, right: GeometryElement): boolean {
  return left.box.x < right.box.x + right.box.width &&
    right.box.x < left.box.x + left.box.width &&
    left.box.y < right.box.y + right.box.height &&
    right.box.y < left.box.y + left.box.height;
}

function samePair(pair: readonly string[], left: string, right: string): boolean {
  return pair.length === 2 &&
    ((pair[0] === left && pair[1] === right) || (pair[0] === right && pair[1] === left));
}

function permitsDecorativeOverlap(
  allowed: readonly AllowedOverlap[],
  left: GeometryElement,
  right: GeometryElement,
): boolean {
  const decorative = left.role === "decoration" || right.role === "decoration" ||
    left.accessibility.role === "presentation" || right.accessibility.role === "presentation";
  return decorative && allowed.some((entry) =>
    entry.purpose === "decorative" && samePair(entry.elementIds, left.id, right.id));
}

export function preflightGeometrySlide(
  compiled: GeometryCompileResult,
  options: GeometryPreflightOptions = {},
): GeometryPreflightResult {
  const issues: CompileIssue[] = [...compiled.issues];
  const elements = compiled.slide.elements;

  for (const [index, element] of elements.entries()) {
    const path = boundaryPath(element, compiled.slide.canvas, index);
    if (path !== null) {
      issues.push({
        code: "box-out-of-bounds",
        severity: "error",
        path,
        elementIds: [element.id],
        message: "element box must remain within the 1280x720 canvas",
      });
    }
  }

  const allowed = options.allowedOverlaps ?? [];
  for (let leftIndex = 0; leftIndex < elements.length; leftIndex += 1) {
    const left = elements[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < elements.length; rightIndex += 1) {
      const right = elements[rightIndex]!;
      if (!intersects(left, right) || permitsDecorativeOverlap(allowed, left, right)) continue;
      issues.push({
        code: "undeclared-intersection",
        severity: "error",
        path: `elements[${leftIndex}].box`,
        elementIds: [left.id, right.id],
        message: "intersecting element boxes require an explicit decorative overlap declaration",
      });
    }
  }

  return deepFreeze({
    slide: compiled.slide,
    issues,
    status: issues.some((entry) => entry.severity === "error") ? "blocked" : "publishable",
  });
}
