import type { ClaimKind, SlidePlan, SourceRange } from "../model/plan.ts";
import type { TranscriptSnapshot } from "./planner.ts";
import type { ConfirmedReviewItem } from "./review-evidence.ts";

export interface EvidenceMismatch {
  readonly claimId: string;
  readonly sourceIndex?: number;
  readonly startSeq?: number;
  readonly endSeq?: number;
  readonly reason: "range-not-contiguous" | "quote-not-verbatim" |
    "review-item-omitted" | "review-claim-invented" | "review-identity-changed";
}

const REVIEW_KIND: Readonly<Record<ConfirmedReviewItem["kind"], ClaimKind>> = Object.freeze({
  decision: "decision",
  action_item: "action",
  open_item: "fact",
});

function sameSource(left: SourceRange, right: SourceRange): boolean {
  return left.transcriptVersionId === right.transcriptVersionId &&
    left.startSeq === right.startSeq && left.endSeq === right.endSeq &&
    left.evidenceQuote === right.evidenceQuote;
}

function confirmedDueText(item: ConfirmedReviewItem): string | undefined {
  if (typeof item.deadlineText === "string") return item.deadlineText;
  if (typeof item.deadline === "string") return item.deadline;
  return undefined;
}

function findActionOwnerDueMismatch(
  plan: SlidePlan,
  item: ConfirmedReviewItem,
  names: ReadonlyMap<string, string>,
): EvidenceMismatch | undefined {
  if (item.kind !== "action_item") return undefined;
  const expectedOwner = typeof item.assigneeAttendeeId === "string"
    ? names.get(item.assigneeAttendeeId)
    : undefined;
  if (typeof item.assigneeAttendeeId === "string" && expectedOwner === undefined) {
    return { claimId: item.id, reason: "review-identity-changed" };
  }
  const expectedDue = confirmedDueText(item);
  if (expectedOwner === undefined && expectedDue === undefined) return undefined;
  for (const slide of plan.slides) {
    if (slide.layout !== "actions") continue;
    for (const [index, row] of slide.payload.items.entries()) {
      const taskBound = slide.bindings[`items[${index}].task`]?.includes(item.id) === true;
      const ownerBound = slide.bindings[`items[${index}].owner`]?.includes(item.id) === true;
      const dueBound = slide.bindings[`items[${index}].due`]?.includes(item.id) === true;
      if (!taskBound && !ownerBound && !dueBound) continue;
      if (expectedOwner !== undefined && (!ownerBound || row.owner !== expectedOwner)) {
        return { claimId: item.id, reason: "review-identity-changed" };
      }
      if (expectedDue !== undefined && (!dueBound || row.due !== expectedDue)) {
        return { claimId: item.id, reason: "review-identity-changed" };
      }
    }
  }
  return undefined;
}

function findReviewMismatch(plan: SlidePlan, snapshot: TranscriptSnapshot): EvidenceMismatch | undefined {
  const review = snapshot.confirmedReview;
  if (review === undefined) return undefined;
  const items = new Map(review.items.map((item) => [item.id, item] as const));
  const names = new Map(
    (review.attendees ?? []).map((attendee) => [attendee.attendeeId, attendee.displayName] as const),
  );
  for (const item of review.items) {
    const claim = plan.claims.find((candidate) => candidate.id === item.id);
    if (claim === undefined) return { claimId: item.id, reason: "review-item-omitted" };
    if (claim.method !== "reviewed" || claim.kind !== REVIEW_KIND[item.kind] ||
        claim.text !== item.description || claim.sources.length !== 1 ||
        !sameSource(claim.sources[0]!, item.source)) {
      return { claimId: item.id, reason: "review-identity-changed" };
    }
    const ownerDue = findActionOwnerDueMismatch(plan, item, names);
    if (ownerDue !== undefined) return ownerDue;
  }
  const invented = plan.claims.find((claim) => claim.method === "reviewed" && !items.has(claim.id));
  return invented === undefined ? undefined : {
    claimId: invented.id,
    reason: "review-claim-invented",
  };
}

export function findEvidenceMismatch(
  plan: SlidePlan,
  snapshot: TranscriptSnapshot,
): EvidenceMismatch | undefined {
  const bySeq = new Map(snapshot.lines.map((line) => [line.seq, line] as const));
  for (const claim of plan.claims) {
    for (let sourceIndex = 0; sourceIndex < claim.sources.length; sourceIndex += 1) {
      const source = claim.sources[sourceIndex]!;
      const texts: string[] = [];
      let contiguous = true;
      for (let seq = source.startSeq; seq <= source.endSeq; seq += 1) {
        const line = bySeq.get(seq);
        if (line === undefined) {
          contiguous = false;
          break;
        }
        texts.push(line.text);
      }
      if (!contiguous) {
        return {
          claimId: claim.id,
          sourceIndex,
          startSeq: source.startSeq,
          endSeq: source.endSeq,
          reason: "range-not-contiguous",
        };
      }
      if (!texts.join("\n").includes(source.evidenceQuote)) {
        return {
          claimId: claim.id,
          sourceIndex,
          startSeq: source.startSeq,
          endSeq: source.endSeq,
          reason: "quote-not-verbatim",
        };
      }
    }
  }
  return findReviewMismatch(plan, snapshot);
}
