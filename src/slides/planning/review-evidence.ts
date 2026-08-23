export type ConfirmedReviewItemKind = "decision" | "action_item" | "open_item";

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
}

export interface ConfirmedReviewEvidence {
  readonly reviewId: string;
  readonly transcriptVersionId: string;
  readonly items: readonly ConfirmedReviewItem[];
}

interface ReviewSnapshot {
  readonly transcriptVersionId: string;
  readonly lines: readonly { readonly seq: number; readonly text: string }[];
  readonly confirmedReview?: ConfirmedReviewEvidence;
}

function assertStableId(value: string, path: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new TypeError(`${path} must be a stable ID`);
  }
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

export function validateConfirmedReview(snapshot: ReviewSnapshot): void {
  const review = snapshot.confirmedReview;
  if (review === undefined) return;
  if (typeof review !== "object" || review === null ||
      !hasExactKeys(review, ["reviewId", "transcriptVersionId", "items"])) {
    throw new TypeError("confirmedReview must have the exact evidence shape");
  }
  assertStableId(review.reviewId, "confirmedReview.reviewId");
  if (review.transcriptVersionId !== snapshot.transcriptVersionId) {
    throw new TypeError("confirmedReview transcriptVersionId must match the snapshot");
  }
  if (!Array.isArray(review.items)) throw new TypeError("confirmedReview.items must be an array");
  const ids = new Set<string>();
  const bySeq = new Map(snapshot.lines.map((line) => [line.seq, line.text] as const));
  for (const [index, item] of review.items.entries()) {
    const path = `confirmedReview.items[${index}]`;
    if (typeof item !== "object" || item === null ||
        !hasExactKeys(item, ["id", "kind", "description", "source", "reviewState"])) {
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
