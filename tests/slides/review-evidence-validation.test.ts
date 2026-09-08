import { expect, test } from "bun:test";

import { validateConfirmedReview } from "../../src/slides/planning/review-evidence.ts";

test("rejects an action assignee absent from confirmed Review attendees", () => {
  const snapshot = {
    transcriptVersionId: "transcript-review",
    lines: [{ seq: 1, text: "김현준이 릴리스 노트를 준비합니다." }],
    confirmedReview: {
      reviewId: "review-1",
      transcriptVersionId: "transcript-review",
      attendees: [],
      items: [{
        id: "action-1",
        kind: "action_item" as const,
        description: "릴리스 노트 준비",
        source: {
          transcriptVersionId: "transcript-review",
          startSeq: 1,
          endSeq: 1,
          evidenceQuote: "김현준이 릴리스 노트를 준비합니다.",
        },
        reviewState: "confirmed" as const,
        assigneeAttendeeId: "attendee-missing",
      }],
    },
  };

  expect(() => validateConfirmedReview(snapshot))
    .toThrow("assigneeAttendeeId must reference a confirmed attendee");
});
