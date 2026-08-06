import { describe, expect, test } from "bun:test";

import type { MinutesExtractionInput, MinutesExtractionResult } from "../src/extract.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { startReview } from "../src/start-review.ts";
import { MeetingStore } from "../src/store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";

function fixture(lines: Array<{ seq: number; speakerTurn?: number | null; text: string }>) {
  const legacy = new MeetingStore(":memory:");
  const store = new MinutesStore(legacy.databaseHandle());
  const meetingId = legacy.startMeeting("cli:test");
  store.registerCapturingMeeting(meetingId);
  store.addAttendees(meetingId, [
    { attendeeId: "alice", displayName: "Alice", sortOrder: 0 },
    { attendeeId: "bob", displayName: "Bob", sortOrder: 1 },
  ]);
  const version = store.addTranscriptVersion(meetingId, {
    transcriptVersionId: "canonical-v1",
    sourceKind: "live_capture",
  });
  store.addTranscriptVersionLines(version.transcriptVersionId, lines.map((line) => ({
    seq: line.seq,
    speakerTurn: line.speakerTurn ?? null,
    text: line.text,
  })));
  store.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(store, version.transcriptVersionId));
  store.setCanonical(meetingId, version.transcriptVersionId);
  store.endMeeting(meetingId);
  return { legacy, store, meetingId, transcriptVersionId: version.transcriptVersionId };
}

function emptyResult(transcriptVersionId: string): MinutesExtractionResult {
  return {
    transcriptVersionId,
    decisions: [],
    actionItems: [],
    openItems: [],
    rejections: [],
    batchFailed: false,
    usedFallback: false,
  };
}

