import { ASSET_MEDIA_TYPES, type AssetKind, type AssetMediaType, type AssetPurpose, type AssetRecord } from "./contract.ts";
import type { AssetManifest } from "./manifest.ts";
import type { PlanAsset, PlanSlide, SlidePlan } from "../model/plan.ts";

type AssetIntegrationErrorCode =
  | "ASSET_DUPLICATE_ID"
  | "ASSET_HOTLINK"
  | "ASSET_MISSING_PLAN_RECORD"
  | "ASSET_MISSING_VERIFIED_RECORD"
  | "ASSET_METADATA_DRIFT"
  | "ASSET_UNKNOWN_CLAIM"
  | "ASSET_CLAIM_NOT_BOUND"
  | "ASSET_ACCESSIBILITY_INVALID"
  | "ASSET_PLACEMENT_UNSUPPORTED"
  | "ASSET_PLACEMENT_COLLISION";

export class AssetIntegrationError extends TypeError {
  readonly code: AssetIntegrationErrorCode;
  readonly path: string;

  constructor(code: AssetIntegrationErrorCode, path: string, detail: string) {
    super(`[${code}] ${path}: ${detail}`);
    this.name = "AssetIntegrationError";
    this.code = code;
    this.path = path;
  }
}

interface ResolvedAssetPlacement {
  readonly id: string;
  readonly assetId: string;
  readonly purpose: AssetPurpose;
  readonly kind: AssetKind;
  readonly localPath: string;
  readonly sha256: string;
  readonly mediaType: AssetMediaType;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly byteLength: number;
  readonly box: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly fit: "contain" | "cover";
  readonly accessibility: Readonly<{ role: "img" | "presentation"; label: string }>;
  readonly evidence: Readonly<{ claimIds: readonly string[] }> | null;
}

export interface ResolvedAssetLayer {
  readonly id: string;
  readonly slideId: string;
  readonly canvas: Readonly<{ width: 1280; height: 720 }>;
  readonly placements: readonly ResolvedAssetPlacement[];
}

interface Indexed<T> {
  readonly record: T;
  readonly index: number;
}

const COMPARED_FIELDS = [
  "purpose", "kind", "sha256", "mediaType", "width", "height", "byteLength",
  "altDescription", "source", "claimIds", "localPath",
] as const satisfies readonly (keyof PlanAsset & keyof AssetRecord)[];

