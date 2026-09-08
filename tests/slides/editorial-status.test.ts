import { expect, test } from "bun:test";

import type { SlidePlan } from "../../src/slides/model/plan.ts";
import {
  planTranscriptToSlides,
  type SlidePlannerCompletionRequest,
  type TranscriptSnapshot,
} from "../../src/slides/planning/planner.ts";
import { findEditorialStatusFailure } from "../../src/slides/planning/editorial-validation.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../../src/slides/theme/meeting-paper.ts";

type ModelPlanContent = Omit<SlidePlan, "planId" | "snapshot" | "createdAt" | "updatedAt" | "theme">;

const OPEN_CLAIM_ID = "open-error-rate";
const transcriptText = "출시 전 오류율 기준은 추가 확인이 필요합니다.";
const snapshot: TranscriptSnapshot = {
  state: "finalized",
  meetingId: 9,
  transcriptVersionId: "transcript-open-status",
  contentSha256: "b".repeat(64),
  lines: [{ seq: 1, speaker: "민아", text: transcriptText }],
  confirmedReview: {
    reviewId: "review-open-status",
    transcriptVersionId: "transcript-open-status",
    items: [{
      id: OPEN_CLAIM_ID,
      kind: "open_item",
      description: transcriptText,
      source: {
        transcriptVersionId: "transcript-open-status",
        startSeq: 1,
        endSeq: 1,
        evidenceQuote: transcriptText,
      },
      reviewState: "confirmed",
      attributedAttendeeId: null,
    }],
    attendees: [],
  },
};

function misleadingOpenItemPlan(): ModelPlanContent {
  const bind = [OPEN_CLAIM_ID];
  return {
    schemaVersion: 1,
    revision: 0,
    title: "출시 준비",
    claims: [{
      id: OPEN_CLAIM_ID,
      kind: "fact",
      text: transcriptText,
      sources: [{
        transcriptVersionId: "transcript-open-status",
        startSeq: 1,
        endSeq: 1,
        evidenceQuote: transcriptText,
      }],
      method: "reviewed",
    }],
    assets: [],
    slides: [
      {
        id: "opening", layout: "hero", storyRole: "opening", title: "출시 준비가 완료됐습니다",
        payload: { variant: "cover", statement: "오류율 기준 확정" },
        bindings: { title: bind, statement: bind }, editorialPaths: [], assetIds: [],
      },
      {
        id: "overview", layout: "summary", storyRole: "context", title: "품질 기준이 닫혔습니다",
        payload: { mode: "overview", items: ["오류율 기준 확정"] },
        bindings: { title: bind, "items[0]": bind }, editorialPaths: [], assetIds: [],
      },
      {
        id: "decision", layout: "decision", storyRole: "decision", title: "오류율 기준을 확정했습니다",
        payload: { decision: "품질 기준 확정", rationale: ["출시 준비 완료"] },
        bindings: { title: bind, decision: bind, "rationale[0]": bind },
        editorialPaths: [], assetIds: [],
      },
      {
        id: "comparison", layout: "comparison", storyRole: "argument", title: "기준 확정으로 준비를 닫습니다",
        payload: { sides: [{ label: "이전", items: ["기준 검토"] }, { label: "현재", items: ["기준 확정"] }] },
        bindings: { title: bind, "sides[0].items[0]": bind, "sides[1].items[0]": bind },
        editorialPaths: ["sides[0].label", "sides[1].label"], assetIds: [],
      },
      {
        id: "detail", layout: "hero", storyRole: "argument", title: "오류율 기준은 완료 상태입니다",
        payload: { variant: "statement", statement: "추가 검토 종료" },
        bindings: { title: bind, statement: bind }, editorialPaths: [], assetIds: [],
      },
      {
        id: "takeaways", layout: "summary", storyRole: "commitment", title: "품질 결정을 마쳤습니다",
        payload: { mode: "takeaways", items: ["오류율 기준 완료"] },
        bindings: { title: bind, "items[0]": bind }, editorialPaths: [], assetIds: [],
      },
      {
        id: "closing", layout: "decision", storyRole: "closing", title: "출시 기준이 모두 닫혔습니다",
        payload: { decision: "오류율 기준 확정", rationale: ["추가 확인 완료"] },
        bindings: { title: bind, decision: bind, "rationale[0]": bind },
        editorialPaths: [], assetIds: [],
      },
    ],
  };
}

function openStatusSlide(text: string): readonly SlidePlan["slides"][number][] {
  return [{
    id: "open-status", layout: "summary", storyRole: "argument", title: text,
    payload: { mode: "overview", items: [text] },
    bindings: { title: [OPEN_CLAIM_ID], "items[0]": [OPEN_CLAIM_ID] },
    editorialPaths: [], assetIds: [],
  }];
}

test("rejects presentation copy that turns a confirmed open item into a resolved outcome", async () => {
  // Given
  const calls: SlidePlannerCompletionRequest[] = [];
  const output = JSON.stringify(misleadingOpenItemPlan());
  const complete = async (request: SlidePlannerCompletionRequest): Promise<string> => {
    calls.push(request);
    return output;
  };

  // When
  let failure: unknown;
  try {
    await planTranscriptToSlides(snapshot, {
      complete,
      createId: () => "status-plan",
      now: () => "2026-08-31T00:00:00.000Z",
      theme: MEETING_PAPER_STYLE_PROFILE,
    });
  } catch (error) {
    failure = error;
  }

  // Then
  expect(calls).toHaveLength(2);
  expect(calls[1]?.validationFailure).toMatchObject({ kind: "editorial-status" });
  expect(failure).toMatchObject({ code: "model-output-invalid", attempts: 2 });
});

test.each([
  "오류율 기준",
  "완료 확인",
  "품질 검토",
])("rejects open-item copy without an explicit unresolved marker: %s", (text) => {
  expect(findEditorialStatusFailure(openStatusSlide(text), [OPEN_CLAIM_ID]))
    .toMatchObject({ path: "slides[0].title" });
});

test.each([
  "오류율 기준 확인 필요",
  "추가 확인이 남았습니다",
  "미확정",
  "확정되지 않음",
  "not completed",
  "still unresolved",
])("accepts explicit unresolved wording: %s", (text) => {
  expect(findEditorialStatusFailure(openStatusSlide(text), [OPEN_CLAIM_ID]))
    .toBeUndefined();
});
