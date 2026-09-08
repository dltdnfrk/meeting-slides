import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { pngPixelBytes } from "./screenshot-qa-browser.ts";
import {
  rasterFailure,
  type RasterExportRequest,
  type RasterSlideDocument,
} from "./raster-export-types.ts";

export const RASTER_GEOMETRY = Object.freeze({
  source: Object.freeze({ width: 1280 as const, height: 720 as const }),
  raster: Object.freeze({ width: 1280 as const, height: 720 as const }),
  pdfPage: Object.freeze({ width: 960 as const, height: 540 as const }),
});

export function rasterSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    rasterFailure("RASTER_INVALID_REQUEST", path, "must be a non-empty stable ID");
  }
}

function regularFile(path: string, field: string): void {
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) {
    rasterFailure("RASTER_PATH_INVALID", field, "must resolve to an existing absolute file");
  }
}

export interface VerifiedRasterRequest extends RasterExportRequest {
  readonly publicationRoot: string;
}

export function rasterRenderFilename(document: RasterSlideDocument, index: number): string {
  if (document.renderFilename !== undefined) return document.renderFilename;
  if (document.filename.startsWith("slide-")) return document.filename;
  return `slide-${String(index + 1).padStart(2, "0")}.html`;
}

export function validateRasterRequest(request: RasterExportRequest): VerifiedRasterRequest {
  if (typeof request !== "object" || request === null) {
    rasterFailure("RASTER_INVALID_REQUEST", "request", "must be an object");
  }
  stableId(request.identity?.planId, "identity.planId");
  stableId(request.identity?.deckId, "identity.deckId");
  if (!Array.isArray(request.documents) || request.documents.length === 0) {
    rasterFailure("RASTER_INVALID_REQUEST", "documents", "must contain at least one verified slide document");
  }
  if (request.identity.slideIds.length !== request.documents.length ||
      request.identity.geometryIds.length !== request.documents.length) {
    rasterFailure("RASTER_IDENTITY_MISMATCH", "identity", "slide and geometry identity counts must match documents");
  }

  const seen = new Set<string>();
  const renderNames = new Set<string>();
  for (const [index, document] of request.documents.entries()) {
    const slideId = request.identity.slideIds[index];
    const geometryId = request.identity.geometryIds[index];
    stableId(slideId, `identity.slideIds[${index}]`);
    stableId(geometryId, `identity.geometryIds[${index}]`);
    if (seen.has(slideId)) rasterFailure("RASTER_IDENTITY_MISMATCH", `identity.slideIds[${index}]`, `duplicate slide ID '${slideId}'`);
    seen.add(slideId);
    if (document.filename !== `${slideId}.html`) {
      rasterFailure("RASTER_IDENTITY_MISMATCH", `documents[${index}].filename`, "must be the matching slide ID plus .html");
    }
    const renderFilename = rasterRenderFilename(document, index);
    if (!/^slide-[A-Za-z0-9][A-Za-z0-9._-]*\.html$/.test(renderFilename)) {
      rasterFailure(
        "RASTER_INVALID_REQUEST",
        `documents[${index}].renderFilename`,
        "must be a slides-grab-discoverable slide-*.html name",
      );
    }
    if (renderNames.has(renderFilename)) {
      rasterFailure(
        "RASTER_IDENTITY_MISMATCH",
        `documents[${index}].renderFilename`,
        `duplicate render filename '${renderFilename}'`,
      );
    }
    renderNames.add(renderFilename);
    const encoded = new TextEncoder().encode(document.html);
    if (!Buffer.from(document.bytes).equals(Buffer.from(encoded))) {
      rasterFailure("RASTER_HTML_HASH_MISMATCH", `documents[${index}].bytes`, "bytes do not exactly encode html as UTF-8");
    }
    const actualHash = rasterSha256(document.bytes);
    if (document.sha256 !== actualHash) {
      rasterFailure("RASTER_HTML_HASH_MISMATCH", `documents[${index}].sha256`, `expected ${actualHash}, received ${document.sha256}`);
    }
    if (/(?:https?|ftp):\/\//i.test(document.html)) {
      rasterFailure("RASTER_HTML_NETWORK_REFERENCE", `documents[${index}].html`, "external network references are forbidden");
    }
  }

  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 300_000) {
    rasterFailure("RASTER_INVALID_REQUEST", "timeoutMs", "must be an integer from 1 through 300000");
  }
  regularFile(request.tools.slidesGrabPath, "tools.slidesGrabPath");
  regularFile(request.tools.sandboxExecutable, "tools.sandboxExecutable");
  if (request.tools.playwrightBrowsersPath === "" || !isAbsolute(request.tools.playwrightBrowsersPath) ||
      !existsSync(request.tools.playwrightBrowsersPath) || !statSync(request.tools.playwrightBrowsersPath).isDirectory()) {
    rasterFailure("RASTER_PATH_INVALID", "tools.playwrightBrowsersPath", "must resolve to the supplied installed browser directory");
  }
  if (typeof request.tools.sandboxProfile !== "string" || !/deny\s+network\*/.test(request.tools.sandboxProfile)) {
    rasterFailure("RASTER_INVALID_REQUEST", "tools.sandboxProfile", "must explicitly deny network access");
  }

  const outputPaths = [request.output.pngDirectory, request.output.pdfPath, request.output.manifestPath, request.output.receiptPath];
  if (outputPaths.some((path) => !isAbsolute(path))) {
    rasterFailure("RASTER_PATH_INVALID", "output", "all output paths must be absolute");
  }
  const publicationRoot = dirname(request.output.pdfPath);
  if (dirname(request.output.pngDirectory) !== publicationRoot || dirname(request.output.manifestPath) !== publicationRoot ||
      dirname(request.output.receiptPath) !== publicationRoot) {
    rasterFailure("RASTER_PATH_INVALID", "output", "PNG, PDF, manifest, and receipt must share one atomic publication directory");
  }
  const names = outputPaths.map((path) => basename(path));
  if (new Set(names).size !== names.length || names.some((name) => name === "." || name === ".." || name === "")) {
    rasterFailure("RASTER_PATH_INVALID", "output", "artifact names must be distinct and resolved");
  }
  if (existsSync(publicationRoot)) {
    rasterFailure("RASTER_OUTPUT_EXISTS", "output", `atomic publication directory already exists: ${publicationRoot}`);
  }

  // Resolve tool paths after validating them so symlinked installed binaries remain accepted.
  realpathSync(request.tools.slidesGrabPath);
  return { ...request, publicationRoot: resolve(publicationRoot) };
}

export function validatePng(bytes: Uint8Array, path: string): { width: 1280; height: 720; pixelSha256: string } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.byteLength < 33 || !Buffer.from(bytes.subarray(0, 8)).equals(signature)) {
    rasterFailure("RASTER_PNG_INVALID", path, "missing PNG signature or IHDR");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  if (width !== 1280 || height !== 720) {
    rasterFailure("RASTER_PNG_INVALID", path, `expected 1280x720, received ${width}x${height}`);
  }
  if (bitDepth !== 8 || colorType !== 2) {
    rasterFailure("RASTER_PNG_INVALID", path, `expected deterministic 8-bit RGB PNG, received depth ${bitDepth}, color type ${colorType}`);
  }
  return { width: 1280, height: 720, pixelSha256: rasterSha256(pngPixelBytes(bytes)) };
}
