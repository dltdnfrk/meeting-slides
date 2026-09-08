import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { stableAssetManifestJson, type AssetManifest } from "./assets/manifest.ts";
import { parseSlidePlan } from "./model/plan-parser.ts";
import type { SlidePlan } from "./model/plan.ts";
import type {
  NormalizedSlidePlanPublicationManifest, PipelineArtifact, PipelineArtifactFormat, PipelineIdentity,
  PublishedArtifact, PublishedArtifactFile, SlidePlanFinalityReceipt, SlidePlanPublicationManifestV2,
  SlidePlanPublicationResult, SlidePlanPublicationStatus,
} from "./server-pipeline-types.ts";

export function publicationStatusForReview(reviewId: string | undefined): SlidePlanPublicationStatus {
  return reviewId === undefined ? "draft" : "final";
}

export function pipelineHash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableSlidePlanJson(plan: SlidePlan): string {
  return `${JSON.stringify(parseSlidePlan(plan))}\n`;
}

function manifestObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function manifestText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be non-empty`);
  return value;
}

function manifestHash(value: unknown, path: string): string {
  const hash = manifestText(value, path);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError(`${path} must be a SHA-256 hash`);
  return hash;
}

function manifestIds(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const ids = value.map((entry, index) => manifestText(entry, `${path}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new TypeError(`${path} must contain unique IDs`);
  return Object.freeze(ids);
}

function decodeIdentity(value: unknown): PipelineIdentity {
  const identity = manifestObject(value, "identity");
  const snapshot = manifestObject(identity.snapshot, "identity.snapshot");
  const meetingId = snapshot.meetingId;
  const lineCount = snapshot.lineCount;
  if (!Number.isSafeInteger(meetingId) || !Number.isSafeInteger(lineCount) || (meetingId as number) <= 0 || (lineCount as number) < 0) {
    throw new TypeError("identity snapshot counts are invalid");
  }
  const reviewId = Object.hasOwn(identity, "reviewId")
    ? manifestText(identity.reviewId, "identity.reviewId")
    : undefined;
  const reviewedItemIds = Object.hasOwn(identity, "reviewedItemIds")
    ? manifestIds(identity.reviewedItemIds, "identity.reviewedItemIds")
    : undefined;
  if ((reviewId === undefined) !== (reviewedItemIds === undefined)) {
    throw new TypeError("publication Review identity is incomplete");
  }
  return Object.freeze({
    planId: manifestText(identity.planId, "identity.planId"),
    deckId: manifestText(identity.deckId, "identity.deckId"),
    snapshot: Object.freeze({
      meetingId: meetingId as number,
      transcriptVersionId: manifestText(snapshot.transcriptVersionId, "identity.snapshot.transcriptVersionId"),
      contentSha256: manifestHash(snapshot.contentSha256, "identity.snapshot.contentSha256"),
      lineCount: lineCount as number,
    }),
    slideIds: manifestIds(identity.slideIds, "identity.slideIds"),
    geometryIds: manifestIds(identity.geometryIds, "identity.geometryIds"),
    claimIds: manifestIds(identity.claimIds, "identity.claimIds"),
    ...(reviewId === undefined || reviewedItemIds === undefined ? {} : { reviewId, reviewedItemIds }),
  });
}

function decodeArtifacts(value: unknown): readonly PublishedArtifact[] {
  if (!Array.isArray(value)) throw new TypeError("artifacts must be an array");
  return Object.freeze(value.map((rawArtifact, artifactIndex) => {
    const artifact = manifestObject(rawArtifact, `artifacts[${artifactIndex}]`);
    const format = artifact.format;
    if (format !== "standalone-html" && format !== "editable-pptx" && format !== "raster-png-pdf") {
      throw new TypeError(`artifacts[${artifactIndex}].format is invalid`);
    }
    if (!Array.isArray(artifact.files)) throw new TypeError(`artifacts[${artifactIndex}].files must be an array`);
    const files: PublishedArtifactFile[] = artifact.files.map((rawFile, fileIndex) => {
      const path = `artifacts[${artifactIndex}].files[${fileIndex}]`;
      const file = manifestObject(rawFile, path);
      const byteLength = file.byteLength;
      if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) throw new TypeError(`${path}.byteLength is invalid`);
      return Object.freeze({
        relativePath: manifestText(file.relativePath, `${path}.relativePath`),
        byteLength: byteLength as number,
        sha256: manifestHash(file.sha256, `${path}.sha256`),
      });
    });
    return Object.freeze({ format, files: Object.freeze(files) });
  }));
}

