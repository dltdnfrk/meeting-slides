import { describe, expect, test } from "bun:test";

import { confirmedReviewEvidence } from "../../src/slides/server-review-evidence.ts";

const source = {
  transcriptVersionId: "transcript-v1",
  startSeq: 2,
  endSeq: 3,
};

describe("server confirmed Review evidence boundary", () => {
  test("keeps only confirmed items with exact source evidence", () => {
    const evidence = confirmedReviewEvidence(
      {
        reviewId: "review-1",
        meetingId: 9,
        transcriptVersionId: "transcript-v1",
        status: "confirmed",
      },
      [
        {
          id: "decision-1",
          kind: "decision",
          description: "Ship Friday",
          evidenceQuote: "Ship Friday",
          source,
          reviewState: "confirmed",
        },
        {
          id: "open-1",
          kind: "open_item",
          description: "Rejected question",
          evidenceQuote: "question",
          source,
          reviewState: "rejected",
        },
      ],
      "transcript-v1",
    );

    expect(evidence).toEqual({
      reviewId: "review-1",
      transcriptVersionId: "transcript-v1",
      items: [{
        id: "decision-1",
        kind: "decision",
        description: "Ship Friday",
        source: { ...source, evidenceQuote: "Ship Friday" },
        reviewState: "confirmed",
      }],
    });
  });

  test("omits drafts and rejects impossible confirmed-review rows", () => {
    expect(confirmedReviewEvidence(
      {
        reviewId: "review-draft",
        meetingId: 9,
        transcriptVersionId: "transcript-v1",
        status: "draft",
      },
      [],
      "transcript-v1",
    )).toBeUndefined();

    expect(() => confirmedReviewEvidence(
      {
        reviewId: "review-1",
        meetingId: 9,
        transcriptVersionId: "transcript-v1",
        status: "confirmed",
      },
      [{
        id: "action-1",
        kind: "action_item",
        description: "Publish notes",
        evidenceQuote: "Publish notes",
        source,
        reviewState: "candidate",
      }],
      "transcript-v1",
    )).toThrow("candidate item");
  });
});
