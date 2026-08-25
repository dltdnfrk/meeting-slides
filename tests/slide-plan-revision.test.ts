import { describe, expect, test } from "bun:test";

import { validateSlidePlanRevision } from "../src/slide-plan-revision.ts";
import type { StoredSlidePlanPublication } from "../src/slide-plan-store.ts";
import type { SlidePlan } from "../src/slides/model/plan.ts";
import type { SlidePlanTranscriptInput } from "../src/slides/server-action.ts";

const plan = (revision: number, planId = "plan-stable") => ({ planId, revision }) as SlidePlan;
const source = (reviewId?: string, reviewedItemIds?: string[]) => ({
  plan: plan(3), revision: 3, reviewId, reviewedItemIds,
}) as StoredSlidePlanPublication;
const transcript = (reviewId?: string, itemIds?: string[]): SlidePlanTranscriptInput => ({
  state: "live", lines: [{ seq: 1, speaker: null, text: "회의 근거" }],
  ...(reviewId === undefined ? {} : {
    confirmedReview: {
      reviewId, transcriptVersionId: "transcript-v1",
      items: (itemIds ?? []).map((id) => ({
        id, kind: "decision" as const, description: id,
        source: { transcriptVersionId: "transcript-v1", startSeq: 1, endSeq: 1, evidenceQuote: id },
        reviewState: "confirmed" as const,
      })),
    },
  }),
});

describe("SlidePlan revision boundary", () => {
  test("accepts only a newer revision with the exact source Review lineage", () => {
    expect(() => validateSlidePlanRevision(source("review-a", ["item-a"]), plan(4), transcript("review-a", ["item-a"]))).not.toThrow();
    expect(() => validateSlidePlanRevision(source("review-a", ["item-a"]), plan(3), transcript("review-a", ["item-a"]))).toThrow("오래된");
    expect(() => validateSlidePlanRevision(source("review-a", ["item-a"]), plan(4), transcript("review-b", ["item-a"]))).toThrow("Review가 변경");
    expect(() => validateSlidePlanRevision(source("review-a", ["item-a"]), plan(4), transcript("review-a", ["item-b"]))).toThrow("Review가 변경");
  });

  test("rejects missing or mismatched source publication identity", () => {
    expect(() => validateSlidePlanRevision(null, plan(4), transcript())).toThrow("원본");
    expect(() => validateSlidePlanRevision(source(), plan(4, "other-plan"), transcript())).toThrow("identity");
  });
});
