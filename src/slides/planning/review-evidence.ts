export type ConfirmedReviewItemKind = "decision" | "action_item" | "open_item";

export interface ConfirmedReviewAttendee {
  readonly attendeeId: string;
  readonly displayName: string;
}

export interface ConfirmedReviewItem {
  readonly id: string;
  readonly kind: ConfirmedReviewItemKind;
  readonly description: string;
  readonly source: Readonly<{
    transcriptVersionId: string;
    startSeq: number;
    endSeq: number;
    evidenceQuote: string;
  }>;
  readonly reviewState: "confirmed";
  readonly assigneeAttendeeId?: string | null;
  readonly deadline?: string | null;
  readonly deadlineText?: string | null;
  readonly attributedAttendeeId?: string | null;
}

export interface ConfirmedReviewSummaryTopic {
  readonly title: string;
  readonly summary: string;
  readonly source: Readonly<{
    transcriptVersionId: string;
    startSeq: number;
    endSeq: number;
  }>;
}

export interface ConfirmedReviewSummary {
  readonly overview: string;
  readonly topics: readonly ConfirmedReviewSummaryTopic[];
}

export interface ConfirmedReviewEvidence {
  readonly reviewId: string;
  readonly transcriptVersionId: string;
  readonly items: readonly ConfirmedReviewItem[];
  readonly attendees?: readonly ConfirmedReviewAttendee[];
  readonly summary?: ConfirmedReviewSummary;
}

interface ReviewSnapshot {
  readonly transcriptVersionId: string;
  readonly lines: readonly { readonly seq: number; readonly text: string }[];
  readonly confirmedReview?: ConfirmedReviewEvidence;
}

const ITEM_OPTIONAL = ["assigneeAttendeeId", "deadline", "deadlineText", "attributedAttendeeId"] as const;

function assertStableId(value: string, path: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new TypeError(`${path} must be a stable ID`);
  }
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

function hasAllowedKeys(value: object, required: readonly string[], optional: readonly string[]): boolean {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => actual.includes(key)) && actual.every((key) => allowed.has(key));
}

function assertOptionalNullableId(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") throw new TypeError(`${path} must be a stable ID or null`);
  assertStableId(value, path);
}

