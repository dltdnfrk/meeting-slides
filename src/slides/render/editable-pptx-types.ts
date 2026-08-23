import type { ResolvedAssetLayer } from "../assets/integration.ts";
import type { GeometryPreflightResult } from "../geometry/contract.ts";
import type { Theme } from "../model/plan.ts";

export type EditablePptxErrorCode =
  | "PPTX_EMPTY_DECK"
  | "PPTX_INVALID_ID"
  | "PPTX_DUPLICATE_ID"
  | "PPTX_GEOMETRY_BLOCKED"
  | "PPTX_METADATA_MISMATCH"
  | "PPTX_PATH_UNRESOLVED"
  | "PPTX_FONT_UNRESOLVED"
  | "PPTX_FONT_HASH_MISMATCH"
  | "PPTX_ASSET_MISSING"
  | "PPTX_ASSET_HASH_MISMATCH"
  | "PPTX_UNSUPPORTED_MEDIA"
  | "PPTX_INVALID_PACKAGE"
  | "PPTX_EXTERNAL_RELATIONSHIP"
  | "PPTX_DANGLING_RELATIONSHIP"
  | "PPTX_TEXT_RASTERIZED"
  | "PPTX_PARTIAL_PUBLICATION";

export class EditablePptxError extends TypeError {
  readonly code: EditablePptxErrorCode;
  readonly path: string;

  constructor(code: EditablePptxErrorCode, path: string, detail: string) {
    super(`[${code}] ${path}: ${detail}`);
    this.name = "EditablePptxError";
    this.code = code;
    this.path = path;
  }
}

export interface EditablePptxSlideInput {
  readonly geometry: GeometryPreflightResult;
  readonly assets: ResolvedAssetLayer;
  readonly notes?: string;
}

export interface EditablePptxRenderRequest {
  readonly deckId: string;
  readonly rootDirectory: string;
  readonly theme: Theme;
  readonly slides: readonly EditablePptxSlideInput[];
}

export interface EditablePptxManifestSlide {
  readonly slideId: string;
  readonly slideNumber: number;
  readonly geometryId: string;
  readonly objectIds: readonly string[];
  readonly assetIds: readonly string[];
  readonly evidenceClaimIds: readonly string[];
}

export interface EditablePptxManifestAsset {
  readonly assetId: string;
  readonly placementId: string;
  readonly slideId: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly alternativeText: string;
  readonly evidenceClaimIds: readonly string[];
}

export interface EditablePptxManifest {
  readonly schemaVersion: 1;
  readonly format: "editable-pptx";
  readonly deckId: string;
  readonly renderer: { readonly name: "pptxgenjs"; readonly version: "3.12.0" };
  readonly canvas: { readonly width: 1280; readonly height: 720; readonly layout: "LAYOUT_WIDE" };
  readonly slideIds: readonly string[];
  readonly counts: { readonly slides: number; readonly textObjects: number; readonly nativeShapes: number; readonly images: number; readonly notes: number };
  readonly slides: readonly EditablePptxManifestSlide[];
  readonly assets: readonly EditablePptxManifestAsset[];
}

export interface EditablePptxReceipt {
  readonly schemaVersion: 1;
  readonly deckId: string;
  readonly byteLength: number;
  readonly pptxSha256: string;
  readonly manifestSha256: string;
  readonly counts: EditablePptxManifest["counts"];
}

export interface EditablePptxArtifact {
  readonly bytes: Uint8Array;
  readonly manifest: EditablePptxManifest;
  readonly manifestJson: string;
  readonly receipt: EditablePptxReceipt;
  readonly receiptJson: string;
}

export interface EditablePptxPublication {
  readonly outputPath: string;
  readonly byteLength: number;
  readonly pptxSha256: string;
  readonly manifestSha256: string;
}

export function pptxFailure(code: EditablePptxErrorCode, path: string, detail: string): never {
  throw new EditablePptxError(code, path, detail);
}
