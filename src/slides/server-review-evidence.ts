import type { ConfirmedReviewEvidence, ConfirmedReviewItem } from "./planning/planner.ts";
import type { ConfirmedReviewSummary } from "./planning/review-evidence.ts";

interface ReviewSummary {
  readonly reviewId: string;
  readonly meetingId: number;
  readonly transcriptVersionId: string;
  readonly status: "draft" | "confirmed";
  readonly confirmedAt?: number | null;
  readonly summary?: unknown;
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

function nullableText(value: unknown, path: string): string | null {
  if (value === null) return null;
  return text(value, path);
}

function optionalNullableText(
  value: Record<string, unknown>,
  key: "assigneeAttendeeId" | "deadline" | "deadlineText" | "attributedAttendeeId",
  path: string,
): string | null | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  return nullableText(value[key], `${path}.${key}`);
}

function confirmedAttendee(value: unknown, index: number): {
  readonly attendeeId: string;
  readonly displayName: string;
} {
  const path = `attendees[${index}]`;
  const attendee = record(value, path);
  return {
    attendeeId: text(attendee.attendeeId, `${path}.attendeeId`),
    displayName: text(attendee.displayName, `${path}.displayName`),
  };
}

function confirmedTopic(
  value: unknown,
  index: number,
  transcriptVersionId: string,
): ConfirmedReviewSummary["topics"][number] {
  const path = `summary.topics[${index}]`;
  const topic = record(value, path);
  const source = record(topic.source, `${path}.source`);
  const grounded = {
    transcriptVersionId: text(source.transcript_version_id, `${path}.source.transcript_version_id`),
    startSeq: integer(source.start_seq, `${path}.source.start_seq`),
    endSeq: integer(source.end_seq, `${path}.source.end_seq`),
  };
  if (grounded.transcriptVersionId !== transcriptVersionId ||
      grounded.startSeq < 1 || grounded.endSeq < grounded.startSeq) {
    throw new TypeError(`${path} is ungrounded`);
  }
  return {
    title: text(topic.title, `${path}.title`),
    summary: text(topic.summary, `${path}.summary`),
    source: grounded,
  };
}

function confirmedSummary(value: unknown, transcriptVersionId: string): ConfirmedReviewSummary | undefined {
  if (value === undefined || value === null) return undefined;
  const summary = record(value, "summary");
  if (!Array.isArray(summary.topics)) throw new TypeError("summary.topics must be an array");
  const topics = summary.topics.map((topic, index) => confirmedTopic(topic, index, transcriptVersionId));
  topics.sort((left, right) =>
    left.source.startSeq - right.source.startSeq || left.source.endSeq - right.source.endSeq);
  return {
    overview: text(summary.overview, "summary.overview"),
    topics: Object.freeze(topics),
  };
}

function confirmedItem(value: Record<string, unknown>, index: number): ConfirmedReviewItem {
  const path = `reviewItems[${index}]`;
  const kind = value.kind;
  if (kind !== "decision" && kind !== "action_item" && kind !== "open_item") {
    throw new TypeError(`${path}.kind is invalid`);
  }
  const source = record(value.source, `${path}.source`);
  const assigneeAttendeeId = optionalNullableText(value, "assigneeAttendeeId", path);
  const deadline = optionalNullableText(value, "deadline", path);
  const deadlineText = optionalNullableText(value, "deadlineText", path);
  const attributedAttendeeId = optionalNullableText(value, "attributedAttendeeId", path);
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
    ...(assigneeAttendeeId === undefined ? {} : { assigneeAttendeeId }),
    ...(deadline === undefined ? {} : { deadline }),
    ...(deadlineText === undefined ? {} : { deadlineText }),
    ...(attributedAttendeeId === undefined ? {} : { attributedAttendeeId }),
  };
}

export function confirmedReviewEvidence(
  review: ReviewSummary | null,
  rawItems: readonly unknown[],
  transcriptVersionId: string,
  rawAttendees: readonly unknown[] = [],
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
  const attendees = rawAttendees.map((raw, index) => confirmedAttendee(raw, index));
  const summary = confirmedSummary(review.summary, transcriptVersionId);
  const evidence = {
    reviewId: review.reviewId,
    transcriptVersionId,
    items: Object.freeze(items),
    ...(attendees.length === 0 ? {} : { attendees: Object.freeze(attendees) }),
    ...(summary === undefined ? {} : { summary: Object.freeze(summary) }),
  };
  if (review.confirmedAt !== undefined && review.confirmedAt !== null) {
    if (!Number.isSafeInteger(review.confirmedAt) || review.confirmedAt <= 0) {
      throw new TypeError("confirmed Review confirmedAt must be a positive integer");
    }
    Object.defineProperty(evidence, "confirmedAt", { value: review.confirmedAt });
  }
  return Object.freeze(evidence);
}