describe("startReview", () => {
  test("extracts canonical version lines, persists the exact candidate IDs, and returns a self-contained review payload", async () => {
    const fx = fixture([
      { seq: 1, speakerTurn: 3, text: "We discussed the rollout." },
      { seq: 2, speakerTurn: 4, text: "Ship Friday was confirmed." },
      { seq: 3, speakerTurn: 3, text: "Alice will share the checklist." },
    ]);
    let request: MinutesExtractionInput | undefined;
    const extractor = {
      extract: async (input: MinutesExtractionInput): Promise<MinutesExtractionResult> => {
        request = input;
        return {
          ...emptyResult(input.transcriptVersionId),
          decisions: [{
            id: "decision-1",
            description: "Ship Friday",
            sourceSegment: { transcript_version_id: input.transcriptVersionId, start_seq: 1, end_seq: 2 },
            evidenceQuote: "Ship Friday was confirmed.",
            suggestedAttributionAttendeeId: "bob",
            origin: "llm",
          }],
          actionItems: [{
            id: "action-1",
            description: "Share the checklist",
            sourceSegment: { transcript_version_id: input.transcriptVersionId, start_seq: 3, end_seq: 3 },
            evidenceQuote: "Alice will share the checklist.",
            suggestedAttributionAttendeeId: "alice",
            suggestedAssigneeAttendeeId: "alice",
            deadline: null,
            deadlineText: null,
            origin: "llm",
          }],
        };
      },
    };

    const payload = await startReview({
      meetingId: fx.meetingId,
      store: fx.store,
      extractor,
      meetingDate: "2026-08-01",
      timeZone: "Asia/Seoul",
    });

    expect(request).toEqual({
      schemaVersion: 1,
      meetingDate: "2026-08-01",
      timeZone: "Asia/Seoul",
      transcriptVersionId: fx.transcriptVersionId,
      attendees: [
        { attendeeId: "alice", displayName: "Alice" },
        { attendeeId: "bob", displayName: "Bob" },
      ],
      lines: [
        { seq: 1, speakerTurn: 3, text: "We discussed the rollout." },
        { seq: 2, speakerTurn: 4, text: "Ship Friday was confirmed." },
        { seq: 3, speakerTurn: 3, text: "Alice will share the checklist." },
      ],
    });
    expect(payload).toEqual({
      type: "review",
      reviewId: expect.any(String),
      transcriptVersionId: fx.transcriptVersionId,
      attendees: request!.attendees,
      transcript: { lines: request!.lines },
      items: [
        {
          id: "decision-1",
          kind: "decision",
          description: "Ship Friday",
          sourceSegment: { transcript_version_id: fx.transcriptVersionId, start_seq: 1, end_seq: 2 },
          evidenceQuote: "Ship Friday was confirmed.",
          segment_text: "We discussed the rollout.\nShip Friday was confirmed.",
          attributedAttendeeId: "bob",
        },
        {
          id: "action-1",
          kind: "action_item",
          description: "Share the checklist",
          sourceSegment: { transcript_version_id: fx.transcriptVersionId, start_seq: 3, end_seq: 3 },
          evidenceQuote: "Alice will share the checklist.",
          segment_text: "Alice will share the checklist.",
          attributedAttendeeId: "alice",
          assigneeAttendeeId: "alice",
          deadline: null,
          deadlineText: null,
        },
      ],
    });
    expect(fx.store.review(payload.reviewId)).toMatchObject({
      reviewId: payload.reviewId,
      meetingId: fx.meetingId,
      transcriptVersionId: fx.transcriptVersionId,
      status: "draft",
    });
    expect(fx.store.itemsForReview(payload.reviewId)).toEqual([
      expect.objectContaining({ id: "decision-1", kind: "decision", reviewState: "candidate" }),
      expect.objectContaining({ id: "action-1", kind: "action_item", reviewState: "candidate" }),
    ]);
    fx.legacy.close();
  });

  test("passes user notes through to the extractor request", async () => {
    const fx = fixture([
      { seq: 1, speakerTurn: 3, text: "We discussed the rollout." },
    ]);
    let request: MinutesExtractionInput | undefined;
    const extractor = {
      extract: async (input: MinutesExtractionInput): Promise<MinutesExtractionResult> => {
        request = input;
        return { ...emptyResult(input.transcriptVersionId), decisions: [], actionItems: [], openItems: [], rejections: [] };
      },
    };

    await startReview({
      meetingId: fx.meetingId,
      store: fx.store,
      extractor,
      notes: "  마감일 금요일 확정, 앨리스가 체크리스트 공유  ",
    });

    expect(request!.notes).toBe("마감일 금요일 확정, 앨리스가 체크리스트 공유");
    fx.legacy.close();
  });

  test("creates an empty version-scoped review for an empty canonical transcript", async () => {
    const fx = fixture([]);
    let calls = 0;
    const payload = await startReview({
      meetingId: fx.meetingId,
      store: fx.store,
      extractor: { extract: async (input) => { calls++; return emptyResult(input.transcriptVersionId); } },
      meetingDate: "2026-08-01",
      timeZone: "UTC",
    });

    expect(calls).toBe(1);
    expect(payload.items).toEqual([]);
    expect(payload.transcript).toEqual({ lines: [] });
    expect(fx.store.review(payload.reviewId)).toMatchObject({
      reviewId: payload.reviewId,
      meetingId: fx.meetingId,
      transcriptVersionId: fx.transcriptVersionId,
      status: "draft",
    });
    expect(fx.store.itemsForReview(payload.reviewId)).toEqual([]);
    fx.legacy.close();
  });

  test("rejects extraction failures and wrong-version results without persisting a review", async () => {
    const rejected = fixture([{ seq: 1, text: "Stable canonical text" }]);
    await expect(startReview({
      meetingId: rejected.meetingId,
      store: rejected.store,
      extractor: { extract: async () => { throw new Error("transport unavailable"); } },
    })).rejects.toThrow("transport unavailable");
    expect(rejected.store.databaseHandle().query("SELECT COUNT(*) AS count FROM meeting_reviews").get()).toEqual({ count: 0 });
    rejected.legacy.close();

    const wrong = fixture([{ seq: 1, text: "Stable canonical text" }]);
    await expect(startReview({
      meetingId: wrong.meetingId,
      store: wrong.store,
      extractor: { extract: async () => emptyResult("other-version") },
    })).rejects.toThrow(/wrong transcript version/);
    expect(wrong.store.databaseHandle().query("SELECT COUNT(*) AS count FROM meeting_reviews").get()).toEqual({ count: 0 });
    wrong.legacy.close();
  });
});