function assertOptionalNullableText(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${path} must be a non-empty string or null`);
  }
}

function validateAttendees(attendees: unknown): void {
  if (attendees === undefined) return;
  if (!Array.isArray(attendees)) throw new TypeError("confirmedReview.attendees must be an array");
  const ids = new Set<string>();
  for (const [index, attendee] of attendees.entries()) {
    const path = `confirmedReview.attendees[${index}]`;
    if (typeof attendee !== "object" || attendee === null ||
        !hasExactKeys(attendee, ["attendeeId", "displayName"])) {
      throw new TypeError(`${path} must have attendeeId and displayName`);
    }
    assertStableId(attendee.attendeeId, `${path}.attendeeId`);
    if (typeof attendee.displayName !== "string" || attendee.displayName.trim() === "") {
      throw new TypeError(`${path}.displayName must be non-empty`);
    }
    if (ids.has(attendee.attendeeId)) throw new TypeError(`${path}.attendeeId must be unique`);
    ids.add(attendee.attendeeId);
  }
}

function validateSummary(summary: ConfirmedReviewEvidence["summary"], snapshot: ReviewSnapshot): void {
  if (summary === undefined) return;
  if (typeof summary !== "object" || summary === null ||
      !hasExactKeys(summary, ["overview", "topics"])) {
    throw new TypeError("confirmedReview.summary must have overview and topics");
  }
  if (typeof summary.overview !== "string" || summary.overview.trim() === "") {
    throw new TypeError("confirmedReview.summary.overview must be non-empty");
  }
  if (!Array.isArray(summary.topics)) {
    throw new TypeError("confirmedReview.summary.topics must be an array");
  }
  const bySeq = new Map(snapshot.lines.map((line) => [line.seq, line.text] as const));
  for (const [index, topic] of summary.topics.entries()) {
    const path = `confirmedReview.summary.topics[${index}]`;
    if (typeof topic !== "object" || topic === null ||
        !hasExactKeys(topic, ["title", "summary", "source"])) {
      throw new TypeError(`${path} must have title, summary, and source`);
    }
    if (typeof topic.title !== "string" || topic.title.trim() === "" ||
        typeof topic.summary !== "string" || topic.summary.trim() === "") {
      throw new TypeError(`${path} must have a title and summary`);
    }
    const source = topic.source;
    if (typeof source !== "object" || source === null ||
        !hasExactKeys(source, ["transcriptVersionId", "startSeq", "endSeq"]) ||
        source.transcriptVersionId !== snapshot.transcriptVersionId ||
        !Number.isInteger(source.startSeq) || !Number.isInteger(source.endSeq) ||
        source.startSeq < 1 || source.endSeq < source.startSeq) {
      throw new TypeError(`${path} is ungrounded`);
    }
    for (let seq = source.startSeq; seq <= source.endSeq; seq += 1) {
      if (!bySeq.has(seq)) throw new TypeError(`${path} is ungrounded`);
    }
  }
}

export function validateConfirmedReview(snapshot: ReviewSnapshot): void {
  const review = snapshot.confirmedReview;
  if (review === undefined) return;
  if (typeof review !== "object" || review === null ||
      !hasAllowedKeys(review, ["reviewId", "transcriptVersionId", "items"], ["attendees", "summary"])) {
    throw new TypeError("confirmedReview must have the exact evidence shape");
  }
  assertStableId(review.reviewId, "confirmedReview.reviewId");
  if (review.transcriptVersionId !== snapshot.transcriptVersionId) {
    throw new TypeError("confirmedReview transcriptVersionId must match the snapshot");
  }
  if (!Array.isArray(review.items)) throw new TypeError("confirmedReview.items must be an array");
  validateAttendees(review.attendees);
  validateSummary(review.summary, snapshot);
  const ids = new Set<string>();
  const attendeeIds = new Set((review.attendees ?? []).map((attendee) => attendee.attendeeId));
  const bySeq = new Map(snapshot.lines.map((line) => [line.seq, line.text] as const));
  for (const [index, item] of review.items.entries()) {
    const path = `confirmedReview.items[${index}]`;
    if (typeof item !== "object" || item === null ||
        !hasAllowedKeys(item, ["id", "kind", "description", "source", "reviewState"], ITEM_OPTIONAL)) {
      throw new TypeError(`${path} must have the exact confirmed-item shape`);
    }
    assertStableId(item.id, `${path}.id`);
    if (ids.has(item.id)) throw new TypeError(`${path}.id must be unique`);
    ids.add(item.id);
    if (!["decision", "action_item", "open_item"].includes(item.kind)) {
      throw new TypeError(`${path}.kind is invalid`);
    }
    if (typeof item.description !== "string" || item.description.trim() === "" ||
        item.reviewState !== "confirmed") {
      throw new TypeError(`${path} must be a confirmed item with a description`);
    }
    assertOptionalNullableId(item.assigneeAttendeeId, `${path}.assigneeAttendeeId`);
    assertOptionalNullableText(item.deadline, `${path}.deadline`);
    assertOptionalNullableText(item.deadlineText, `${path}.deadlineText`);
    assertOptionalNullableId(item.attributedAttendeeId, `${path}.attributedAttendeeId`);
    if (typeof item.assigneeAttendeeId === "string" &&
        !attendeeIds.has(item.assigneeAttendeeId)) {
      throw new TypeError(`${path}.assigneeAttendeeId must reference a confirmed attendee`);
    }
    if (typeof item.attributedAttendeeId === "string" &&
        !attendeeIds.has(item.attributedAttendeeId)) {
      throw new TypeError(`${path}.attributedAttendeeId must reference a confirmed attendee`);
    }
    const source = item.source;
    if (typeof source !== "object" || source === null ||
        !hasExactKeys(source, ["transcriptVersionId", "startSeq", "endSeq", "evidenceQuote"]) ||
        source.transcriptVersionId !== snapshot.transcriptVersionId ||
        !Number.isInteger(source.startSeq) || !Number.isInteger(source.endSeq) ||
        source.startSeq < 1 || source.endSeq < source.startSeq ||
        typeof source.evidenceQuote !== "string" || source.evidenceQuote === "") {
      throw new TypeError(`${path}.source is invalid for the snapshot`);
    }
    const text: string[] = [];
    for (let seq = source.startSeq; seq <= source.endSeq; seq += 1) {
      const line = bySeq.get(seq);
      if (line === undefined) throw new TypeError(`${path}.source range is not contiguous`);
      text.push(line);
    }
    if (!text.join("\n").includes(source.evidenceQuote)) {
      throw new TypeError(`${path}.source quote is not verbatim`);
    }
  }
}
