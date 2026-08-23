import type { ResolvedAssetLayer } from "../assets/integration.ts";
import type { GeometryPreflightResult } from "../geometry/contract.ts";
import type { Theme } from "../model/plan.ts";

export type StandaloneHtmlErrorCode =
  | "STANDALONE_EMPTY_DECK"
  | "STANDALONE_INVALID_ID"
  | "STANDALONE_DUPLICATE_ID"
  | "STANDALONE_GEOMETRY_BLOCKED"
  | "STANDALONE_METADATA_MISMATCH"
  | "STANDALONE_PATH_UNRESOLVED"
  | "STANDALONE_FONT_NOT_FOUND"
  | "STANDALONE_FONT_HASH_MISMATCH"
  | "STANDALONE_ASSET_NOT_FOUND"
  | "STANDALONE_ASSET_HASH_MISMATCH"
  | "STANDALONE_MEDIA_UNSUPPORTED"
  | "STANDALONE_OUTPUT_HASH_MISMATCH";

export class StandaloneHtmlError extends TypeError {
  readonly code: StandaloneHtmlErrorCode;
  readonly path: string;

  constructor(code: StandaloneHtmlErrorCode, path: string, detail: string) {
    super(`[${code}] ${path}: ${detail}`);
    this.name = "StandaloneHtmlError";
    this.code = code;
    this.path = path;
  }
}

export interface StandaloneSlideInput {
  readonly geometry: GeometryPreflightResult;
  readonly assets: ResolvedAssetLayer;
  readonly notes?: string;
}

export interface StandaloneDeckInput {
  readonly id: string;
  readonly title: string;
  readonly lang: string;
  readonly theme: Theme;
  readonly resourceRoot: string;
  readonly slides: readonly StandaloneSlideInput[];
  readonly includeSlidesGrabDocuments?: boolean;
  readonly expectedSha256?: string;
}

export interface StandaloneSlideDocument {
  readonly filename: string;
  readonly html: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface StandaloneHtmlArtifact {
  readonly html: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly slidesGrabDocuments: readonly StandaloneSlideDocument[];
}

export function standaloneFailure(
  code: StandaloneHtmlErrorCode,
  path: string,
  detail: string,
): never {
  throw new StandaloneHtmlError(code, path, detail);
}
