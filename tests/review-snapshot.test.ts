import { describe, expect, test } from "bun:test";
import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";
import { conclusionForReview, reviewSnapshotForMeeting } from "../src/review-snapshot.ts";

function fixture() {
  const legacy = new MeetingStore(":memory:");
  const store = new MinutesStore(legacy.databaseHandle());
  const meetingId = legacy.startMeeting("cli:snapshot");
  store.registerCapturingMeeting(meetingId);
  store.addAttendees(meetingId, [{ attendeeId: "alice", displayName: "Alice", sortOrder: 0 }]);
  const version = store.addTranscriptVersion(meetingId, { transcriptVersionId: "v1", sourceKind: "live_capture" });
  store.addTranscriptVersionLines(version.transcriptVersionId, [
    { seq: 10, speakerTurn: 7, text: "Discuss the launch." },
    { seq: 11, speakerTurn: null, text: "Ship Friday." },
  ]);
  store.finalizeTranscriptVersion("v1", transcriptContentSha256(store, "v1"));
  store.setCanonical(meetingId, "v1");
  store.endMeeting(meetingId);
  const source = { transcriptVersionId: "v1", startSeq: 10, endSeq: 11 };
  return { legacy, store, meetingId, source };
}

describe("durable review snapshot", () => {
  test("returns null for unknown meetings, missing canonical versions and missing reviews", () => {
    const fx = fixture();
    try {
      expect(reviewSnapshotForMeeting(fx.store, -1)).toBeNull();
      expect(reviewSnapshotForMeeting(fx.store, fx.meetingId)).toBeNull();
      const other = fx.legacy.startMeeting("cli:other");
      fx.store.registerCapturingMeeting(other);
      expect(reviewSnapshotForMeeting(fx.store, other)).toBeNull();
      expect(conclusionForReview(fx.store, "absent")).toBeNull();
    } finally { fx.legacy.close(); }
  });

  test("projects stored ordering, trimming, defaults, source coordinates and summary", () => {
    const fx = fixture();
    try {
      const summary = { overview: "Launch", topics: [{ title: "Schedule", summary: "Friday", source: {
        transcript_version_id: "v1", start_seq: 10, end_seq: 11,
      } }] };
      const reviewId = fx.store.saveCandidates({ meetingId: fx.meetingId, transcriptVersionId: "v1",
        decisions: [
          { id: "z", description: "  Last  ", evidenceQuote: " Ship Friday. ", source: fx.source },
          { id: "a", description: "First", source: fx.source },
        ],
        actionItems: [{ id: "action", description: "Do it", source: fx.source }],
        openItems: [{ id: "open", description: "Question", source: fx.source }], summary,
      });
      const result = reviewSnapshotForMeeting(new MinutesStore(fx.legacy.databaseHandle()), fx.meetingId);
      expect(result).toMatchObject({ type: "review", meetingId: fx.meetingId, reviewId,
        transcriptVersionId: "v1", status: "draft", confirmedAt: null, confirmedBy: null,
        conclusion: null, summary, attendees: [{ attendeeId: "alice", displayName: "Alice" }],
        transcript: { lines: [
          { seq: 10, speakerTurn: 7, text: "Discuss the launch." },
          { seq: 11, speakerTurn: null, text: "Ship Friday." },
        ] },
      });
      expect(result?.items.map((item) => item.id)).toEqual(["a", "z", "action", "open"]);
      expect(result?.items[1]).toEqual({ id: "z", kind: "decision", description: "Last",
        evidenceQuote: "Ship Friday.", reviewState: "candidate", attributedAttendeeId: null,
        sourceSegment: { transcript_version_id: "v1", start_seq: 10, end_seq: 11 },
        segment_text: "Discuss the launch.\nShip Friday.",
      });
      expect(result?.items[2]).toMatchObject({ assigneeAttendeeId: null, deadline: null,
        deadlineText: null, evidenceQuote: "Discuss the launch.\nShip Friday." });
      expect(result?.items[3]).not.toHaveProperty("deadline");
      expect(result).not.toHaveProperty("usedFallback");
    } finally { fx.legacy.close(); }
  });

  test("reads edits, confirmation and the persisted conclusion without a process cache", () => {
    const fx = fixture();
    try {
      const reviewId = fx.store.saveCandidates({ meetingId: fx.meetingId, transcriptVersionId: "v1",
        decisions: [{ id: "decision", description: "Draft", source: fx.source }],
      });
      const draft = reviewSnapshotForMeeting(fx.store, fx.meetingId);
      fx.store.updateItem(reviewId, "decision", "decision", {
        description: "Final", attributedAttendeeId: "alice", reviewState: "confirmed",
      });
      fx.store.confirmReview(reviewId, "reviewer");
      const db = fx.store.databaseHandle();
      db.run(`INSERT INTO artifact_bundles
        (bundle_id, meeting_id, review_id, transcript_version_id, bundle_path, status, created_at, completed_at)
        VALUES ('bundle', ?, ?, 'v1', '/snapshot/bundle', 'complete', 100, 100)`, [fx.meetingId, reviewId]);
      db.run(`INSERT INTO meeting_conclusions
        (meeting_id, review_id, transcript_version_id, bundle_id, bundle_path, manifest_sha256, target_commit, concluded_at)
        VALUES (?, ?, 'v1', 'bundle', '/snapshot/bundle', ?, ?, 123)`,
      [fx.meetingId, reviewId, "a".repeat(64), "b".repeat(40)]);
      const result = reviewSnapshotForMeeting(new MinutesStore(db), fx.meetingId);
      expect(draft?.items[0]?.description).toBe("Draft");
      expect(result).toMatchObject({ status: "confirmed", confirmedBy: "reviewer", confirmedAt: expect.any(Number) });
      expect(result?.items[0]).toMatchObject({ description: "Final", reviewState: "confirmed", attributedAttendeeId: "alice" });
      const conclusion = { type: "meetingConcluded", concluded: true, meetingId: fx.meetingId,
        reviewId, transcriptVersionId: "v1", bundleId: "bundle", bundlePath: "/snapshot/bundle",
        manifest: { sha256: "a".repeat(64), targetCommit: "b".repeat(40) }, concludedAt: 123 } as const;
      expect(result?.conclusion).toEqual(conclusion);
      expect(conclusionForReview(fx.store, reviewId)).toEqual(conclusion);
    } finally { fx.legacy.close(); }
  });

  test("does not project a review from a noncanonical transcript", () => {
    const fx = fixture();
    try {
      const other = fx.store.addTranscriptVersion(fx.meetingId, { transcriptVersionId: "other", sourceKind: "retranscription" });
      fx.store.saveCandidates({ meetingId: fx.meetingId, transcriptVersionId: other.transcriptVersionId });
      expect(reviewSnapshotForMeeting(fx.store, fx.meetingId)).toBeNull();
    } finally { fx.legacy.close(); }
  });
});
