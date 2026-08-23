import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { stableAssetManifestJson, type AssetManifest } from "./assets/manifest.ts";
import { parseSlidePlan } from "./model/plan-parser.ts";
import type { SlidePlan } from "./model/plan.ts";
import type {
  PipelineArtifact, PipelineArtifactFormat, PipelineIdentity, PublishedArtifact,
  SlidePlanPublicationManifest, SlidePlanPublicationResult,
} from "./server-pipeline-types.ts";

export function pipelineHash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableSlidePlanJson(plan: SlidePlan): string {
  return `${JSON.stringify(parseSlidePlan(plan))}\n`;
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
  readonly stagingDirectory: string;
  readonly finalDirectory: string;
}): Promise<SlidePlanPublicationResult> {
  const planJson = stableSlidePlanJson(options.plan);
  const assetManifestJson = stableAssetManifestJson(options.assetManifest);
  const manifest: SlidePlanPublicationManifest = Object.freeze({
    schemaVersion: 1 as const,
    identity: options.identity,
    planSha256: pipelineHash(planJson),
    assetManifestSha256: pipelineHash(assetManifestJson),
    artifacts: Object.freeze([...options.artifacts]),
  });
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
