import type { StoredSlidePlanPublication } from "./slide-plan-store.ts";
import type { SlidePlan } from "./slides/model/plan.ts";
import type { SlidePlanTranscriptInput } from "./slides/server-action.ts";

function sameStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Enforces optimistic concurrency and evidence lineage before a human revision is published. */
export function validateSlidePlanRevision(
  source: StoredSlidePlanPublication | null,
  plan: SlidePlan,
  transcript: SlidePlanTranscriptInput,
): void {
  if (source === null) throw new Error("편집 원본 SlidePlan publication을 찾을 수 없습니다");
  if (source.plan.planId !== plan.planId) throw new Error("SlidePlan identity가 편집 원본과 다릅니다");
  if (plan.revision <= source.revision) {
    throw new Error(`오래된 SlidePlan revision입니다: current=${source.revision}, requested=${plan.revision}`);
  }
  const reviewId = transcript.confirmedReview?.reviewId;
  const itemIds = transcript.confirmedReview?.items.map((item) => item.id);
  if (source.reviewId !== reviewId || !sameStrings(source.reviewedItemIds, itemIds)) {
    throw new Error("확정된 Review가 변경되어 슬라이드를 다시 생성해야 합니다");
  }
}