function fail(code: AssetIntegrationErrorCode, path: string, detail: string): never {
  throw new AssetIntegrationError(code, path, detail);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function indexRecords<T extends { readonly id: string }>(
  records: readonly T[],
  root: "plan.assets" | "manifest.assets",
): Map<string, Indexed<T>> {
  const result = new Map<string, Indexed<T>>();
  records.forEach((record, index) => {
    if (result.has(record.id)) {
      fail("ASSET_DUPLICATE_ID", `${root}[${index}].id`, `asset ID '${record.id}' occurs more than once`);
    }
    result.set(record.id, { record, index });
  });
  return result;
}

function isManagedPath(record: Pick<PlanAsset, "localPath" | "sha256" | "mediaType">): boolean {
  if (/^[a-z][a-z\d+.-]*:/i.test(record.localPath)) return false;
  if (!Object.hasOwn(ASSET_MEDIA_TYPES, record.mediaType)) return false;
  const mediaType = record.mediaType as AssetMediaType;
  return record.localPath === `assets/${record.sha256}.${ASSET_MEDIA_TYPES[mediaType]}`;
}

function validateLocalPaths(records: readonly PlanAsset[], root: "plan.assets"): void;
function validateLocalPaths(records: readonly AssetRecord[], root: "manifest.assets"): void;
function validateLocalPaths(
  records: readonly Pick<PlanAsset, "id" | "localPath" | "sha256" | "mediaType">[],
  root: "plan.assets" | "manifest.assets",
): void {
  records.forEach((record, index) => {
    if (!isManagedPath(record)) {
      fail("ASSET_HOTLINK", `${root}[${index}].localPath`, `asset '${record.id}' must use its managed content-addressed local path`);
    }
  });
}

function equalMetadata(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareRecords(planAsset: PlanAsset, verified: AssetRecord, manifestIndex: number): void {
  for (const field of COMPARED_FIELDS) {
    if (!equalMetadata(planAsset[field], verified[field])) {
      fail("ASSET_METADATA_DRIFT", `manifest.assets[${manifestIndex}].${field}`, `verified metadata for asset '${planAsset.id}' differs from the plan`);
    }
  }
}

function validateAccessibility(asset: PlanAsset, planIndex: number): void {
  const root = `plan.assets[${planIndex}]`;
  if (asset.purpose === "decorative") {
    if (asset.altDescription !== "") {
      fail("ASSET_ACCESSIBILITY_INVALID", `${root}.altDescription`, `decorative asset '${asset.id}' cannot carry semantic alternative text`);
    }
    if (asset.claimIds.length !== 0) {
      fail("ASSET_ACCESSIBILITY_INVALID", `${root}.claimIds`, `decorative asset '${asset.id}' cannot carry evidence claims`);
    }
  } else {
    if (asset.altDescription.trim() === "") {
      fail("ASSET_ACCESSIBILITY_INVALID", `${root}.altDescription`, `informative asset '${asset.id}' requires semantic alternative text`);
    }
    if (asset.claimIds.length === 0) {
      fail("ASSET_ACCESSIBILITY_INVALID", `${root}.claimIds`, `informative asset '${asset.id}' requires evidence claims`);
    }
  }
}

function placementSpec(slide: PlanSlide, kind: AssetKind, path: string): {
  readonly box: { x: number; y: number; width: number; height: number };
  readonly fit: "contain" | "cover";
} {
  if (slide.layout === "hero" && kind === "image") {
    return { box: { x: 704, y: 0, width: 576, height: 720 }, fit: "cover" };
  }
  if (slide.layout === "summary" && (kind === "icon" || kind === "diagram")) {
    return { box: { x: 880, y: 160, width: 240, height: 240 }, fit: "contain" };
  }
  if (slide.layout === "metrics" && slide.payload.mode === "chart" && kind === "chart") {
    return { box: { x: 480, y: 152, width: 720, height: 480 }, fit: "contain" };
  }
  const variant = slide.layout === "metrics" ? ` (${slide.payload.mode})` : "";
  fail("ASSET_PLACEMENT_UNSUPPORTED", path, `${slide.layout}${variant} does not support ${kind} asset placement`);
}

export function resolveSlideAssets(
  plan: SlidePlan,
  manifest: AssetManifest,
  slide: PlanSlide,
): ResolvedAssetLayer {
  const slideIndex = plan.slides.findIndex((entry) => entry.id === slide.id);
  const slideRoot = slideIndex < 0 ? "slides" : `slides[${slideIndex}]`;
  const planById = indexRecords(plan.assets, "plan.assets");
  const manifestById = indexRecords(manifest.assets, "manifest.assets");
  validateLocalPaths(plan.assets, "plan.assets");
  validateLocalPaths(manifest.assets, "manifest.assets");

  if (slide.assetIds.length > 1) {
    fail(
      "ASSET_PLACEMENT_COLLISION",
      `${slideRoot}.assetIds[1]`,
      `single asset slot collision between '${slide.assetIds[0]}' and '${slide.assetIds[1]}'`,
    );
  }

  const knownClaims = new Set(plan.claims.map((claim) => claim.id));
  const boundClaims = new Set(Object.values(slide.bindings).flat());
  const placements = slide.assetIds.map((assetId, assetIndex): ResolvedAssetPlacement => {
    const referencePath = `${slideRoot}.assetIds[${assetIndex}]`;
    const planned = planById.get(assetId);
    if (planned === undefined) fail("ASSET_MISSING_PLAN_RECORD", referencePath, `asset '${assetId}' is absent from plan.assets`);
    const verified = manifestById.get(assetId);
    if (verified === undefined) fail("ASSET_MISSING_VERIFIED_RECORD", referencePath, `asset '${assetId}' is absent from the verified manifest`);

    validateAccessibility(planned.record, planned.index);
    compareRecords(planned.record, verified.record, verified.index);
    for (let claimIndex = 0; claimIndex < planned.record.claimIds.length; claimIndex += 1) {
      const claimId = planned.record.claimIds[claimIndex]!;
      if (!knownClaims.has(claimId)) {
        fail("ASSET_UNKNOWN_CLAIM", `plan.assets[${planned.index}].claimIds[${claimIndex}]`, `asset '${assetId}' references unknown claim '${claimId}'`);
      }
      if (!boundClaims.has(claimId)) {
        fail("ASSET_CLAIM_NOT_BOUND", referencePath, `claim '${claimId}' for asset '${assetId}' is not bound on slide '${slide.id}'`);
      }
    }

    const spec = placementSpec(slide, verified.record.kind, referencePath);
    const informative = verified.record.purpose === "informative";
    return {
      id: `${slide.id}:asset:${assetId}`,
      assetId,
      purpose: verified.record.purpose,
      kind: verified.record.kind,
      localPath: verified.record.localPath,
      sha256: verified.record.sha256,
      mediaType: verified.record.mediaType,
      sourceWidth: verified.record.width,
      sourceHeight: verified.record.height,
      byteLength: verified.record.byteLength,
      box: spec.box,
      fit: spec.fit,
      accessibility: informative
        ? { role: "img", label: planned.record.altDescription }
        : { role: "presentation", label: "" },
      evidence: informative ? { claimIds: [...planned.record.claimIds] } : null,
    };
  });

  return deepFreeze({
    id: `${slide.id}:assets`,
    slideId: slide.id,
    canvas: { width: 1280 as const, height: 720 as const },
    placements,
  });
}
