import type { MinutesExtractionInput, MinutesExtractionResult } from "./minutes-extraction-types.ts";
import type { MinutesStore } from "./minutes-store.ts";
import type { ReviewUpdate } from "./protocol.ts";
import { reviewSnapshotForMeeting } from "./review-snapshot.ts";

interface Extractor {
  extract(request: MinutesExtractionInput): Promise<MinutesExtractionResult>;
}

export interface StartReviewInput {
  meetingId: number;
  store: MinutesStore;
  extractor: Extractor;
  meetingDate?: string;
  timeZone?: string;
  notes?: string;
}

function meetingDateFor(store: MinutesStore, meetingId: number): string {
  const row = store.databaseHandle().query("SELECT started_at FROM meetings WHERE id = ?").get(meetingId) as
    { started_at: number } | null;
  if (!row) throw new Error(`unknown meeting ${meetingId}`);
  return new Date(row.started_at).toISOString().slice(0, 10);
}

export async function startReview(input: StartReviewInput): Promise<ReviewUpdate> {
  const meeting = input.store.meetingMeta(input.meetingId);
  if (!meeting) throw new Error(`unknown meeting ${input.meetingId}`);
  if (meeting.phase !== "ended") throw new Error(`meeting ${input.meetingId} must be ended before review`);

  const canonical = input.store.canonicalVersion(input.meetingId);
  if (!canonical) throw new Error(`meeting ${input.meetingId} has no canonical transcript version`);

  const attendees = input.store.attendeesFor(input.meetingId).map((attendee) => ({
    attendeeId: attendee.attendeeId,
    displayName: attendee.displayName,
  }));
  const lines = input.store.transcriptVersionLines(canonical.transcriptVersionId).map((line) => ({
    seq: line.seq,
    speakerTurn: line.speakerTurn,
    text: line.text,
  }));
  const request: MinutesExtractionInput = {
    schemaVersion: 1,
    meetingDate: input.meetingDate ?? meetingDateFor(input.store, input.meetingId),
    timeZone: input.timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    transcriptVersionId: canonical.transcriptVersionId,
    attendees,
    lines,
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
  };
  const result = await input.extractor.extract(request);
  if (result.transcriptVersionId !== canonical.transcriptVersionId) {
    throw new Error(`extractor returned wrong transcript version ${result.transcriptVersionId}`);
  }

  input.store.replaceDraft({
    meetingId: input.meetingId,
    transcriptVersionId: canonical.transcriptVersionId,
    decisions: result.decisions.map((item) => ({
      id: item.id,
      description: item.description,
      evidenceQuote: item.evidenceQuote,
      source: {
        transcriptVersionId: item.sourceSegment.transcript_version_id,
        startSeq: item.sourceSegment.start_seq,
        endSeq: item.sourceSegment.end_seq,
      },
      attributedAttendeeId: item.suggestedAttributionAttendeeId,
      origin: item.origin,
    })),
    actionItems: result.actionItems.map((item) => ({
      id: item.id,
      description: item.description,
      evidenceQuote: item.evidenceQuote,
      source: {
        transcriptVersionId: item.sourceSegment.transcript_version_id,
        startSeq: item.sourceSegment.start_seq,
        endSeq: item.sourceSegment.end_seq,
      },
      attributedAttendeeId: item.suggestedAttributionAttendeeId,
      assigneeAttendeeId: item.suggestedAssigneeAttendeeId,
      deadline: item.deadline,
      deadlineText: item.deadlineText,
      origin: item.origin,
    })),
    openItems: result.openItems.map((item) => ({
      id: item.id,
      description: item.description,
      evidenceQuote: item.evidenceQuote,
      source: {
        transcriptVersionId: item.sourceSegment.transcript_version_id,
        startSeq: item.sourceSegment.start_seq,
        endSeq: item.sourceSegment.end_seq,
      },
      attributedAttendeeId: item.suggestedAttributionAttendeeId,
      origin: item.origin,
    })),
    summary: result.summary,
  });

  const snapshot = reviewSnapshotForMeeting(input.store, input.meetingId);
  if (!snapshot) throw new Error(`review snapshot for meeting ${input.meetingId} was not persisted`);
  return result.usedFallback ? { ...snapshot, usedFallback: true } : snapshot;
}