function decodeReceipt(value: unknown): SlidePlanFinalityReceipt {
  const receipt = manifestObject(value, "finalityReceipt");
  const confirmedAt = receipt.confirmedAt;
  if (!Number.isSafeInteger(confirmedAt) || (confirmedAt as number) <= 0) {
    throw new TypeError("finalityReceipt.confirmedAt must be a positive integer");
  }
  return Object.freeze({
    reviewId: manifestText(receipt.reviewId, "finalityReceipt.reviewId"),
    confirmedAt: confirmedAt as number,
    transcriptVersionId: manifestText(receipt.transcriptVersionId, "finalityReceipt.transcriptVersionId"),
    contentSha256: manifestHash(receipt.contentSha256, "finalityReceipt.contentSha256"),
    reviewedItemIds: manifestIds(receipt.reviewedItemIds, "finalityReceipt.reviewedItemIds"),
  });
}

function receiptMatchesIdentity(receipt: SlidePlanFinalityReceipt, identity: PipelineIdentity): boolean {
  return identity.reviewId === receipt.reviewId &&
    identity.snapshot.transcriptVersionId === receipt.transcriptVersionId &&
    identity.snapshot.contentSha256 === receipt.contentSha256 &&
    JSON.stringify(identity.reviewedItemIds) === JSON.stringify(receipt.reviewedItemIds);
}

export function decodePublicationManifest(value: unknown): NormalizedSlidePlanPublicationManifest {
  const manifest = manifestObject(value, "publication manifest");
  const identity = decodeIdentity(manifest.identity);
  const derivedStatus = publicationStatusForReview(identity.reviewId);
  const common = {
    identity,
    planSha256: manifestHash(manifest.planSha256, "planSha256"),
    assetManifestSha256: manifestHash(manifest.assetManifestSha256, "assetManifestSha256"),
    artifacts: decodeArtifacts(manifest.artifacts),
  };
  if (manifest.schemaVersion === 1) {
    if (Object.hasOwn(manifest, "finalityReceipt")) throw new TypeError("schema v1 forbids finalityReceipt");
    if (Object.hasOwn(manifest, "publicationStatus") && manifest.publicationStatus !== derivedStatus) {
      throw new TypeError("schema v1 publicationStatus contradicts its identity");
    }
    return Object.freeze({ schemaVersion: 1, publicationStatus: derivedStatus, ...common });
  }
  if (manifest.schemaVersion !== 2) throw new TypeError("publication schemaVersion is unsupported");
  if (manifest.publicationStatus !== "draft" && manifest.publicationStatus !== "final") {
    throw new TypeError("schema v2 publicationStatus is required");
  }
  if (manifest.publicationStatus !== derivedStatus) throw new TypeError("schema v2 publicationStatus contradicts its identity");
  if (manifest.publicationStatus === "draft") {
    if (Object.hasOwn(manifest, "finalityReceipt")) throw new TypeError("schema v2 draft forbids finalityReceipt");
    return Object.freeze({ schemaVersion: 2, publicationStatus: "draft", ...common });
  }
  if (!Object.hasOwn(manifest, "finalityReceipt")) throw new TypeError("schema v2 final requires finalityReceipt");
  const finalityReceipt = decodeReceipt(manifest.finalityReceipt);
  if (!receiptMatchesIdentity(finalityReceipt, identity)) throw new TypeError("finalityReceipt does not match publication identity");
  return Object.freeze({ schemaVersion: 2, publicationStatus: "final", finalityReceipt, ...common });
}

