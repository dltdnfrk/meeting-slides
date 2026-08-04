export type TranscriptSourceKind = "live_capture" | "file_transcription" | "retranscription" | "import";
export type ReviewState = "candidate" | "confirmed" | "rejected";
export type CandidateOrigin = "llm" | "local_rule" | "manual";

export interface AttendeeInput {
  attendeeId: string;
  displayName: string;
  crmPersonEntityId?: string | null;
  sortOrder?: number;
}

export interface SourceRange {
  transcriptVersionId: string;
  startSeq: number;
  endSeq: number;
}

interface CandidateBase {
  id?: string;
  description: string;
  source: SourceRange;
  attributedAttendeeId?: string | null;
  origin?: CandidateOrigin;
  reviewState?: ReviewState;
}

export interface DecisionCandidate extends CandidateBase {}
export interface ActionItemCandidate extends CandidateBase {
  assigneeAttendeeId?: string | null;
  deadline?: string | null;
  deadlineText?: string | null;
}
export interface OpenItemCandidate extends CandidateBase {}

export interface ReferencedMaterialCandidate {
  id?: string;
  materialType: "document" | "figure" | "link" | "data" | "other";
  title?: string | null;
  uri?: string | null;
  notes?: string | null;
  source?: SourceRange | null;
  reviewState?: ReviewState;
}

export interface SaveCandidatesInput {
  meetingId: number;
  transcriptVersionId: string;
  reviewId?: string;
  decisions?: DecisionCandidate[];
  actionItems?: ActionItemCandidate[];
  openItems?: OpenItemCandidate[];
  referencedMaterials?: ReferencedMaterialCandidate[];
}

export interface TranscriptLineInput {
  seq: number;
  capturedAtMs?: number | null;
  audioStartMs?: number | null;
  audioEndMs?: number | null;
  speakerTurn?: number | null;
  text: string;
}

export type ReviewMutationErrorCode =
  | "REVIEW_NOT_DRAFT"
  | "UNKNOWN_REVIEW_ITEM"
  | "INVALID_REVIEW_PATCH"
  | "ATTENDEE_NOT_IN_MEETING"
  | "INCOMPLETE_REVIEW_ITEM"
  | "PENDING_REVIEW_ITEMS"
  | "STALE_TRANSCRIPT_VERSION"
  | "TRANSCRIPT_INTEGRITY_FAILED"
  | "INVALID_SOURCE_SEGMENT";

export interface TranscriptVersion {
  transcriptVersionId: string;
  meetingId: number;
  versionNo: number;
  sourceKind: TranscriptSourceKind;
  engine: string | null;
  engineModel: string | null;
  finalizedAt: number | null;
  contentSha256: string | null;
}
