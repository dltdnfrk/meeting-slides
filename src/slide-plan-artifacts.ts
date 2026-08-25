import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { pipelineHash } from "./slides/server-pipeline-publication.ts";

const PREFIX = "/slide-plan-artifacts/";
const MIME: Readonly<Record<string, string>> = Object.freeze({
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  png: "image/png",
});

interface ArtifactPublication {
  readonly path: string;
  readonly publicationSha256: string;
}

interface ManifestFile {
  readonly sha256: string;
  readonly byteLength: number;
}

export interface SlidePlanArtifactStore {
  one(planId: string): ArtifactPublication | null;
}

export interface ResolvedSlidePlanArtifact {
  readonly filePath: string;
  readonly contentType: string;
  readonly disposition: "attachment";
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

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(409, message);
  return value as Record<string, unknown>;
}

function safeRelativePath(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !path.includes("\\") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function within(parent: string, child: string): boolean {
  const displacement = relative(parent, child);
  return displacement === "" ||
    (displacement !== ".." && !displacement.startsWith(`..${sep}`) && !isAbsolute(displacement));
}

function decodeRoute(pathname: string): { planId: string; relativePath: string } {
  if (!pathname.startsWith(PREFIX)) return fail(404, "artifact route not found");
  let parts: string[];
  try {
    parts = pathname.slice(PREFIX.length).split("/").map((part) => decodeURIComponent(part));
  } catch {
    return fail(403, "artifact path is invalid");
  }
  const planId = parts.shift() ?? "";
  const relativePath = parts.join("/");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(planId) || !safeRelativePath(relativePath)) {
    return fail(403, "artifact path is invalid");
  }
  return { planId, relativePath };
}

function manifestFiles(raw: string, expectedPlanId: string, expectedSha256: string): Map<string, ManifestFile | null> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return fail(409, "publication manifest is invalid JSON");
  }
  const publication = object(decoded, "publication manifest must be an object");
  if (publication.publicationSha256 !== expectedSha256) return fail(409, "publication receipt hash mismatch");
  const { publicationSha256: _, ...manifest } = publication;
  if (pipelineHash(`${JSON.stringify(manifest)}
`) !== expectedSha256) {
    return fail(409, "publication manifest hash mismatch");
  }
  const identity = object(manifest.identity, "publication identity is invalid");
  if (identity.planId !== expectedPlanId) return fail(409, "publication plan identity mismatch");
  if (!Array.isArray(manifest.artifacts)) return fail(409, "publication artifacts are invalid");

  const planSha256 = manifest.planSha256;
  const assetManifestSha256 = manifest.assetManifestSha256;
  if (typeof planSha256 !== "string" || typeof assetManifestSha256 !== "string") {
    return fail(409, "publication root hashes are invalid");
  }
  const allowed = new Map<string, ManifestFile | null>([
    ["publication.json", null],
    ["slide-plan.json", { sha256: planSha256, byteLength: -1 }],
    ["asset-manifest.json", { sha256: assetManifestSha256, byteLength: -1 }],
  ]);
  for (const artifact of manifest.artifacts) {
    const entry = object(artifact, "publication artifact is invalid");
    if (!Array.isArray(entry.files)) return fail(409, "publication files are invalid");
    for (const file of entry.files) {
      const value = object(file, "publication file is invalid");
      const relativePath = value.relativePath;
      if (typeof relativePath !== "string" || !safeRelativePath(relativePath) ||
          typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
          !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0) {
        return fail(409, "publication file metadata is invalid");
      }
      allowed.set(relativePath, { sha256: value.sha256, byteLength: value.byteLength as number });
    }
  }
  return allowed;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export async function resolveSlidePlanArtifact(
  pathname: string,
  store: SlidePlanArtifactStore,
): Promise<ResolvedSlidePlanArtifact> {
  const route = decodeRoute(pathname);
  const publication = store.one(route.planId);
  if (publication === null) return fail(404, "SlidePlan publication not found");
  const root = await realpath(resolve(publication.path)).catch(() => fail(404, "publication directory not found"));
  const manifestPath = resolve(root, "publication.json");
  const manifest = await readFile(manifestPath, "utf8").catch(() => fail(404, "publication manifest not found"));
  const metadata = manifestFiles(manifest, route.planId, publication.publicationSha256).get(route.relativePath);
  if (metadata === undefined) return fail(404, "artifact is not in the publication manifest");
  const candidate = resolve(root, route.relativePath);
  if (!within(root, candidate)) return fail(403, "artifact escapes publication directory");
  const canonical = await realpath(candidate).catch(() => fail(404, "artifact not found"));
  const fileStat = await stat(canonical);
  if (!within(root, canonical) || !fileStat.isFile()) {
    return fail(403, "artifact is not a regular publication file");
  }
  if (metadata !== null &&
      ((metadata.byteLength >= 0 && fileStat.size !== metadata.byteLength) || await sha256File(canonical) !== metadata.sha256)) {
    return fail(409, "artifact bytes do not match the publication manifest");
  }
  const extension = route.relativePath.split(".").at(-1)?.toLowerCase() ?? "";
  return Object.freeze({
    filePath: canonical,
    contentType: MIME[extension] ?? "application/octet-stream",
    disposition: "attachment",
  });
}
