import { describe, expect, test } from "bun:test";

import type { MinutesExtractionInput, MinutesExtractionResult } from "../src/extract.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { startReview } from "../src/start-review.ts";
import { MeetingStore } from "../src/store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";
import { reviewSnapshotForMeeting } from "../src/review-snapshot.ts";

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
    summary: null,
  };
}

describe("startReview", () => {
  test("returns persisted normalization and ordering plus only the transient fallback flag", async () => {
    const fx = fixture([{ seq: 10, text: "Ship Friday was confirmed." }]);
    try {
      const result = await startReview({ meetingId: fx.meetingId, store: fx.store, extractor: {
        async extract(input) {
          return { ...emptyResult(input.transcriptVersionId), usedFallback: true,
            decisions: ["z", "a"].map((id) => ({ id, description: `  Decision ${id}  `,
              evidenceQuote: "  Ship Friday was confirmed.  ",
              sourceSegment: { transcript_version_id: input.transcriptVersionId, start_seq: 10, end_seq: 10 },
              suggestedAttributionAttendeeId: null, origin: "local_rule" as const,
            })),
            openItems: [{ id: "open", description: "  Question  ", evidenceQuote: "   ",
              sourceSegment: { transcript_version_id: input.transcriptVersionId, start_seq: 10, end_seq: 10 },
              suggestedAttributionAttendeeId: null, origin: "local_rule" as const,
            }],
          };
        },
      } });
      const persisted = reviewSnapshotForMeeting(fx.store, fx.meetingId);
      if (!persisted) throw new Error("expected a persisted review");
      expect(result).toEqual({ ...persisted, usedFallback: true });
      expect(result.items.map((item) => item.id)).toEqual(["a", "z", "open"]);
      expect(result.items[2]).toMatchObject({ description: "Question", evidenceQuote: "Ship Friday was confirmed." });
      expect(persisted).not.toHaveProperty("usedFallback");
    } finally { fx.legacy.close(); }
  });

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
      meetingId: fx.meetingId,
      reviewId: expect.any(String),
      transcriptVersionId: fx.transcriptVersionId,
      status: "draft",
      confirmedAt: null,
      confirmedBy: null,
      conclusion: null,
      summary: null,
      attendees: request!.attendees,
      transcript: { lines: request!.lines },
      items: [
        {
          id: "decision-1",
          kind: "decision",
          description: "Ship Friday",
          sourceSegment: { transcript_version_id: fx.transcriptVersionId, start_seq: 1, end_seq: 2 },
          evidenceQuote: "Ship Friday was confirmed.",
          reviewState: "candidate",
          segment_text: "We discussed the rollout.\nShip Friday was confirmed.",
          attributedAttendeeId: "bob",
        },
        {
          id: "action-1",
          kind: "action_item",
          description: "Share the checklist",
          sourceSegment: { transcript_version_id: fx.transcriptVersionId, start_seq: 3, end_seq: 3 },
          evidenceQuote: "Alice will share the checklist.",
          reviewState: "candidate",
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
      expect.objectContaining({ id: "decision-1", kind: "decision", evidenceQuote: "Ship Friday was confirmed.", reviewState: "candidate" }),
      expect.objectContaining({ id: "action-1", kind: "action_item", evidenceQuote: "Alice will share the checklist.", reviewState: "candidate" }),
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

  test("returns usedFallback from the extractor on the ReviewUpdate", async () => {
    const fx = fixture([{ seq: 1, text: "Ship Friday was confirmed." }]);
    const payload = await startReview({
      meetingId: fx.meetingId,
      store: fx.store,
      extractor: {
        extract: async (input) => ({ ...emptyResult(input.transcriptVersionId), usedFallback: true }),
      },
      meetingDate: "2026-08-01",
      timeZone: "UTC",
    });

    expect(payload.usedFallback).toBe(true);
    expect(payload.summary).toBeNull();
    fx.legacy.close();
  });

  test("carries a grounded summary on the ReviewUpdate and persists it with the draft", async () => {
    const fx = fixture([
      { seq: 1, speakerTurn: 3, text: "We discussed the rollout." },
      { seq: 2, speakerTurn: 4, text: "Ship Friday was confirmed." },
    ]);
    const payload = await startReview({
      meetingId: fx.meetingId,
      store: fx.store,
      extractor: {
        extract: async (input) => ({
          ...emptyResult(input.transcriptVersionId),
          summary: {
            overview: "The team confirmed Friday ship.",
            topics: [{
              title: "Launch",
              summary: "Ship Friday was confirmed.",
              source: { transcript_version_id: input.transcriptVersionId, start_seq: 1, end_seq: 2 },
            }],
          },
        }),
      },
      meetingDate: "2026-08-01",
      timeZone: "UTC",
    });

    expect(payload.summary).toEqual({
      overview: "The team confirmed Friday ship.",
      topics: [{
        title: "Launch",
        summary: "Ship Friday was confirmed.",
        source: { transcript_version_id: fx.transcriptVersionId, start_seq: 1, end_seq: 2 },
      }],
    });
    expect(fx.store.review(payload.reviewId)?.summary).toEqual(payload.summary);
    fx.legacy.close();
  });

  test("replaces persisted draft candidates when startReview runs again", async () => {
    const fx = fixture([{ seq: 1, text: "Ship Friday was confirmed." }]);
    let calls = 0;
    const extractor = {
      extract: async (input: MinutesExtractionInput): Promise<MinutesExtractionResult> => {
        calls += 1;
        return {
          ...emptyResult(input.transcriptVersionId),
          decisions: [{
            id: calls === 1 ? "decision-1" : "decision-2",
            description: calls === 1 ? "First" : "Second",
            sourceSegment: { transcript_version_id: input.transcriptVersionId, start_seq: 1, end_seq: 1 },
            evidenceQuote: "Ship Friday was confirmed.",
            suggestedAttributionAttendeeId: "alice",
            origin: "llm",
          }],
        };
      },
    };

    const first = await startReview({ meetingId: fx.meetingId, store: fx.store, extractor });
    const second = await startReview({
      meetingId: fx.meetingId, store: fx.store, extractor, notes: "retry with notes",
    });

    expect(calls).toBe(2);
    expect(second.reviewId).toBe(first.reviewId);
    expect(first.items[0]?.description).toBe("First");
    expect(second.items[0]?.description).toBe("Second");
    expect(fx.store.itemsForReview(second.reviewId)).toEqual([
      expect.objectContaining({ id: "decision-2", description: "Second" }),
    ]);
    expect(fx.store.databaseHandle().query("SELECT COUNT(*) AS count FROM meeting_reviews").get()).toEqual({ count: 1 });
    fx.legacy.close();
  });

  test("preserves confirmed-review refusal and the persisted review", async () => {
    const fx = fixture([]);
    try {
      const extractor = { extract: async (input: MinutesExtractionInput) => emptyResult(input.transcriptVersionId) };
      const first = await startReview({ meetingId: fx.meetingId, store: fx.store, extractor });
      fx.store.confirmReview(first.reviewId, "alice");
      await expect(startReview({ meetingId: fx.meetingId, store: fx.store, extractor })).rejects.toThrow(
        `[REVIEW_NOT_DRAFT] review ${first.reviewId} is missing or not draft`,
      );
      expect(fx.store.review(first.reviewId)).toMatchObject({ status: "confirmed", confirmedBy: "alice" });
    } finally { fx.legacy.close(); }
  });

  test("omits blank notes and derives defaults from the meeting", async () => {
    const fx = fixture([]);
    try {
      fx.store.databaseHandle().run("UPDATE meetings SET started_at = ? WHERE id = ?", [Date.UTC(2026, 7, 2), fx.meetingId]);
      let request: MinutesExtractionInput | undefined;
      await startReview({ meetingId: fx.meetingId, store: fx.store, notes: " \n ", extractor: {
        async extract(input) { request = input; return emptyResult(input.transcriptVersionId); },
      } });
      expect(request?.meetingDate).toBe("2026-08-02");
      expect(request?.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
      expect(request).not.toHaveProperty("notes");
    } finally { fx.legacy.close(); }
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
