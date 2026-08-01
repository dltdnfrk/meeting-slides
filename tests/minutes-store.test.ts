import { describe, expect, test } from "bun:test";

import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";

function stores(): { legacy: MeetingStore; minutes: MinutesStore } {
  const legacy = new MeetingStore(":memory:");
  return { legacy, minutes: new MinutesStore(legacy.databaseHandle()) };
}

function preparedTranscript(minutes: MinutesStore): {
  meetingId: number;
  transcriptVersionId: string;
} {
  const meetingId = minutes.ensurePreparedMeeting("cli:codex", "Release review");
  minutes.activatePreparedMeeting(meetingId);
  minutes.addAttendees(meetingId, [
    { attendeeId: "alice-local", displayName: "Alice", crmPersonEntityId: "crm-alice", sortOrder: 1 },
    { attendeeId: "bob-local", displayName: "Bob", sortOrder: 2 },
  ]);
  const version = minutes.addTranscriptVersion(meetingId, {
    sourceKind: "live_capture",
    engine: "whisper",
  });
  minutes.addTranscriptVersionLines(version.transcriptVersionId, [
    { seq: 1, capturedAtMs: 1000, text: "Ship on Friday." },
    { seq: 2, capturedAtMs: 2000, text: "Alice owns QA." },
    { seq: 3, capturedAtMs: 3000, text: "Budget remains open." },
  ]);
  return { meetingId, transcriptVersionId: version.transcriptVersionId };
}

