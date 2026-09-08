import {
  openVerifiedPublication, safeRelativePath, SlidePlanArtifactError,
  type ArtifactPublication, type VerifiedPublicationFile,
} from "./publication-reader.ts";

export { SlidePlanArtifactError } from "./publication-reader.ts";

const PREFIX = "/slide-plan-artifacts/";
const MIME: Readonly<Record<string, string>> = Object.freeze({
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  png: "image/png",
});

export interface SlidePlanArtifactStore {
  one(planId: string): ArtifactPublication | null;
}

export interface ResolvedSlidePlanArtifact extends VerifiedPublicationFile {
  readonly contentType: string;
  readonly disposition: "attachment";
}

function fail(status: 403 | 404 | 409, message: string): never {
  throw new SlidePlanArtifactError(status, message);
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

export async function resolveSlidePlanArtifact(
  pathname: string,
  store: SlidePlanArtifactStore,
): Promise<ResolvedSlidePlanArtifact> {
  const route = decodeRoute(pathname);
  const publication = store.one(route.planId);
  if (publication === null) return fail(404, "SlidePlan publication not found");
  const file = openVerifiedPublication(publication, route.planId).read(route.relativePath);
  const extension = route.relativePath.split(".").at(-1)?.toLowerCase() ?? "";
  return Object.freeze({
    ...file,
    contentType: MIME[extension] ?? "application/octet-stream",
    disposition: "attachment",
  });
}
