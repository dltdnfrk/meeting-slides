import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parseAssetRecord, type AssetRecord } from "./assets/contract.ts";
import { createMissingAssetFallback } from "./assets/fallback.ts";
import { createAssetRegistry } from "./assets/registry.ts";
import type { PlanAsset } from "./model/plan.ts";
import type {
  ConfirmedReviewEvidence, TranscriptLine, TranscriptSnapshot,
} from "./planning/planner.ts";
import { validateConfirmedReview } from "./planning/review-evidence.ts";
import type { PipelineAssetPolicy } from "./server-pipeline-types.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "./theme/meeting-paper.ts";

export { productionTextPolicies, ScriptAwareTextMeasurer } from "./geometry/production-text.ts";

interface TranscriptReviewInput {
  readonly lines: readonly TranscriptLine[];
  readonly confirmedReview?: ConfirmedReviewEvidence;
}

export type SlidePlanTranscriptInput = Readonly<TranscriptReviewInput & (
  | { state: "live" }
  | { state: "finalized"; transcriptVersionId: string; contentSha256: string }
)>;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateLines(lines: readonly TranscriptLine[]): void {
  if (!Array.isArray(lines)) throw new TypeError("transcript lines must be an array");
  let prior = 0;
  for (const line of lines) {
    if (!Number.isInteger(line.seq) || line.seq <= prior) throw new TypeError("transcript line seq values must be positive and increasing");
    if (line.speaker !== null && typeof line.speaker !== "string") throw new TypeError("transcript line speaker must be a string or null");
    if (typeof line.text !== "string") throw new TypeError("transcript line text must be a string");
    prior = line.seq;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function identifyTranscript(meetingId: number, input: SlidePlanTranscriptInput): TranscriptSnapshot {
  if (!Number.isSafeInteger(meetingId) || meetingId <= 0) throw new TypeError("meetingId must be a positive safe integer");
  validateLines(input.lines);
  const lines = structuredClone(input.lines);
  const confirmedReview = input.confirmedReview === undefined ? {} : {
    confirmedReview: structuredClone(input.confirmedReview),
  };
  let snapshot: TranscriptSnapshot;
  if (input.state === "finalized") {
    if (input.transcriptVersionId.trim() === "" || !/^[0-9a-f]{64}$/.test(input.contentSha256)) {
      throw new TypeError("finalized transcript identity is invalid");
    }
    snapshot = { state: input.state, meetingId, transcriptVersionId: input.transcriptVersionId,
      contentSha256: input.contentSha256, lines, ...confirmedReview };
  } else {
    const contentSha256 = sha256(JSON.stringify(lines.map(({ seq, speaker, text }) => ({ seq, speaker, text }))));
    snapshot = { state: input.state, meetingId, transcriptVersionId: `live-${contentSha256}`,
      contentSha256, lines, ...confirmedReview };
  }
  validateConfirmedReview(snapshot);
  return deepFreeze(snapshot);
}

export async function installMeetingPaperFont(cacheRoot: string, sourcePath: string): Promise<void> {
  const bytes = new Uint8Array(await readFile(resolve(sourcePath)));
  const expected = MEETING_PAPER_STYLE_PROFILE.font.sha256;
  if (sha256(bytes) !== expected) throw new TypeError("local Pretendard font does not match the meeting-paper SHA-256");
  const destination = resolve(cacheRoot, MEETING_PAPER_STYLE_PROFILE.font.localPath);
  await mkdir(dirname(destination), { recursive: true });
  try {
    const existing = new Uint8Array(await readFile(destination));
    if (sha256(existing) !== expected) throw new TypeError("managed Pretendard font has an invalid SHA-256");
    return;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode: 0o600 });
  try {
    try { await link(temporary, destination); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  const installed = new Uint8Array(await readFile(destination));
  if (sha256(installed) !== expected) throw new TypeError("managed Pretendard font failed verification");
}

async function managedRecord(asset: PlanAsset, root: string): Promise<AssetRecord | undefined> {
  const parsed = parseAssetRecord(asset, { path: "plannedAsset" });
  try {
    const bytes = new Uint8Array(await readFile(resolve(root, parsed.localPath)));
    return bytes.byteLength === parsed.byteLength && sha256(bytes) === parsed.sha256 ? parsed : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function createProductionAssetPolicy(managedRoot: string): PipelineAssetPolicy {
  const registry = createAssetRegistry({ managedRoot });
  return {
    resolve: (asset) => managedRecord(asset, managedRoot),
    fallback: async (asset, context) => {
      const result = await createMissingAssetFallback({ plannedAsset: asset, reason: { code: "missing", detail: "managed asset is unavailable" }, theme: context.theme, registry, stagingRoot: context.stagingDirectory });
      if (result.status === "omitted") throw new TypeError(`missing decorative asset '${asset.id}' must be removed by the planner`);
      return result.asset;
    },
  };
}