function safePath(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !path.includes("\\") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function sameIdentity(left: PipelineIdentity, right: PipelineIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function stageArtifact(
  artifact: PipelineArtifact,
  expectedFormat: PipelineArtifactFormat,
  identity: PipelineIdentity,
  stagingDirectory: string,
  occupied: Set<string>,
): Promise<PublishedArtifact> {
  if (artifact.format !== expectedFormat) throw new TypeError(`publisher returned '${artifact.format}', expected '${expectedFormat}'`);
  if (!sameIdentity(artifact.identity, identity)) throw new TypeError(`${expectedFormat} publisher returned mismatched identity`);
  if (artifact.files.length === 0) throw new TypeError(`${expectedFormat} publisher returned no files`);
  const files = [];
  for (const file of artifact.files) {
    if (!safePath(file.relativePath)) throw new TypeError(`unsafe artifact path '${file.relativePath}'`);
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength === 0) throw new TypeError(`artifact '${file.relativePath}' has no bytes`);
    if (occupied.has(file.relativePath)) throw new TypeError(`duplicate artifact path '${file.relativePath}'`);
    occupied.add(file.relativePath);
    const output = resolve(stagingDirectory, file.relativePath);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, file.bytes, { flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode: 0o600 });
    files.push({ relativePath: file.relativePath, byteLength: file.bytes.byteLength, sha256: pipelineHash(file.bytes) });
  }
  return Object.freeze({ format: expectedFormat, files: Object.freeze(files) });
}

export async function publishPipelineResult(options: {
  readonly identity: PipelineIdentity;
  readonly plan: SlidePlan;
  readonly artifacts: readonly PublishedArtifact[];
  readonly assetManifest: AssetManifest;
  readonly finalityReceipt?: SlidePlanFinalityReceipt;
  readonly stagingDirectory: string;
  readonly finalDirectory: string;
}): Promise<SlidePlanPublicationResult> {
  const planJson = stableSlidePlanJson(options.plan);
  const assetManifestJson = stableAssetManifestJson(options.assetManifest);
  const publicationStatus = publicationStatusForReview(options.identity.reviewId);
  const common = {
    schemaVersion: 2 as const,
    identity: options.identity,
    planSha256: pipelineHash(planJson),
    assetManifestSha256: pipelineHash(assetManifestJson),
    artifacts: Object.freeze([...options.artifacts]),
  };
  let manifest: SlidePlanPublicationManifestV2;
  if (publicationStatus === "draft") {
    if (options.finalityReceipt !== undefined) throw new TypeError("draft publication cannot carry finalityReceipt");
    manifest = Object.freeze({ ...common, publicationStatus: "draft" });
  } else {
    if (options.finalityReceipt === undefined) throw new TypeError("final publication requires finalityReceipt");
    manifest = Object.freeze({ ...common, publicationStatus: "final", finalityReceipt: options.finalityReceipt });
  }
  decodePublicationManifest(manifest);
  const manifestJson = `${JSON.stringify(manifest)}\n`;
  const publicationSha256 = pipelineHash(manifestJson);
  await writeFile(resolve(options.stagingDirectory, "slide-plan.json"), planJson, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(options.stagingDirectory, "asset-manifest.json"), assetManifestJson, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(options.stagingDirectory, "publication.json"), `${JSON.stringify({ ...manifest, publicationSha256 })}\n`, { flag: "wx", mode: 0o600 });
  await mkdir(dirname(options.finalDirectory), { recursive: true });
  await rename(options.stagingDirectory, options.finalDirectory);
  return Object.freeze({ ...manifest, directory: options.finalDirectory, assetManifest: options.assetManifest, planJson, manifestJson, publicationSha256 });
}

export async function cleanPipelineStaging(stagingDirectory: string): Promise<void> {
  await rm(stagingDirectory, { recursive: true, force: true });
}

export function validateOutputDirectories(stagingDirectory: string, finalDirectory: string): void {
  const staging = resolve(stagingDirectory);
  const final = resolve(finalDirectory);
  if (!isAbsolute(stagingDirectory) || !isAbsolute(finalDirectory)) throw new TypeError("pipeline output directories must be absolute");
  if (staging === final || relative(staging, final) === "" || relative(final, staging) === "") throw new TypeError("stagingDirectory and finalDirectory must be distinct");
}
