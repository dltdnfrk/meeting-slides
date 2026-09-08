import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveSlideAssets, type ResolvedAssetLayer } from "./assets/integration.ts";
import { preparePlanSlideGeometry } from "./geometry/plan-geometry.ts";
import { preflightGeometrySlide } from "./geometry/preflight.ts";
import type { SlidePlan, SnapshotIdentity } from "./model/plan.ts";
import { parseSlidePlan } from "./model/plan-parser.ts";
import {
  planTranscriptToSlides,
  validateSlidePlanAgainstSnapshot,
} from "./planning/planner.ts";
import { resolvePipelineAssets } from "./server-pipeline-assets.ts";
import {
  cleanPipelineStaging, publishPipelineResult, stageArtifact, validateOutputDirectories,
} from "./server-pipeline-publication.ts";
import {
  PIPELINE_PHASES,
  type PipelineArtifact,
  type PipelineArtifactFormat,
  type PipelineIdentity,
  type PipelineProgressEvent,
  type PublishedArtifact,
  type SlidePlanFinalityReceipt,
  type RunSlidePlanPipelineInput,
  type SlidePlanPublicationResult,
} from "./server-pipeline-types.ts";

export type {
  PipelineArtifact, PipelineArtifactFile, PipelineArtifactFormat, PipelineArtifactPublisher,
  PipelineAssetContext, PipelineAssetPolicy, PipelineIdentity, PipelineProgressEvent,
  PipelinePublisherRequest, PublishedArtifact, PublishedArtifactFile,
  RunSlidePlanPipelineInput, SlidePlanFinalityReceipt, SlidePlanPublicationManifest,
  SlidePlanPublicationResult,
} from "./server-pipeline-types.ts";
export { PipelineAssetError } from "./server-pipeline-assets.ts";

