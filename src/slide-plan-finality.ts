import type { Database } from "bun:sqlite";
import { canonicalLinesFromRows, hashCanonicalTranscript } from "./canonical-transcript.ts";

import type { SlidePlan, SnapshotIdentity } from "./slides/model/plan.ts";
import type { PipelineIdentity, SlidePlanFinalityReceipt } from "./slides/server-pipeline-types.ts";

const SHA256 = /^[a-f0-9]{64}$/;

export class SlidePlanFinalityError extends Error {
  readonly name = "SlidePlanFinalityError";

  constructor(readonly reason: string) {
    super(`publication finality rejected: ${reason}`);
  }
}

type ReviewRow = {
  readonly meeting_id: number;
  readonly transcript_version_id: string;
  readonly status: string;
  readonly confirmed_at: number | null;
};

type CanonicalRow = {
  readonly transcript_version_id: string;
  readonly content_sha256: string | null;
  readonly finalized_at: number | null;
};

type TranscriptLine = {
  readonly seq: number;
  readonly captured_at_ms: number | null;
  readonly speaker_turn: number | null;
  readonly text: string;
};

function parseObject(value: string, label: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`${label} must be valid JSON`);
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new TypeError(`${label} must contain one JSON object`);
  }
  return decoded as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function equal(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

export function assertHash(value: string, label: string): void {
  if (!SHA256.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`);
}

export function assertIdentity(plan: SlidePlan, identity: PipelineIdentity): void {
  if (identity.planId !== plan.planId || !equal(identity.snapshot, plan.snapshot) ||
      !equal(identity.slideIds, plan.slides.map((slide) => slide.id)) ||
      !equal(identity.claimIds, plan.claims.map((entry) => entry.id))) {
    throw new TypeError("publication identity does not match SlidePlan identity");
  }
  if (typeof identity.deckId !== "string" || identity.deckId.length === 0 ||
      !Array.isArray(identity.geometryIds) || identity.geometryIds.length !== plan.slides.length) {
    throw new TypeError("publication identity metadata is invalid");
  }
  const reviewItems = identity.reviewedItemIds;
  if ((identity.reviewId === undefined) !== (reviewItems === undefined) ||
      (identity.reviewId !== undefined && identity.reviewId.length === 0) ||
      (reviewItems !== undefined && (reviewItems.some((id) => typeof id !== "string" || id.length === 0) ||
        JSON.stringify(reviewItems) !== JSON.stringify([...reviewItems].sort())))) {
    throw new TypeError("publication review identity is invalid or unsorted");
  }
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function stringArray(record: Record<string, unknown>, key: string, label: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new TypeError(`${label} must be a string array`);
  }
  return Object.freeze([...value]);
}

export function decodeIdentity(value: string): PipelineIdentity {
  const parsed = parseObject(value, "persisted identity");
  const snapshotValue = parsed.snapshot;
  if (typeof snapshotValue !== "object" || snapshotValue === null || Array.isArray(snapshotValue)) {
    throw new TypeError("persisted identity snapshot must be one object");
  }
  const snapshot = snapshotValue as Record<string, unknown>;
  const meetingId = snapshot.meetingId;
  const lineCount = snapshot.lineCount;
  if (!Number.isSafeInteger(meetingId) || !Number.isSafeInteger(lineCount) ||
      (meetingId as number) <= 0 || (lineCount as number) < 0) {
    throw new TypeError("persisted identity snapshot counts are invalid");
  }
  const parsedSnapshot: SnapshotIdentity = {
    meetingId: meetingId as number,
    transcriptVersionId: requiredString(snapshot, "transcriptVersionId", "persisted transcript version"),
    contentSha256: requiredString(snapshot, "contentSha256", "persisted transcript hash"),
    lineCount: lineCount as number,
  };
  assertHash(parsedSnapshot.contentSha256, "persisted transcript hash");
  const hasReview = parsed.reviewId !== undefined || parsed.reviewedItemIds !== undefined;
  return Object.freeze({
    planId: requiredString(parsed, "planId", "persisted planId"),
    deckId: requiredString(parsed, "deckId", "persisted deckId"),
    snapshot: Object.freeze(parsedSnapshot),
    slideIds: stringArray(parsed, "slideIds", "persisted slideIds"),
    geometryIds: stringArray(parsed, "geometryIds", "persisted geometryIds"),
    claimIds: stringArray(parsed, "claimIds", "persisted claimIds"),
    ...(hasReview ? {
      reviewId: requiredString(parsed, "reviewId", "persisted reviewId"),
      reviewedItemIds: stringArray(parsed, "reviewedItemIds", "persisted reviewedItemIds"),
    } : {}),
  });
}

export function decodeStringArray(value: string | null): readonly string[] | undefined {
  if (value === null) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new TypeError("persisted review identity must be a string array");
  }
  return Object.freeze([...parsed]);
}

export function decodeReceipt(value: string | null): SlidePlanFinalityReceipt | undefined {
  if (value === null) return undefined;
  const parsed = parseObject(value, "persisted finality receipt");
  const confirmedAt = parsed.confirmedAt;
  if (!Number.isSafeInteger(confirmedAt) || (confirmedAt as number) <= 0) {
    throw new TypeError("persisted finality receipt confirmedAt is invalid");
  }
  const reviewedItemIds = stringArray(parsed, "reviewedItemIds", "persisted finality reviewedItemIds");
  const receipt = {
    reviewId: requiredString(parsed, "reviewId", "persisted finality reviewId"),
    confirmedAt: confirmedAt as number,
    transcriptVersionId: requiredString(parsed, "transcriptVersionId", "persisted finality transcript version"),
    contentSha256: requiredString(parsed, "contentSha256", "persisted finality content hash"),
    reviewedItemIds,
  };
  assertHash(receipt.contentSha256, "persisted finality content hash");
  return Object.freeze(receipt);
}

function tableExists(database: Database, name: string): boolean {
  return database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

function reviewedItemIds(database: Database, reviewId: string): readonly string[] {
  const tables = [
    ["decisions", "decision_id"],
    ["action_items", "action_item_id"],
    ["open_items", "open_item_id"],
  ] as const;
  const ids: string[] = [];
  for (const [table, idColumn] of tables) {
    if (!tableExists(database, table)) throw new SlidePlanFinalityError(`same database is missing ${table}`);
    const rows = database.query(
      `SELECT ${idColumn} AS id FROM ${table} WHERE review_id = ? AND review_state = 'confirmed'`,
    ).all(reviewId) as Array<{ readonly id: string }>;
    ids.push(...rows.map(({ id }) => id));
  }
  ids.sort();
  return Object.freeze(ids);
}

export function deriveFinalityReceipt(database: Database, identity: PipelineIdentity): SlidePlanFinalityReceipt {
  if (identity.reviewId === undefined || identity.reviewedItemIds === undefined) {
    throw new SlidePlanFinalityError("final publication identity is incomplete");
  }
  for (const table of ["meetings", "meeting_reviews", "meeting_transcript_state", "transcript_versions", "transcript_version_lines"] as const) {
    if (!tableExists(database, table)) throw new SlidePlanFinalityError(`same database is missing ${table}`);
  }
  if (database.query("SELECT 1 FROM meetings WHERE id = ?").get(identity.snapshot.meetingId) === null) {
    throw new SlidePlanFinalityError("meeting does not exist");
  }
  const review = database.query(`SELECT meeting_id, transcript_version_id, status, confirmed_at
    FROM meeting_reviews WHERE review_id = ?`).get(identity.reviewId) as ReviewRow | null;
  if (review === null) throw new SlidePlanFinalityError("Review does not exist in the same database");
  if (review.meeting_id !== identity.snapshot.meetingId) throw new SlidePlanFinalityError("Review belongs to another meeting");
  if (review.status !== "confirmed" || review.confirmed_at === null || !Number.isSafeInteger(review.confirmed_at) || review.confirmed_at <= 0) {
    throw new SlidePlanFinalityError("Review is not confirmed");
  }
  if (review.transcript_version_id !== identity.snapshot.transcriptVersionId) {
    throw new SlidePlanFinalityError("Review transcript version drifted");
  }
  const canonical = database.query(`SELECT tv.transcript_version_id, tv.content_sha256, tv.finalized_at
    FROM meeting_transcript_state state
    JOIN transcript_versions tv
      ON tv.meeting_id = state.meeting_id
     AND tv.transcript_version_id = state.canonical_transcript_version_id
    WHERE state.meeting_id = ?`).get(identity.snapshot.meetingId) as CanonicalRow | null;
  if (canonical === null || canonical.transcript_version_id !== identity.snapshot.transcriptVersionId) {
    throw new SlidePlanFinalityError("canonical transcript version drifted");
  }
  if (canonical.finalized_at === null || canonical.content_sha256 === null) {
    throw new SlidePlanFinalityError("canonical transcript is not finalized");
  }
  const lines = database.query(`SELECT seq, captured_at_ms, speaker_turn, text
    FROM transcript_version_lines WHERE meeting_id = ? AND transcript_version_id = ? ORDER BY seq`).all(
      identity.snapshot.meetingId,
      identity.snapshot.transcriptVersionId,
    ) as TranscriptLine[];
  const actualHash = hashCanonicalTranscript(canonicalLinesFromRows(lines));
  if (actualHash !== canonical.content_sha256 || actualHash !== identity.snapshot.contentSha256) {
    throw new SlidePlanFinalityError("canonical transcript content hash drifted");
  }
  const itemIds = reviewedItemIds(database, identity.reviewId);
  if (JSON.stringify(itemIds) !== JSON.stringify(identity.reviewedItemIds)) {
    throw new SlidePlanFinalityError("reviewed item set does not match finality receipt");
  }
  return Object.freeze({
    reviewId: identity.reviewId,
    confirmedAt: review.confirmed_at,
    transcriptVersionId: canonical.transcript_version_id,
    contentSha256: actualHash,
    reviewedItemIds: itemIds,
  });
}

export function stableFinalityReceiptJson(receipt: SlidePlanFinalityReceipt): string {
  return `${JSON.stringify(receipt)}\n`;
}
