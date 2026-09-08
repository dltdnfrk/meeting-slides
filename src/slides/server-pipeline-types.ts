import type { AssetRecord } from "./assets/contract.ts";
import type { ResolvedAssetLayer } from "./assets/integration.ts";
import type { AssetManifest } from "./assets/manifest.ts";
import type { GeometryPreflightOptions, GeometryPreflightResult, TextFitPolicy, TextMeasurer } from "./geometry/contract.ts";
import type { LayoutDraft } from "./layouts/contract.ts";
import type { PlanAsset, SlidePlan, SnapshotIdentity, Theme } from "./model/plan.ts";
import type { SlidePlannerOptions, TranscriptSnapshot } from "./planning/planner.ts";

export const PIPELINE_PHASES = Object.freeze([
  "planning", "assets", "layouts", "geometry", "standalone", "pptx", "raster", "publication",
] as const);
export type PipelinePhase = typeof PIPELINE_PHASES[number];
export type PipelineArtifactFormat = "standalone-html" | "editable-pptx" | "raster-png-pdf";
export type SlidePlanPublicationStatus = "draft" | "final";

export interface PipelineProgressEvent {
  readonly phase: PipelinePhase;
  readonly completed: number;
  readonly total: 8;
}

export interface PipelineIdentity {
  readonly planId: string;
  readonly deckId: string;
  readonly snapshot: SnapshotIdentity;
  readonly slideIds: readonly string[];
  readonly geometryIds: readonly string[];
  readonly claimIds: readonly string[];
  readonly reviewId?: string;
  readonly reviewedItemIds?: readonly string[];
}

export interface PipelineArtifactFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

export interface PipelineArtifact {
  readonly format: PipelineArtifactFormat;
  readonly identity: PipelineIdentity;
  readonly files: readonly PipelineArtifactFile[];
}

export interface PipelinePublisherRequest {
  readonly identity: PipelineIdentity;
  readonly plan: SlidePlan;
  readonly assetManifest: AssetManifest;
  readonly drafts: readonly LayoutDraft[];
  readonly slides: readonly GeometryPreflightResult[];
  readonly assetLayers: readonly ResolvedAssetLayer[];
  readonly managedAssetRoot: string;
  readonly priorArtifacts: readonly PipelineArtifact[];
  readonly outputDirectory: string;
}

export type PipelineArtifactPublisher = (
  request: PipelinePublisherRequest,
) => Promise<PipelineArtifact>;

export interface PipelineAssetContext {
  readonly managedAssetRoot: string;
  readonly stagingDirectory: string;
  readonly theme: Theme;
}

export interface PipelineAssetPolicy {
  resolve(asset: PlanAsset, context: PipelineAssetContext): Promise<AssetRecord | undefined>;
  fallback(asset: PlanAsset, context: PipelineAssetContext): Promise<AssetRecord>;
}

export interface RunSlidePlanPipelineInput {
  readonly snapshot: TranscriptSnapshot;
  readonly planner: SlidePlannerOptions;
  readonly existingPlan?: SlidePlan;
  readonly theme: Theme;
  readonly managedAssetRoot: string;
  readonly assetPolicy: PipelineAssetPolicy;
  readonly textMeasurer: TextMeasurer;
  readonly textPolicies: Readonly<Record<string, TextFitPolicy>>;
  readonly preflight: GeometryPreflightOptions;
  readonly stagingDirectory: string;
  readonly finalDirectory: string;
  readonly confirmedReviewConfirmedAt?: number;
  readonly publishers: Readonly<{
    standalone: PipelineArtifactPublisher;
    pptx: PipelineArtifactPublisher;
    raster: PipelineArtifactPublisher;
  }>;
  readonly onProgress?: (event: PipelineProgressEvent) => void;
}

export interface PublishedArtifactFile {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface PublishedArtifact {
  readonly format: PipelineArtifactFormat;
  readonly files: readonly PublishedArtifactFile[];
}

export interface SlidePlanFinalityReceipt {
  readonly reviewId: string;
  readonly confirmedAt: number;
  readonly transcriptVersionId: string;
  readonly contentSha256: string;
  readonly reviewedItemIds: readonly string[];
}

interface SlidePlanPublicationManifestFields {
  readonly identity: PipelineIdentity;
  readonly planSha256: string;
  readonly assetManifestSha256: string;
  readonly artifacts: readonly PublishedArtifact[];
}

export type SlidePlanPublicationManifestV1 = SlidePlanPublicationManifestFields & {
  readonly schemaVersion: 1;
  readonly publicationStatus?: SlidePlanPublicationStatus;
  readonly finalityReceipt?: never;
};

export type SlidePlanPublicationManifestV2 = SlidePlanPublicationManifestFields & (
  | {
    readonly schemaVersion: 2;
    readonly publicationStatus: "draft";
    readonly finalityReceipt?: never;
  }
  | {
    readonly schemaVersion: 2;
    readonly publicationStatus: "final";
    readonly finalityReceipt: SlidePlanFinalityReceipt;
  }
);

export type SlidePlanPublicationManifest =
  | SlidePlanPublicationManifestV1
  | SlidePlanPublicationManifestV2;

export type NormalizedSlidePlanPublicationManifest = SlidePlanPublicationManifestFields & (
  | {
    readonly schemaVersion: 1;
    readonly publicationStatus: SlidePlanPublicationStatus;
    readonly finalityReceipt?: never;
  }
  | SlidePlanPublicationManifestV2
);

export type SlidePlanPublicationResult = SlidePlanPublicationManifestV2 & {
  readonly directory: string;
  readonly assetManifest: AssetManifest;
  readonly planJson: string;
  readonly manifestJson: string;
  readonly publicationSha256: string;
};
