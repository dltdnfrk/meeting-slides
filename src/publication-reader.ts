import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { decodePublicationManifest, pipelineHash } from "./slides/server-pipeline-publication.ts";

export interface ArtifactPublication {
  readonly path: string;
  readonly publicationSha256: string;
}

interface ManifestFile {
  readonly sha256: string;
  readonly byteLength: number;
}

export interface VerifiedPublicationFile {
  readonly filePath: string;
  readonly bytes: Buffer<ArrayBuffer>;
}

export class SlidePlanArtifactError extends Error {
  constructor(readonly status: 403 | 404 | 409, message: string) {
    super(message);
    this.name = "SlidePlanArtifactError";
  }
}

function fail(status: 403 | 404 | 409, message: string): never {
  throw new SlidePlanArtifactError(status, message);
}

export function safeRelativePath(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !path.includes("\\") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function within(parent: string, child: string): boolean {
  const displacement = relative(parent, child);
  return displacement === "" ||
    (displacement !== ".." && !displacement.startsWith(`..${sep}`) && !isAbsolute(displacement));
}

function manifestFiles(raw: string, expectedPlanId: string, expectedSha256: string): Map<string, ManifestFile | null> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return fail(409, "publication manifest is invalid JSON");
    throw error;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded) || !("publicationSha256" in decoded)) {
    return fail(409, "publication manifest must contain a receipt");
  }
  const publication = decoded;
  if (publication.publicationSha256 !== expectedSha256) return fail(409, "publication receipt hash mismatch");
  const { publicationSha256: _, ...manifest } = publication;
  if (pipelineHash(`${JSON.stringify(manifest)}
`) !== expectedSha256) {
    return fail(409, "publication manifest hash mismatch");
  }
  let normalized: ReturnType<typeof decodePublicationManifest>;
  try {
    normalized = decodePublicationManifest(manifest);
  } catch (error) {
    if (error instanceof TypeError) return fail(409, error.message);
    throw error;
  }
  if (normalized.identity.planId !== expectedPlanId) return fail(409, "publication plan identity mismatch");
  const allowed = new Map<string, ManifestFile | null>([
    ["publication.json", null],
    ["slide-plan.json", { sha256: normalized.planSha256, byteLength: -1 }],
    ["asset-manifest.json", { sha256: normalized.assetManifestSha256, byteLength: -1 }],
  ]);
  for (const artifact of normalized.artifacts) {
    for (const file of artifact.files) {
      if (!safeRelativePath(file.relativePath)) return fail(409, "publication file metadata is invalid");
      allowed.set(file.relativePath, { sha256: file.sha256, byteLength: file.byteLength });
    }
  }
  return allowed;
}

function filesystem<T>(operation: () => T, label: string): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return fail(404, `${label} not found`);
      if (error.code === "EACCES" || error.code === "EPERM" || error.code === "ELOOP") return fail(403, `${label} is inaccessible`);
    }
    throw error;
  }
}

function readPublicationFile(root: string, relativePath: string): VerifiedPublicationFile {
  if (!safeRelativePath(relativePath)) return fail(403, "artifact path is invalid");
  const canonical = filesystem(() => realpathSync(resolve(root, relativePath)), relativePath);
  if (!within(root, canonical)) return fail(403, "artifact escapes publication directory");
  return filesystem(() => {
    if (!statSync(canonical).isFile()) return fail(403, "artifact is not a regular publication file");
    return Object.freeze({ filePath: canonical, bytes: readFileSync(canonical) });
  }, relativePath);
}

/** One receipt check per read session; consumers use the bytes that were hashed, never reopen the path. */
export function openVerifiedPublication(publication: ArtifactPublication, planId: string) {
  const root = filesystem(() => realpathSync(resolve(publication.path)), "publication directory");
  const manifest = readPublicationFile(root, "publication.json");
  const files = manifestFiles(manifest.bytes.toString("utf8"), planId, publication.publicationSha256);
  return Object.freeze({
    read(relativePath: string): VerifiedPublicationFile {
      if (!safeRelativePath(relativePath)) return fail(403, "artifact path is invalid");
      const metadata = files.get(relativePath);
      if (metadata === undefined) return fail(404, "artifact is not in the publication manifest");
      if (metadata === null) return manifest;
      const file = readPublicationFile(root, relativePath);
      if ((metadata.byteLength >= 0 && file.bytes.byteLength !== metadata.byteLength) || pipelineHash(file.bytes) !== metadata.sha256) {
        return fail(409, "artifact bytes do not match the publication manifest");
      }
      return file;
    },
  });
}
