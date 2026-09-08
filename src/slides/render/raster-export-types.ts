export type RasterExportErrorCode =
  | "RASTER_INVALID_REQUEST"
  | "RASTER_IDENTITY_MISMATCH"
  | "RASTER_HTML_HASH_MISMATCH"
  | "RASTER_HTML_NETWORK_REFERENCE"
  | "RASTER_PATH_INVALID"
  | "RASTER_OUTPUT_EXISTS"
  | "RASTER_TOOL_FAILED"
  | "RASTER_TOOL_TIMEOUT"
  | "RASTER_PNG_SET_MISMATCH"
  | "RASTER_PNG_INVALID"
  | "RASTER_PUBLICATION_FAILED";

export class RasterExportError extends Error {
  readonly code: RasterExportErrorCode;
  readonly path: string;

  constructor(code: RasterExportErrorCode, path: string, detail: string) {
    super(`[${code}] ${path}: ${detail}`);
    this.name = "RasterExportError";
    this.code = code;
    this.path = path;
  }
}

export interface RasterSlideDocument {
  /** Identity-bound source name: `${slideId}.html`. */
  readonly filename: string;
  /** Optional slides-grab discovery name. It does not replace slide identity. */
  readonly renderFilename?: string;
  readonly html: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface RasterExportIdentity {
  readonly planId: string;
  readonly deckId: string;
  readonly slideIds: readonly string[];
  readonly geometryIds: readonly string[];
}

export interface RasterExportOutput {
  readonly pngDirectory: string;
  readonly pdfPath: string;
  readonly manifestPath: string;
  readonly receiptPath: string;
}

export interface RasterExportTools {
  readonly slidesGrabPath: string;
  readonly playwrightBrowsersPath: string;
  readonly sandboxExecutable: string;
  readonly sandboxProfile: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface RasterExportRequest {
  readonly identity: RasterExportIdentity;
  readonly documents: readonly RasterSlideDocument[];
  readonly output: RasterExportOutput;
  readonly tools: RasterExportTools;
  readonly timeoutMs: number;
}

export interface RasterGeometryIdentity {
  readonly source: { readonly width: 1280; readonly height: 720 };
  readonly raster: { readonly width: 1280; readonly height: 720 };
  readonly pdfPage: { readonly width: 960; readonly height: 540 };
}

export interface RasterManifestSlide {
  readonly slideId: string;
  readonly geometryId: string;
  readonly htmlName: string;
  readonly htmlSha256: string;
  readonly pngName: string;
  readonly pngByteLength: number;
  readonly pngSha256: string;
  readonly pixelSha256: string;
  readonly width: 1280;
  readonly height: 720;
}

export interface RasterExportManifest {
  readonly schemaVersion: 1;
  readonly format: "deterministic-raster";
  readonly identity: RasterExportIdentity;
  readonly geometry: RasterGeometryIdentity;
  readonly renderer: { readonly name: "slides-grab"; readonly version: "1.5.0"; readonly resolution: "720p" };
  readonly slides: readonly RasterManifestSlide[];
  readonly pdf: {
    readonly name: string;
    readonly byteLength: number;
    readonly sha256: string;
    readonly pages: number;
  };
}

export interface RasterExportReceipt {
  readonly schemaVersion: 1;
  readonly identity: RasterExportIdentity;
  readonly manifestSha256: string;
  readonly pdfSha256: string;
  readonly pngSha256: readonly string[];
}

export interface RasterExportPublication {
  readonly identity: RasterExportIdentity;
  readonly geometry: RasterGeometryIdentity;
  readonly output: RasterExportOutput;
  readonly manifest: RasterExportManifest;
  readonly manifestJson: string;
  readonly receipt: RasterExportReceipt;
  readonly receiptJson: string;
}

export function rasterFailure(code: RasterExportErrorCode, path: string, detail: string): never {
  throw new RasterExportError(code, path, detail);
}
