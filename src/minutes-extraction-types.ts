export interface SourceSegmentRef {
  transcript_version_id: string;
  start_seq: number;
  end_seq: number;
}

export interface MinutesExtractionInput {
  schemaVersion: string | number;
  meetingDate: string;
  timeZone: string;
  transcriptVersionId: string;
  attendees: Array<{ attendeeId: string; displayName: string }>;
  lines: Array<{ seq: number; speakerTurn: number | null; text: string }>;
  notes?: string;
}

export type CandidateKind = "decision" | "action_item" | "open_item";
export type CandidateRejectionCode =
  | "missing_source" | "missing_description" | "wrong_transcript_version" | "invalid_seq_range"
  | "line_not_in_request" | "attendee_not_in_request" | "line_not_found" | "non_contiguous_range"
  | "evidence_quote_mismatch";

export interface CandidateRejection {
  kind: CandidateKind | "batch" | "topic";
  candidateIndex: number;
  code: CandidateRejectionCode;
}

export interface ExtractedSummaryTopic {
  title: string;
  summary: string;
  source: SourceSegmentRef;
}

export interface ExtractedSummary {
  overview: string;
  topics: ExtractedSummaryTopic[];
}

export interface ExtractedBase {
  id: string;
  description: string;
  sourceSegment: SourceSegmentRef;
  evidenceQuote: string;
  suggestedAttributionAttendeeId: string | null;
  origin: "llm" | "local_rule";
}

export interface ExtractedDecision extends ExtractedBase {}
export interface ExtractedActionItem extends ExtractedBase {
  suggestedAssigneeAttendeeId: string | null;
  deadline: string | null;
  deadlineText: string | null;
}
export interface ExtractedOpenItem extends ExtractedBase {}

export interface MinutesExtractionResult {
  transcriptVersionId: string;
  decisions: ExtractedDecision[];
  actionItems: ExtractedActionItem[];
  openItems: ExtractedOpenItem[];
  rejections: CandidateRejection[];
  batchFailed: boolean;
  usedFallback: boolean;
  summary: ExtractedSummary | null;
}
