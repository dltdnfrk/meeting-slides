import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveSlideAssets, type ResolvedAssetLayer } from "./assets/integration.ts";
import { compileGeometrySlide } from "./geometry/compiler.ts";
import { preflightGeometrySlide } from "./geometry/preflight.ts";
import { draftLayout, PRIMARY_LAYOUT_FAMILIES } from "./layouts/registry.ts";
import type { SlidePlan, SnapshotIdentity } from "./model/plan.ts";
import { planTranscriptToSlides } from "./planning/planner.ts";
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
  type RunSlidePlanPipelineInput,
  type SlidePlanPublicationResult,
} from "./server-pipeline-types.ts";

export type {
  PipelineArtifact, PipelineArtifactFile, PipelineArtifactFormat, PipelineArtifactPublisher,
  PipelineAssetContext, PipelineAssetPolicy, PipelineIdentity, PipelineProgressEvent,
  PipelinePublisherRequest, PublishedArtifact, PublishedArtifactFile,
  RunSlidePlanPipelineInput, SlidePlanPublicationManifest, SlidePlanPublicationResult,
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
      reviewedItemIds: review.items.map((item) => item.id),
    }),
  });
}

function assertTheme(plan: SlidePlan, input: RunSlidePlanPipelineInput): void {
  if (JSON.stringify(plan.theme) !== JSON.stringify(input.theme)) {
    throw new SlidePlanPipelineError("planning", "planner theme does not match the explicit server theme");
  }
}

function assertSevenLayouts(plan: SlidePlan): void {
  const layouts = plan.slides.map((slide) => slide.layout);
  if (layouts.length !== PRIMARY_LAYOUT_FAMILIES.length ||
      PRIMARY_LAYOUT_FAMILIES.some((family) => !layouts.includes(family))) {
    throw new SlidePlanPipelineError("layouts", "plan must contain one draft for each of the seven primary layout families");
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
    const snapshot = deepFreeze(structuredClone(input.snapshot));
    let plan = input.existingPlan ?? await planTranscriptToSlides(snapshot, input.planner);
    if (input.existingPlan !== undefined) {
      const identity = input.existingPlan.snapshot;
      if (identity.meetingId !== snapshot.meetingId ||
          identity.transcriptVersionId !== snapshot.transcriptVersionId ||
          identity.contentSha256 !== snapshot.contentSha256 ||
          identity.lineCount !== snapshot.lines.length) {
        throw new SlidePlanPipelineError("planning", "existing plan does not match the exact transcript snapshot");
      }
      plan = input.existingPlan;
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

    // The planner contract starts with one representative of every primary
    // family. Human revisions may reorder, delete, insert, or change layouts.
    if (input.existingPlan === undefined) assertSevenLayouts(plan);
    const drafts = plan.slides.map(draftLayout);
    emit(input, 3);

    const geometry = drafts.map((draft) => preflightGeometrySlide(
      compileGeometrySlide(draft, input.theme, {
        textMeasurer: input.textMeasurer,
        textPolicies: input.textPolicies,
      }),
      input.preflight,
    ));
    const blocked = geometry.find((slide) => slide.status === "blocked");
    if (blocked !== undefined) {
      const issue = blocked.issues[0];
      throw new SlidePlanPipelineError("geometry", issue === undefined ? "preflight blocked" : `${issue.path}: ${issue.message}`);
    }
    const layers: readonly ResolvedAssetLayer[] = plan.slides.map((slide) => resolveSlideAssets(plan, assets.manifest, slide));
    emit(input, 4);

    const identity = identityFor(plan, geometry.map((entry) => entry.slide.id), snapshot);
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

    const result = await publishPipelineResult({ identity, plan, artifacts: published, assetManifest: assets.manifest, stagingDirectory, finalDirectory });
    emit(input, 8);
    return result;
  } catch (error) {
    await cleanPipelineStaging(stagingDirectory);
    throw error;
  }
}
