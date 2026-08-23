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

function manifestPaths(raw: string, expectedPlanId: string, expectedSha256: string): Set<string> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return fail(409, "publication manifest is invalid JSON");
  }
  const publication = object(decoded, "publication manifest must be an object");
  if (publication.publicationSha256 !== expectedSha256) return fail(409, "publication receipt hash mismatch");
  const { publicationSha256: _, ...manifest } = publication;
  if (pipelineHash(`${JSON.stringify(manifest)}\n`) !== expectedSha256) {
    return fail(409, "publication manifest hash mismatch");
  }
  const identity = object(manifest.identity, "publication identity is invalid");
  if (identity.planId !== expectedPlanId) return fail(409, "publication plan identity mismatch");
  if (!Array.isArray(manifest.artifacts)) return fail(409, "publication artifacts are invalid");

  const allowed = new Set(["publication.json", "slide-plan.json", "asset-manifest.json"]);
  for (const artifact of manifest.artifacts) {
    const entry = object(artifact, "publication artifact is invalid");
    if (!Array.isArray(entry.files)) return fail(409, "publication files are invalid");
    for (const file of entry.files) {
      const relativePath = object(file, "publication file is invalid").relativePath;
      if (typeof relativePath !== "string" || !safeRelativePath(relativePath)) {
        return fail(409, "publication file path is invalid");
      }
      allowed.add(relativePath);
    }
  }
  return allowed;
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
  if (!manifestPaths(manifest, route.planId, publication.publicationSha256).has(route.relativePath)) {
    return fail(404, "artifact is not in the publication manifest");
  }
  const candidate = resolve(root, route.relativePath);
  if (!within(root, candidate)) return fail(403, "artifact escapes publication directory");
  const canonical = await realpath(candidate).catch(() => fail(404, "artifact not found"));
  if (!within(root, canonical) || !(await stat(canonical)).isFile()) {
    return fail(403, "artifact is not a regular publication file");
  }
  const extension = route.relativePath.split(".").at(-1)?.toLowerCase() ?? "";
  return Object.freeze({
    filePath: canonical,
    contentType: MIME[extension] ?? "application/octet-stream",
    disposition: "attachment",
  });
}
