import type { MinutesStore, ReviewState } from "./minutes-store.ts";
import type { MeetingConcluded, ReviewUpdate } from "./protocol.ts";

export function conclusionForReview(minutesStore: MinutesStore, reviewId: string): MeetingConcluded | null {
  const row = minutesStore.databaseHandle().query(`
    SELECT meeting_id, review_id, transcript_version_id, bundle_id, bundle_path,
      manifest_sha256, target_commit, concluded_at
    FROM meeting_conclusions WHERE review_id = ?
  `).get(reviewId) as {
    meeting_id: number; review_id: string; transcript_version_id: string;
    bundle_id: string; bundle_path: string; manifest_sha256: string;
    target_commit: string; concluded_at: number;
  } | null;
  return row && {
    type: "meetingConcluded", concluded: true, meetingId: row.meeting_id,
    reviewId: row.review_id, transcriptVersionId: row.transcript_version_id,
    bundleId: row.bundle_id, bundlePath: row.bundle_path,
    manifest: { sha256: row.manifest_sha256, targetCommit: row.target_commit },
    concludedAt: row.concluded_at,
  };
}

/** Rebuild the wire payload exclusively from durable rows; no process cache is authoritative. */
export function reviewSnapshotForMeeting(minutesStore: MinutesStore, meetingId: number): ReviewUpdate | null {
  const canonical = minutesStore.canonicalVersion(meetingId);
  if (!canonical) return null;
  const review = minutesStore.reviewForMeeting(meetingId, canonical.transcriptVersionId);
  if (!review) return null;
  const lines = minutesStore.transcriptVersionLines(review.transcriptVersionId).map((line) => ({
    seq: line.seq, speakerTurn: line.speakerTurn, text: line.text,
  }));
  const segmentText = (startSeq: number, endSeq: number) => lines
    .filter((line) => line.seq >= startSeq && line.seq <= endSeq)
    .map((line) => line.text).join("\n");
  const items = minutesStore.itemsForReview(review.reviewId).map((raw) => {
    const source = raw.source as { transcriptVersionId: string; startSeq: number; endSeq: number };
    return {
      id: String(raw.id),
      kind: raw.kind as "decision" | "action_item" | "open_item",
      description: raw.description,
      sourceSegment: {
        transcript_version_id: source.transcriptVersionId,
        start_seq: source.startSeq,
        end_seq: source.endSeq,
      },
      evidenceQuote: String(raw.evidenceQuote),
      segment_text: segmentText(source.startSeq, source.endSeq),
      reviewState: raw.reviewState as ReviewState,
      attributedAttendeeId: raw.attributedAttendeeId as string | null,
      ...(raw.kind === "action_item" ? {
        assigneeAttendeeId: raw.assigneeAttendeeId as string | null,
        deadline: raw.deadline as string | null,
        deadlineText: raw.deadlineText as string | null,
      } : {}),
    };
  });
  return {
    type: "review", meetingId, reviewId: review.reviewId,
    transcriptVersionId: review.transcriptVersionId,
    status: review.status, confirmedAt: review.confirmedAt, confirmedBy: review.confirmedBy,
    conclusion: conclusionForReview(minutesStore, review.reviewId),
    attendees: minutesStore.attendeesFor(meetingId).map(({ attendeeId, displayName }) => ({ attendeeId, displayName })),
    transcript: { lines }, items,
    summary: review.summary,
  };
}
