import { validateAssets, validateClaims, validateTheme } from "./contract-parser.ts";
import {
  deepFreeze, exact, integer, isoDate, sha256, stableId, text, SlidePlanParseError,
} from "./parse-helpers.ts";
import { validateSlides } from "./slide-parser.ts";
import type { SlidePlan } from "./plan.ts";

export type { SlidePlan } from "./plan.ts";
export { SlidePlanParseError } from "./parse-helpers.ts";

function decode(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new SlidePlanParseError("plan", `must be valid JSON: ${detail}`);
  }
}

export function parseSlidePlan(input: unknown): SlidePlan {
  const decoded = decode(input);
  const plan = exact(decoded, "plan", [
    "schemaVersion", "planId", "revision", "snapshot", "title", "theme", "claims",
    "assets", "slides", "createdAt", "updatedAt",
  ]);
  if (plan.schemaVersion !== 1) {
    throw new SlidePlanParseError("plan.schemaVersion", "unsupported version; must be 1");
  }
  stableId(plan.planId, "plan.planId");
  integer(plan.revision, "plan.revision", 0);
  const snapshot = exact(plan.snapshot, "snapshot", [
    "meetingId", "transcriptVersionId", "contentSha256", "lineCount",
  ]);
  integer(snapshot.meetingId, "snapshot.meetingId", 1);
  const transcriptVersionId = stableId(snapshot.transcriptVersionId, "snapshot.transcriptVersionId");
  sha256(snapshot.contentSha256, "snapshot.contentSha256");
  const lineCount = integer(snapshot.lineCount, "snapshot.lineCount", 0);
  text(plan.title, "plan.title");
  validateTheme(plan.theme);
  const claimIds = validateClaims(plan.claims, { transcriptVersionId, lineCount });
  const assetIds = validateAssets(plan.assets, claimIds);
  validateSlides(plan.slides, claimIds, assetIds);
  isoDate(plan.createdAt, "plan.createdAt");
  isoDate(plan.updatedAt, "plan.updatedAt");

  // Every field has been validated above; this is the parser's sole narrowing boundary.
  const detached = structuredClone(plan) as unknown as SlidePlan;
  return deepFreeze(detached);
}
