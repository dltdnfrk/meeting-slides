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
          attributedAttendeeId: "att-mina",
        },
        {
          id: "action-1",
          kind: "action_item",
          description: "Publish notes",
          evidenceQuote: "Publish notes",
          source,
          reviewState: "confirmed",
          assigneeAttendeeId: "att-mina",
          deadline: "2026-08-21",
          deadlineText: "Friday",
          attributedAttendeeId: "att-owen",
        },
        {
          id: "open-1",
          kind: "open_item",
          description: "Rejected question",
          evidenceQuote: "question",
          source,
          reviewState: "rejected",
          assigneeAttendeeId: "att-mina",
        },
      ],
      "transcript-v1",
      [
        { attendeeId: "att-mina", displayName: "Mina Kim" },
        { attendeeId: "att-owen", displayName: "Owen Park" },
      ],
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
        attributedAttendeeId: "att-mina",
      }, {
        id: "action-1",
        kind: "action_item",
        description: "Publish notes",
        source: { ...source, evidenceQuote: "Publish notes" },
        reviewState: "confirmed",
        assigneeAttendeeId: "att-mina",
        deadline: "2026-08-21",
        deadlineText: "Friday",
        attributedAttendeeId: "att-owen",
      }],
      attendees: [
        { attendeeId: "att-mina", displayName: "Mina Kim" },
        { attendeeId: "att-owen", displayName: "Owen Park" },
      ],
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

  test("carries a confirmed summary overview and topics in seq order", () => {
    const evidence = confirmedReviewEvidence(
      {
        reviewId: "review-1",
        meetingId: 9,
        transcriptVersionId: "transcript-v1",
        status: "confirmed",
        summary: {
          overview: "Quality stays the gate and the beta launches Friday.",
          topics: [
            {
              title: "QA gate",
              summary: "Quality remains the release gate.",
              source: { transcript_version_id: "transcript-v1", start_seq: 4, end_seq: 4 },
            },
            {
              title: "Friday launch",
              summary: "The beta launches Friday.",
              source: { transcript_version_id: "transcript-v1", start_seq: 2, end_seq: 3 },
            },
          ],
        },
      },
      [],
      "transcript-v1",
    );

    expect(evidence?.summary).toEqual({
      overview: "Quality stays the gate and the beta launches Friday.",
      topics: [
        {
          title: "Friday launch",
          summary: "The beta launches Friday.",
          source: { transcriptVersionId: "transcript-v1", startSeq: 2, endSeq: 3 },
        },
        {
          title: "QA gate",
          summary: "Quality remains the release gate.",
          source: { transcriptVersionId: "transcript-v1", startSeq: 4, endSeq: 4 },
        },
      ],
    });
  });

  test("rejects a confirmed summary whose topic is ungrounded", () => {
    expect(() => confirmedReviewEvidence(
      {
        reviewId: "review-1",
        meetingId: 9,
        transcriptVersionId: "transcript-v1",
        status: "confirmed",
        summary: {
          overview: "Quality stays the gate and the beta launches Friday.",
          topics: [{
            title: "Missing range",
            summary: "This was never said.",
            source: { transcript_version_id: "transcript-v9", start_seq: 2, end_seq: 3 },
          }],
        },
      },
      [],
      "transcript-v1",
    )).toThrow("ungrounded");
  });
});