describe("MinutesStore SQLite contracts", () => {
  test("rejects an attendee for a meeting that does not exist", () => {
    const { legacy, minutes } = stores();
    expect(() => minutes.addAttendees(999, [
      { attendeeId: "outside", displayName: "Outside" },
    ])).toThrow(/FOREIGN KEY constraint failed/);
    legacy.close();
  });

  test("creates and activates one prepared legacy-compatible meeting", () => {
    const { legacy, minutes } = stores();
    const meetingId = minutes.ensurePreparedMeeting("cli:codex", "Planning");
    expect(minutes.ensurePreparedMeeting("cli:codex", "Planning updated")).toBe(meetingId);
    expect(minutes.meetingMeta(meetingId)).toMatchObject({
      meetingId,
      purpose: "Planning updated",
      phase: "prepared",
    });

    minutes.activatePreparedMeeting(meetingId);
    expect(minutes.meetingMeta(meetingId)?.phase).toBe("capturing");
    expect(() => minutes.activatePreparedMeeting(meetingId)).toThrow(/not prepared/);
    legacy.close();
  });

  test("stores local attendee keys independently from optional CRM ids", () => {
    const { legacy, minutes } = stores();
    const meetingId = minutes.ensurePreparedMeeting("cli:codex", null);
    minutes.addAttendees(meetingId, [
      { attendeeId: "local-a", displayName: " Alice ", crmPersonEntityId: "crm-42", sortOrder: 2 },
      { attendeeId: "local-b", displayName: "Bob", sortOrder: 1 },
    ]);
    expect(minutes.attendeesFor(meetingId)).toEqual([
      { attendeeId: "local-b", displayName: "Bob", crmPersonEntityId: null, sortOrder: 1 },
      { attendeeId: "local-a", displayName: "Alice", crmPersonEntityId: "crm-42", sortOrder: 2 },
    ]);
    legacy.close();
  });

  test("versions immutable transcript lines, finalizes, and selects canonical", () => {
    const { legacy, minutes } = stores();
    const { meetingId, transcriptVersionId } = preparedTranscript(minutes);
    const hash = "a".repeat(64);
    minutes.finalizeTranscriptVersion(transcriptVersionId, hash);
    minutes.setCanonical(meetingId, transcriptVersionId);

    expect(minutes.latestVersion(meetingId)).toMatchObject({
      transcriptVersionId,
      versionNo: 1,
      contentSha256: hash,
    });
    expect(minutes.canonicalVersion(meetingId)?.transcriptVersionId).toBe(transcriptVersionId);
    expect(minutes.transcriptVersionLines(transcriptVersionId).map((line) => line.seq)).toEqual([1, 2, 3]);

    const retranscription = minutes.addTranscriptVersion(meetingId, { sourceKind: "retranscription" });
    expect(retranscription.versionNo).toBe(2);
    expect(minutes.canonicalVersion(meetingId)?.transcriptVersionId).toBe(transcriptVersionId);
    legacy.close();
  });

  test("saves sourced candidates and confirms only fully reviewed items", () => {
    const { legacy, minutes } = stores();
    const { meetingId, transcriptVersionId } = preparedTranscript(minutes);
    const reviewId = minutes.saveCandidates({
      meetingId,
      transcriptVersionId,
      decisions: [{
        description: "Ship Friday",
        source: { transcriptVersionId, startSeq: 1, endSeq: 1 },
        attributedAttendeeId: "alice-local",
        reviewState: "confirmed",
      }],
      actionItems: [{
        description: "Run QA",
        source: { transcriptVersionId, startSeq: 1, endSeq: 2 },
        assigneeAttendeeId: "alice-local",
        attributedAttendeeId: "bob-local",
        deadline: "2026-08-07",
        reviewState: "confirmed",
      }],
      openItems: [{
        description: "Resolve budget",
        source: { transcriptVersionId, startSeq: 3, endSeq: 3 },
        attributedAttendeeId: "bob-local",
        reviewState: "rejected",
      }],
    });

    expect(minutes.itemsForReview(reviewId).map((item) => [item.kind, item.description])).toEqual([
      ["decision", "Ship Friday"],
      ["action_item", "Run QA"],
      ["open_item", "Resolve budget"],
    ]);
    minutes.confirmReview(reviewId, "reviewer-local");
    expect(minutes.review(reviewId)).toMatchObject({ status: "confirmed", confirmedBy: "reviewer-local" });
    legacy.close();
  });

  test("rejects endpoint-valid but interior-missing ranges and rolls back the whole review", () => {
    const { legacy, minutes } = stores();
    const { meetingId, transcriptVersionId } = preparedTranscript(minutes);
    minutes.databaseHandle().run(
      "DELETE FROM transcript_version_lines WHERE transcript_version_id = ? AND seq = 2",
      [transcriptVersionId],
    );

    expect(() => minutes.saveCandidates({
      meetingId,
      transcriptVersionId,
      decisions: [{
        description: "Invalid gap",
        source: { transcriptVersionId, startSeq: 1, endSeq: 3 },
      }],
    })).toThrow(/contiguous/);
    expect(minutes.databaseHandle().query("SELECT COUNT(*) AS count FROM meeting_reviews").get()).toEqual({ count: 0 });
    expect(minutes.databaseHandle().query("SELECT COUNT(*) AS count FROM decisions").get()).toEqual({ count: 0 });
    legacy.close();
  });

  test("revalidates source interiors during confirmation in the same transaction", () => {
    const { legacy, minutes } = stores();
    const { meetingId, transcriptVersionId } = preparedTranscript(minutes);
    const reviewId = minutes.saveCandidates({
      meetingId,
      transcriptVersionId,
      decisions: [{
        description: "Initially valid",
        source: { transcriptVersionId, startSeq: 1, endSeq: 3 },
        attributedAttendeeId: "alice-local",
        reviewState: "confirmed",
      }],
    });
    minutes.databaseHandle().run(
      "DELETE FROM transcript_version_lines WHERE transcript_version_id = ? AND seq = 2",
      [transcriptVersionId],
    );

    expect(() => minutes.confirmReview(reviewId, "reviewer")).toThrow(/contiguous/);
    expect(minutes.review(reviewId)?.status).toBe("draft");
    legacy.close();
  });

  test("enforces attendee provenance and successful-audio hash semantics", () => {
    const { legacy, minutes } = stores();
    const { meetingId, transcriptVersionId } = preparedTranscript(minutes);
    expect(() => minutes.saveCandidates({
      meetingId,
      transcriptVersionId,
      actionItems: [{
        description: "Outsider action",
        source: { transcriptVersionId, startSeq: 1, endSeq: 1 },
        assigneeAttendeeId: "not-in-meeting",
      }],
    })).toThrow(/FOREIGN KEY constraint failed/);

    const hash = "b".repeat(64);
    minutes.addAudioSource(meetingId, {
      originalAudioSha256: hash,
      originalAudioPath: "/tmp/audio.wav",
      byteLength: 123,
    });
    expect(minutes.findMeetingByAudioHash(hash)).toBe(meetingId);
    expect(() => minutes.addAudioSource(meetingId, { originalAudioSha256: "bad" })).toThrow(/64-character/);
    expect(minutes.findMeetingByAudioHash("c".repeat(64))).toBeNull();
    legacy.close();
  });

  test("creates the complete additive minutes schema without changing legacy tables", () => {
    const { legacy, minutes } = stores();
    const tables = minutes.databaseHandle()
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map(({ name }) => name);
    for (const required of [
      "meetings", "transcript_lines", "slides", "attendees", "meeting_meta",
      "meeting_audio_sources", "transcript_versions", "transcript_version_lines",
      "meeting_transcript_state", "transcript_line_attributions", "meeting_reviews",
      "decisions", "action_items", "open_items", "referenced_materials",
      "artifact_bundles", "artifacts",
    ]) expect(names).toContain(required);
    legacy.close();
  });
});
