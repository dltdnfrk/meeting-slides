import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";

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

function selectCanonical(minutes: MinutesStore, meetingId: number, transcriptVersionId: string): void {
  minutes.finalizeTranscriptVersion(transcriptVersionId, transcriptContentSha256(minutes, transcriptVersionId));
  minutes.setCanonical(meetingId, transcriptVersionId);
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

  test("replaces prepared attendees and locks the roster after review confirmation", () => {
    const { legacy, minutes } = stores();
    const { meetingId, transcriptVersionId } = preparedTranscript(minutes);
    minutes.replaceAttendees(meetingId, [
      { attendeeId: "alice-local", displayName: "Alice Kim", sortOrder: 0 },
      { attendeeId: "dana-local", displayName: "Dana", sortOrder: 1 },
    ]);
    expect(minutes.attendeesFor(meetingId)).toEqual([
      { attendeeId: "alice-local", displayName: "Alice Kim", crmPersonEntityId: null, sortOrder: 0 },
      { attendeeId: "dana-local", displayName: "Dana", crmPersonEntityId: null, sortOrder: 1 },
    ]);

    const reviewId = minutes.saveCandidates({ meetingId, transcriptVersionId });
    selectCanonical(minutes, meetingId, transcriptVersionId);
    minutes.confirmReview(reviewId, "reviewer");
    expect(() => minutes.replaceAttendees(meetingId, [
      { attendeeId: "alice-local", displayName: "Changed" },
    ])).toThrow(/locked after review confirmation/);
    expect(minutes.attendeesFor(meetingId)[0]?.displayName).toBe("Alice Kim");
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
        evidenceQuote: "Ship on Friday.",
        source: { transcriptVersionId, startSeq: 1, endSeq: 1 },
        attributedAttendeeId: "alice-local",
        reviewState: "confirmed",
      }],
      actionItems: [{
        description: "Run QA",
        evidenceQuote: "Alice owns QA.",
        source: { transcriptVersionId, startSeq: 1, endSeq: 2 },
        assigneeAttendeeId: "alice-local",
        attributedAttendeeId: "bob-local",
        deadline: "2026-08-07",
        reviewState: "confirmed",
      }],
      openItems: [{
        description: "Resolve budget",
        evidenceQuote: "Budget remains open.",
        source: { transcriptVersionId, startSeq: 3, endSeq: 3 },
        attributedAttendeeId: "bob-local",
        reviewState: "rejected",
      }],
    });
    selectCanonical(minutes, meetingId, transcriptVersionId);

    expect(minutes.itemsForReview(reviewId).map((item) => [item.kind, item.description, item.evidenceQuote])).toEqual([
      ["decision", "Ship Friday", "Ship on Friday."],
      ["action_item", "Run QA", "Alice owns QA."],
      ["open_item", "Resolve budget", "Budget remains open."],
    ]);
    minutes.confirmReview(reviewId, "reviewer-local");
    expect(minutes.review(reviewId)).toMatchObject({ status: "confirmed", confirmedBy: "reviewer-local" });
    legacy.close();
  });

  test("persists referenced materials and completes their review through the public API", () => {
    const { legacy, minutes } = stores();
    try {
      const { meetingId, transcriptVersionId } = preparedTranscript(minutes);
      selectCanonical(minutes, meetingId, transcriptVersionId);
      const material = {
        id: "budget-reference",
        materialType: "data" as const,
        title: "Release budget",
        uri: "https://example.com/release-budget.csv",
        notes: "QA allocation and outstanding budget",
        source: { transcriptVersionId, startSeq: 2, endSeq: 3 },
      };
      const reviewId = minutes.saveCandidates({
        meetingId,
        transcriptVersionId,
        referencedMaterials: [material],
      });
      const storedMaterials = () => minutes.databaseHandle().query(
        "SELECT * FROM referenced_materials WHERE review_id = ?",
      ).all(reviewId);
      const expected = {
        material_id: material.id,
        meeting_id: meetingId,
        review_id: reviewId,
        material_type: material.materialType,
        title: material.title,
        uri: material.uri,
        notes: material.notes,
        source_transcript_version_id: transcriptVersionId,
        source_start_seq: 2,
        source_end_seq: 3,
        review_state: "candidate",
        created_at: expect.any(Number),
        updated_at: expect.any(Number),
      };
      expect(storedMaterials()).toEqual([expected]);
      expect(() => minutes.confirmReview(reviewId, "reviewer-local"))
        .toThrow(/all review items must be confirmed or rejected/);
      expect(minutes.review(reviewId)?.status).toBe("draft");

      expect(minutes.replaceDraft({
        meetingId,
        transcriptVersionId,
        referencedMaterials: [{ ...material, reviewState: "confirmed" }],
      })).toBe(reviewId);
      minutes.confirmReview(reviewId, "reviewer-local");
      expect(storedMaterials()).toEqual([{ ...expected, review_state: "confirmed" }]);
      expect(minutes.reviewForMeeting(meetingId, transcriptVersionId)).toMatchObject({
        reviewId,
        status: "confirmed",
        confirmedBy: "reviewer-local",
        confirmedAt: expect.any(Number),
      });
      expect(minutes.databaseHandle().query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      legacy.close();
    }
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
    selectCanonical(minutes, meetingId, transcriptVersionId);
    minutes.databaseHandle().run("DROP TRIGGER trg_finalized_transcript_lines_no_delete");
    minutes.databaseHandle().run(
      "DELETE FROM transcript_version_lines WHERE transcript_version_id = ? AND seq = 2",
      [transcriptVersionId],
    );
    minutes.databaseHandle().run(
      "UPDATE transcript_versions SET content_sha256 = ? WHERE transcript_version_id = ?",
      [transcriptContentSha256(minutes, transcriptVersionId), transcriptVersionId],
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


  test("widens the artifacts CHECK to minutes_docx so legacy databases accept the new artifact", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    db.run(`CREATE TABLE artifact_bundles (
      bundle_id TEXT PRIMARY KEY, meeting_id INTEGER NOT NULL, review_id TEXT NOT NULL,
      transcript_version_id TEXT NOT NULL, bundle_path TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, completed_at INTEGER
    )`);
    db.run(`CREATE TABLE artifacts (
      artifact_id TEXT PRIMARY KEY, bundle_id TEXT NOT NULL,
      artifact_type TEXT NOT NULL CHECK (artifact_type IN ('minutes_pdf','minutes_json','canonical_transcript','slide_deck','original_audio')),
      relative_path TEXT NOT NULL, media_type TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      byte_length INTEGER NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE (bundle_id, artifact_type),
      FOREIGN KEY (bundle_id) REFERENCES artifact_bundles(bundle_id) ON DELETE CASCADE
    )`);
    db.run("INSERT INTO artifact_bundles VALUES ('legacy-bundle', 1, 'review-1', 'transcript-1', '/bundle', 'complete', 1, 1)");
    db.run(`INSERT INTO artifacts VALUES ('legacy-artifact', 'legacy-bundle', 'minutes_pdf', 'minutes.pdf', 'application/pdf', '${"a".repeat(64)}', 10, 1)`);

    const minutes = new MinutesStore(db);
    expect(minutes.databaseHandle().query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'").get())
      .toEqual(expect.objectContaining({ sql: expect.stringContaining("'minutes_docx'") }));
    // 이전 데이터는 보존되고, 새 CHECK가 minutes_docx 삽입을 허용한다.
    minutes.databaseHandle().run(`INSERT INTO artifacts VALUES ('docx-artifact', 'legacy-bundle', 'minutes_docx', 'minutes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '${"b".repeat(64)}', 10, 1)`);
    expect(minutes.databaseHandle().query("SELECT artifact_type FROM artifacts ORDER BY artifact_type").all()).toEqual([
      { artifact_type: "minutes_docx" }, { artifact_type: "minutes_pdf" },
    ]);
    db.close();
  });

  test("saveCandidates persists a summary and reviewForMeeting round-trips it after reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-summary-"));
    const dbPath = join(dir, "meetings.db");
    const firstLegacy = new MeetingStore(dbPath);
    const first = new MinutesStore(firstLegacy.databaseHandle());
    const { meetingId, transcriptVersionId } = preparedTranscript(first);
    const summary = {
      overview: "Ship Friday and Alice owns QA.",
      topics: [{
        title: "Launch",
        summary: "Ship on Friday.",
        source: { transcript_version_id: transcriptVersionId, start_seq: 1, end_seq: 1 },
      }],
    };
    const reviewId = first.saveCandidates({
      meetingId,
      transcriptVersionId,
      decisions: [{
        description: "Ship Friday",
        evidenceQuote: "Ship on Friday.",
        source: { transcriptVersionId, startSeq: 1, endSeq: 1 },
      }],
      summary,
    });
    expect(first.reviewForMeeting(meetingId, transcriptVersionId)).toMatchObject({ reviewId, summary });
    firstLegacy.close();

    const reopenedLegacy = new MeetingStore(dbPath);
    const reopened = new MinutesStore(reopenedLegacy.databaseHandle());
    expect(reopened.review(reviewId)?.summary).toEqual(summary);
    expect(reopened.reviewForMeeting(meetingId, transcriptVersionId)?.summary).toEqual(summary);
    reopenedLegacy.close();
    rmSync(dir, { recursive: true, force: true });
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
      "review_summaries", "artifact_bundles", "artifacts", "meeting_conclusions",
    ]) expect(names).toContain(required);
    legacy.close();
  });
});