export class SlidePlanPipelineError extends Error {
  constructor(readonly phase: (typeof PIPELINE_PHASES)[number], detail: string) {
    super(`[SLIDE_PIPELINE_BLOCKED] ${phase}: ${detail}`);
    this.name = "SlidePlanPipelineError";
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotIdentity(plan: SlidePlan): SnapshotIdentity {
  return deepFreeze({ ...plan.snapshot });
}

function identityFor(
  plan: SlidePlan,
  geometryIds: readonly string[],
  snapshot: RunSlidePlanPipelineInput["snapshot"],
): PipelineIdentity {
  const review = snapshot.confirmedReview;
  return deepFreeze({
    planId: plan.planId,
    deckId: `${plan.planId}:deck`,
    snapshot: snapshotIdentity(plan),
    slideIds: plan.slides.map((slide) => slide.id),
    geometryIds: [...geometryIds],
    claimIds: plan.claims.map((claim) => claim.id),
    ...(review === undefined ? {} : {
      reviewId: review.reviewId,
      reviewedItemIds: review.items.map((item) => item.id).sort(),
    }),
  });
}

function reviewConfirmedAt(input: RunSlidePlanPipelineInput): number | undefined {
  if (input.snapshot.confirmedReview === undefined) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(input.snapshot.confirmedReview, "confirmedAt");
  const value = input.confirmedReviewConfirmedAt ?? descriptor?.value;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SlidePlanPipelineError("publication", "confirmed Review evidence is missing confirmedAt");
  }
  return value;
}

function finalityReceiptFor(
  identity: PipelineIdentity,
  confirmedAt: number | undefined,
): SlidePlanFinalityReceipt | undefined {
  if (identity.reviewId === undefined || identity.reviewedItemIds === undefined) return undefined;
  if (confirmedAt === undefined) throw new SlidePlanPipelineError("publication", "final publication is missing confirmedAt");
  return Object.freeze({
    reviewId: identity.reviewId,
    confirmedAt,
    transcriptVersionId: identity.snapshot.transcriptVersionId,
    contentSha256: identity.snapshot.contentSha256,
    reviewedItemIds: identity.reviewedItemIds,
  });
}

function assertTheme(plan: SlidePlan, input: RunSlidePlanPipelineInput): void {
  if (JSON.stringify(plan.theme) !== JSON.stringify(input.theme)) {
    throw new SlidePlanPipelineError("planning", "planner theme does not match the explicit server theme");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function emit(input: RunSlidePlanPipelineInput, completed: number): void {
  const event: PipelineProgressEvent = Object.freeze({
    phase: PIPELINE_PHASES[completed - 1]!, completed, total: 8 as const,
  });
  input.onProgress?.(event);
}

async function invokePublisher(
  format: PipelineArtifactFormat,
  publisher: RunSlidePlanPipelineInput["publishers"]["standalone"],
  request: Parameters<RunSlidePlanPipelineInput["publishers"]["standalone"]>[0],
  stagingDirectory: string,
  occupied: Set<string>,
): Promise<{ artifact: PipelineArtifact; published: PublishedArtifact }> {
  const artifact = await publisher(request);
  const published = await stageArtifact(artifact, format, request.identity, stagingDirectory, occupied);
  await cleanPipelineStaging(request.outputDirectory);
  return { artifact, published };
}

export async function runSlidePlanPipeline(
  input: RunSlidePlanPipelineInput,
): Promise<SlidePlanPublicationResult> {
  validateOutputDirectories(input.stagingDirectory, input.finalDirectory);
  const stagingDirectory = resolve(input.stagingDirectory);
  const finalDirectory = resolve(input.finalDirectory);
  if (await pathExists(finalDirectory)) throw new SlidePlanPipelineError("publication", "finalDirectory already exists");
  await cleanPipelineStaging(stagingDirectory);
  await mkdir(stagingDirectory, { recursive: true });

  try {
    const confirmedAt = reviewConfirmedAt(input);
    const snapshot = deepFreeze(structuredClone(input.snapshot));
    let plan = input.existingPlan === undefined
      ? await planTranscriptToSlides(snapshot, { ...input.planner, theme: input.theme })
      : parseSlidePlan(structuredClone(input.existingPlan));
    if (input.existingPlan !== undefined) {
      const identity = plan.snapshot;
      if (identity.meetingId !== snapshot.meetingId ||
          identity.transcriptVersionId !== snapshot.transcriptVersionId ||
          identity.contentSha256 !== snapshot.contentSha256 ||
          identity.lineCount !== snapshot.lines.length) {
        throw new SlidePlanPipelineError("planning", "existing plan does not match the exact transcript snapshot");
      }
    }
    try {
      validateSlidePlanAgainstSnapshot(plan, snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SlidePlanPipelineError("planning", message);
    }
    assertTheme(plan, input);
    emit(input, 1);

    const assets = await resolvePipelineAssets(plan, input.assetPolicy, {
      managedAssetRoot: resolve(input.managedAssetRoot),
      stagingDirectory,
      theme: input.theme,
    });
    plan = assets.plan;
    emit(input, 2);

    // Every generated or persisted plan crosses the same seven-slide,
    // evidence, editorial-status, and atomic-provenance boundary.
    const prepared = plan.slides.map(preparePlanSlideGeometry);
    const drafts = prepared.map((entry) => entry.draft);
    emit(input, 3);

    const layers: readonly ResolvedAssetLayer[] = plan.slides.map((slide) => resolveSlideAssets(plan, assets.manifest, slide));
    const geometry = prepared.map((entry, index) => {
      const layer = layers[index];
      const assetRects = layer === undefined
        ? []
        : layer.placements.map((placement) => ({ id: placement.id, box: placement.box }));
      return preflightGeometrySlide(
        entry.compile(input.theme, {
          textMeasurer: input.textMeasurer,
          textPolicies: input.textPolicies,
        }),
        input.preflight,
        assetRects,
      );
    });
    const blocked = geometry.find((slide) => slide.status === "blocked");
    if (blocked !== undefined) {
      const issue = blocked.issues[0];
      throw new SlidePlanPipelineError("geometry", issue === undefined ? "preflight blocked" : `${issue.path}: ${issue.message}`);
    }
    emit(input, 4);

    const identity = identityFor(plan, geometry.map((entry) => entry.slide.id), snapshot);
    const finalityReceipt = finalityReceiptFor(identity, confirmedAt);
    const artifacts: PipelineArtifact[] = [];
    const published: PublishedArtifact[] = [];
    const occupied = new Set<string>(["slide-plan.json", "asset-manifest.json", "publication.json"]);
    const base = { identity, plan, assetManifest: assets.manifest, drafts, slides: geometry, assetLayers: layers, managedAssetRoot: resolve(input.managedAssetRoot) };

    const standalone = await invokePublisher("standalone-html", input.publishers.standalone, {
      ...base, priorArtifacts: [], outputDirectory: resolve(stagingDirectory, ".publisher-standalone"),
    }, stagingDirectory, occupied);
    artifacts.push(standalone.artifact); published.push(standalone.published); emit(input, 5);

    const pptx = await invokePublisher("editable-pptx", input.publishers.pptx, {
      ...base, priorArtifacts: [...artifacts], outputDirectory: resolve(stagingDirectory, ".publisher-pptx"),
    }, stagingDirectory, occupied);
    artifacts.push(pptx.artifact); published.push(pptx.published); emit(input, 6);

    const raster = await invokePublisher("raster-png-pdf", input.publishers.raster, {
      ...base, priorArtifacts: [...artifacts], outputDirectory: resolve(stagingDirectory, ".publisher-raster"),
    }, stagingDirectory, occupied);
    artifacts.push(raster.artifact); published.push(raster.published); emit(input, 7);

    const result = await publishPipelineResult({
      identity,
      plan,
      artifacts: published,
      assetManifest: assets.manifest,
      stagingDirectory,
      finalDirectory,
      ...(finalityReceipt === undefined ? {} : { finalityReceipt }),
    });
    emit(input, 8);
    return result;
  } catch (error) {
    await cleanPipelineStaging(stagingDirectory);
    throw error;
  }
}
