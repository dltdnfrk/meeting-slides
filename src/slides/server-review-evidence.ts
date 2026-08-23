import type { ConfirmedReviewEvidence, ConfirmedReviewItem } from "./planning/planner.ts";

interface ReviewSummary {
  readonly reviewId: string;
  readonly meetingId: number;
  readonly transcriptVersionId: string;
  readonly status: "draft" | "confirmed";
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be non-empty`);
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isInteger(value)) throw new TypeError(`${path} must be an integer`);
  return value as number;
}

function confirmedItem(value: Record<string, unknown>, index: number): ConfirmedReviewItem {
  const path = `reviewItems[${index}]`;
  const kind = value.kind;
  if (kind !== "decision" && kind !== "action_item" && kind !== "open_item") {
    throw new TypeError(`${path}.kind is invalid`);
  }
  const source = record(value.source, `${path}.source`);
  return {
    id: text(value.id, `${path}.id`),
    kind,
    description: text(value.description, `${path}.description`),
    source: {
      transcriptVersionId: text(source.transcriptVersionId, `${path}.source.transcriptVersionId`),
      startSeq: integer(source.startSeq, `${path}.source.startSeq`),
      endSeq: integer(source.endSeq, `${path}.source.endSeq`),
      evidenceQuote: text(value.evidenceQuote, `${path}.evidenceQuote`),
    },
    reviewState: "confirmed",
  };
}

export function confirmedReviewEvidence(
  review: ReviewSummary | null,
  rawItems: readonly unknown[],
  transcriptVersionId: string,
): ConfirmedReviewEvidence | undefined {
  if (review === null || review.status === "draft") return undefined;
  if (review.transcriptVersionId !== transcriptVersionId) {
    throw new TypeError("confirmed Review transcript version does not match the canonical transcript");
  }
  const items: ConfirmedReviewItem[] = [];
  for (const [index, raw] of rawItems.entries()) {
    const item = record(raw, `reviewItems[${index}]`);
    if (item.reviewState === "rejected") continue;
    if (item.reviewState === "candidate") {
      throw new TypeError(`confirmed Review contains candidate item '${String(item.id)}'`);
    }
    if (item.reviewState !== "confirmed") {
      throw new TypeError(`reviewItems[${index}].reviewState is invalid`);
    }
    items.push(confirmedItem(item, index));
  }
  return Object.freeze({
    reviewId: review.reviewId,
    transcriptVersionId,
    items: Object.freeze(items),
  });
}
