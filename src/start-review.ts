import { randomUUID } from "node:crypto";

import type { MinutesExtractionInput, MinutesExtractionResult } from "./extract.ts";
import type { MinutesStore } from "./minutes-store.ts";
import type { ReviewUpdate } from "./session.ts";

interface Extractor {
  extract(request: MinutesExtractionInput): Promise<MinutesExtractionResult>;
}

export interface StartReviewInput {
  meetingId: number;
  store: MinutesStore;
  extractor: Extractor;
  meetingDate?: string;
  timeZone?: string;
}

function meetingDateFor(store: MinutesStore, meetingId: number): string {
  const row = store.databaseHandle().query("SELECT started_at FROM meetings WHERE id = ?").get(meetingId) as
    { started_at: number } | null;
  if (!row) throw new Error(`unknown meeting ${meetingId}`);
  return new Date(row.started_at).toISOString().slice(0, 10);
}

function itemPayload(
  result: MinutesExtractionResult,
  lines: MinutesExtractionInput["lines"],
): ReviewUpdate["items"] {
  const segmentText = (source: { start_seq: number; end_seq: number }): string => lines
    .filter((line) => line.seq >= source.start_seq && line.seq <= source.end_seq)
    .map((line) => line.text)
    .join("\n");
  return [
    ...result.decisions.map((item) => ({
      id: item.id,
      kind: "decision" as const,
      description: item.description,
      sourceSegment: item.sourceSegment,
      evidenceQuote: item.evidenceQuote,
      segment_text: segmentText(item.sourceSegment),
      attributedAttendeeId: item.suggestedAttributionAttendeeId,
    })),
    ...result.actionItems.map((item) => ({
      id: item.id,
      kind: "action_item" as const,
      description: item.description,
      sourceSegment: item.sourceSegment,
      evidenceQuote: item.evidenceQuote,
      segment_text: segmentText(item.sourceSegment),
      attributedAttendeeId: item.suggestedAttributionAttendeeId,
      assigneeAttendeeId: item.suggestedAssigneeAttendeeId,
      deadline: item.deadline,
      deadlineText: item.deadlineText,
    })),
    ...result.openItems.map((item) => ({
      id: item.id,
      kind: "open_item" as const,
      description: item.description,
      sourceSegment: item.sourceSegment,
      evidenceQuote: item.evidenceQuote,
      segment_text: segmentText(item.sourceSegment),
      attributedAttendeeId: item.suggestedAttributionAttendeeId,
    })),
  ];
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
  };
  const result = await input.extractor.extract(request);
  if (result.transcriptVersionId !== canonical.transcriptVersionId) {
    throw new Error(`extractor returned wrong transcript version ${result.transcriptVersionId}`);
  }

  return {
    type: "review",
    reviewId: randomUUID(),
    transcriptVersionId: canonical.transcriptVersionId,
    items: itemPayload(result, lines),
    attendees,
    transcript: { lines },
  };
}
