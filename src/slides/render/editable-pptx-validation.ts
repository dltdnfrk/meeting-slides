import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ResolvedAssetLayer } from "../assets/integration.ts";
import type { EditablePptxRenderRequest } from "./editable-pptx-types.ts";
import { pptxFailure } from "./editable-pptx-types.ts";

const IMAGE_MEDIA = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);

export interface VerifiedPlacement {
  readonly placement: ResolvedAssetLayer["placements"][number];
  readonly bytes: Uint8Array;
}

export interface VerifiedEditablePptxRequest {
  readonly request: EditablePptxRenderRequest;
  readonly slides: readonly { readonly placements: readonly VerifiedPlacement[] }[];
}

export function pptxSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireId(value: string, path: string, seen?: Set<string>): void {
  if (typeof value !== "string" || value.trim() === "") {
    pptxFailure("PPTX_INVALID_ID", path, "ID must be a non-empty string");
  }
  if (seen?.has(value)) pptxFailure("PPTX_DUPLICATE_ID", path, `ID '${value}' occurs more than once`);
  seen?.add(value);
}

function localFile(root: string, localPath: string, path: string, missing: "PPTX_FONT_UNRESOLVED" | "PPTX_ASSET_MISSING"): Uint8Array {
  const unsafe = localPath.trim() === "" || isAbsolute(localPath) || localPath.includes("\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(localPath) || localPath.split("/").some((part) => part === "" || part === "." || part === "..");
  if (unsafe) pptxFailure("PPTX_PATH_UNRESOLVED", path, "path must be relative and contained by rootDirectory");

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    pptxFailure("PPTX_PATH_UNRESOLVED", "rootDirectory", `root directory '${root}' cannot be resolved`);
  }
  const candidate = resolve(canonicalRoot, localPath);
  const lexical = relative(canonicalRoot, candidate);
  if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    pptxFailure("PPTX_PATH_UNRESOLVED", path, "path escapes rootDirectory");
  }
  if (!existsSync(candidate)) pptxFailure(missing, path, `local file '${localPath}' does not exist`);

  let canonicalFile: string;
  try {
    canonicalFile = realpathSync(candidate);
  } catch {
    pptxFailure(missing, path, `local file '${localPath}' cannot be resolved`);
  }
  const physical = relative(canonicalRoot, canonicalFile);
  if (physical === ".." || physical.startsWith(`..${sep}`) || isAbsolute(physical)) {
    pptxFailure("PPTX_PATH_UNRESOLVED", path, "path resolves outside rootDirectory");
  }
  return readFileSync(canonicalFile);
}

function sameCanvas(left: Readonly<{ width: number; height: number }>, right: Readonly<{ width: number; height: number }>): boolean {
  return left.width === right.width && left.height === right.height;
}

function validBox(box: Readonly<{ x: number; y: number; width: number; height: number }>): boolean {
  return [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.x >= 0 && box.y >= 0 &&
    box.width > 0 && box.height > 0 && box.x + box.width <= 1280 && box.y + box.height <= 720;
}

export function validateEditablePptxRequest(request: EditablePptxRenderRequest): VerifiedEditablePptxRequest {
  requireId(request.deckId, "deckId");
  if (request.slides.length === 0) pptxFailure("PPTX_EMPTY_DECK", "slides", "deck must contain at least one slide");
  if (request.theme.canvas.width !== 1280 || request.theme.canvas.height !== 720) {
    pptxFailure("PPTX_METADATA_MISMATCH", "theme.canvas", "editable PPTX requires the 1280x720 design canvas");
  }

  const font = localFile(request.rootDirectory, request.theme.font.localPath, "theme.font.localPath", "PPTX_FONT_UNRESOLVED");
  if (pptxSha256(font) !== request.theme.font.sha256.toLowerCase()) {
    pptxFailure("PPTX_FONT_HASH_MISMATCH", "theme.font.sha256", "local font bytes differ from the declared sha-256");
  }

  const slideIds = new Set<string>();
  const geometryIds = new Set<string>();
  const objectIds = new Set<string>();
  return {
    request,
    slides: request.slides.map((entry, slideIndex) => {
      const root = `slides[${slideIndex}]`;
      const geometry = entry.geometry;
      const slide = geometry.slide;
      requireId(slide.slideId, `${root}.geometry.slide.slideId`, slideIds);
      requireId(slide.id, `${root}.geometry.slide.id`, geometryIds);
      if (geometry.status !== "publishable" || geometry.issues.some((issue) => issue.severity === "error")) {
        pptxFailure("PPTX_GEOMETRY_BLOCKED", `${root}.geometry`, "geometry preflight is not publishable");
      }
      if (!sameCanvas(slide.canvas, request.theme.canvas) || !sameCanvas(entry.assets.canvas, slide.canvas) || entry.assets.slideId !== slide.slideId) {
        pptxFailure("PPTX_METADATA_MISMATCH", `${root}.assets`, "slide, asset, and theme metadata do not agree");
      }
      slide.elements.forEach((element, elementIndex) => {
        const path = `${root}.geometry.slide.elements[${elementIndex}]`;
        requireId(element.id, `${path}.id`, objectIds);
        const meaningfulText = element.lines.length > 0 || element.text !== "";
        if (!validBox(element.box) || (meaningfulText && (element.fitTrace.outcome !== "fit" || element.fitTrace.finalFontSize < element.fitTrace.fontFloor))) {
          pptxFailure("PPTX_GEOMETRY_BLOCKED", path, `element '${element.id}' has unresolved geometry`);
        }
        if (element.lines.length !== element.fitTrace.lines.length || element.lines.some((line, index) => line !== element.fitTrace.lines[index])) {
          pptxFailure("PPTX_METADATA_MISMATCH", `${path}.lines`, "compiler-resolved line breaks do not match fit trace");
        }
      });

      return {
        placements: entry.assets.placements.map((placement, placementIndex): VerifiedPlacement => {
          const path = `${root}.assets.placements[${placementIndex}]`;
          requireId(placement.id, `${path}.id`, objectIds);
          requireId(placement.assetId, `${path}.assetId`);
          if (!validBox(placement.box)) pptxFailure("PPTX_METADATA_MISMATCH", `${path}.box`, "asset box is outside the design canvas");
          if (!IMAGE_MEDIA.has(placement.mediaType)) {
            pptxFailure("PPTX_UNSUPPORTED_MEDIA", `${path}.mediaType`, `media type '${placement.mediaType}' is not an editable PPTX image`);
          }
          const bytes = localFile(request.rootDirectory, placement.localPath, `${path}.localPath`, "PPTX_ASSET_MISSING");
          if (pptxSha256(bytes) !== placement.sha256.toLowerCase() || bytes.byteLength !== placement.byteLength) {
            pptxFailure("PPTX_ASSET_HASH_MISMATCH", `${path}.sha256`, `asset '${placement.assetId}' bytes do not match verified metadata`);
          }
          return { placement, bytes };
        }),
      };
    }),
  };
}
