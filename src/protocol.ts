// Wire contracts only. Type-only dependencies keep transport consumers independent
// of session runtime initialization; Slide remains owned by the session model.
import type { Slide } from "./session.ts";
import type { SceneDeck } from "./scene-graph.js";
import type { GeometrySlide } from "./slides/geometry/contract.ts";
import type { SlidePlan } from "./slides/model/plan.ts";

export interface SlideUpdate {
  type: "slide";
  current: Slide | null;
  history: Slide[];
}

export interface CaptionUpdate {
  type: "caption";
  text: string;
  ts: number;
  speaker?: number;
}

export interface StatusUpdate {
  type: "status";
  text: string;
  /** Present on review mutation failures so stale tabs cannot misattribute the error. */
  mutationAction?: "updateItem" | "confirmReview";
  meetingId?: number | null;
  reviewId?: string | null;
  itemId?: string | null;
}

export interface TranscriptEntry {
  text: string;
  ts: number;
  audioStartMs?: number;
  audioEndMs?: number;
  speaker?: number;
}

export interface TranscriptUpdate {
  type: "transcript";
  entries: TranscriptEntry[];
  reason?: "snapshot" | "export";
  /** 로그 상한 도달로 예전 문장이 잘렸는지 여부 (내보내기 시 경고 표시용) */
  truncated?: boolean;
}

/** 실시간 전사 피드용 확정 문장 한 줄 */
export interface LineUpdate {
  type: "line";
  text: string;
  ts: number;
  speaker?: number;
}

export interface ProviderInfo {
  id: string;
  label: string;
  detail: string;
  /** True only when authentication was positively verified. */
  available: boolean;
  /** Installed providers with unverifiable auth remain explicitly selectable. */
  selectable?: boolean;
  installed?: boolean;
  auth?: "connected" | "disconnected" | "unknown" | "unavailable";
  version?: string;
  models?: string[];
  efforts?: string[];
}

export interface ProvidersUpdate {
  type: "providers";
  list: ProviderInfo[];
  current: string;
  currentModel?: string;
  currentEffort?: string;
}

export type CapturePhase = "idle" | "starting" | "capturing" | "stopping" | "switching-model";

export interface CaptureUpdate {
  type: "capture";
  capturing: boolean;
  mode: string;
  phase?: CapturePhase;
  modelPath?: string;
  selectedModelId?: SttModelInfo["id"];
  /** 서버 기준 녹음 시작 시각. 재연결 뒤에도 경과 시간을 이어서 표시한다. */
  startedAt?: number;
  /** Live capture origin. Absent on file-mode snapshots. */
  audioSource?: "mic" | "system";
}

export interface SttModelInfo {
  id: import("./stt-model-catalog.js").SttModelId;
  label: string;
  sizeBytes: number;
  license: import("./stt-model-catalog.js").SttLicense;
  status: "absent" | "downloading" | "installed" | "selected" | "failed";
  path?: string;
  receivedBytes?: number;
  totalBytes?: number;
  error?: string;
}

export interface SttModelsUpdate {
  type: "sttModels";
  models: SttModelInfo[];
  selectedModelId: SttModelInfo["id"] | null;
}

export interface MeetingsUpdate {
  type: "meetings";
  items: Array<{
    id: number;
    title: string;
    started_at: number;
    status: "open" | "ended";
  }>;
}

export interface AttendeesUpdate {
  type: "attendees";
  meeting_id: number | null;
  attendees: Array<{
    attendee_id: string;
    display_name: string;
    crm_person_entity_id?: string;
  }>;
}

export interface ReviewUpdate {
  type: "review";
  meetingId?: number;
  reviewId: string;
  transcriptVersionId: string;
  usedFallback?: boolean;
  status?: "draft" | "confirmed";
  confirmedAt?: number | null;
  confirmedBy?: string | null;
  conclusion?: MeetingConcluded | null;
  summary?: {
    overview: string;
    topics: Array<{
      title: string;
      summary: string;
      source: {
        transcript_version_id: string;
        start_seq: number;
        end_seq: number;
      };
    }>;
  } | null;
  attendees: Array<{ attendeeId: string; displayName: string }>;
  transcript: {
    lines: Array<{ seq: number; speakerTurn: number | null; text: string }>;
  };
  items: Array<{
    id: string;
    kind: "decision" | "action_item" | "open_item";
    description: string;
    sourceSegment: {
      transcript_version_id: string;
      start_seq: number;
      end_seq: number;
    };
    evidenceQuote: string;
    segment_text: string;
    reviewState?: "candidate" | "confirmed" | "rejected";
    attributedAttendeeId: string | null;
    assigneeAttendeeId?: string | null;
    deadline?: string | null;
    deadlineText?: string | null;
  }>;
}

export interface ReviewItemUpdated {
  type: "reviewItemUpdated";
  meetingId: number;
  reviewId: string;
  itemId: string;
  kind: "decision" | "action_item" | "open_item";
}

export interface ReviewConfirmed {
  type: "reviewConfirmed";
  meetingId: number;
  reviewId: string;
  transcriptVersionId: string;
  confirmedAt: number;
}

export interface MeetingConcluded {
  type: "meetingConcluded";
  concluded: true;
  meetingId: number;
  reviewId: string;
  transcriptVersionId: string;
  bundleId: string;
  bundlePath: string;
  manifest: { sha256: string; targetCommit: string };
  concludedAt: number;
}

/** LLM 블록 감지 진행 표시 (관찰성: 사람·AI 모두 "지금 만드는 중"을 읽을 수 있게) */
export interface DetectUpdate {
  type: "detect";
  detecting: boolean;
}

/** 저장 완료 경로 표시 */
export interface SavedUpdate {
  type: "saved";
  path: string;
}

export type CompileJobId = `compile-${string}`;
export type ExportJobId = `png-${string}` | `pdf-${string}` | `pptx-${string}`;
export type JobStage =
  | "planning" | "render" | "publish" | "prepare" | "validate" | "preview" | "review" | "design-gate"
  | "assets" | "layouts" | "geometry" | "standalone" | "pptx" | "raster" | "publication";

export interface CompileUpdate {
  type: "compile";
  status: "started" | "progress" | "success" | "error" | "timeout";
  jobId: CompileJobId;
  meetingId?: number;
  stage?: JobStage;
  completed?: number;
  total?: number;
  path?: string;
  publicationStatus?: "draft" | "final";
  code?: "stale-review-lineage";
  outline?: {
    title: string;
    style: string;
    slideCount: number;
    usedFallback: boolean;
    plannerError: string | null;
  };
  /** 생성 직후 앱에서 결과를 미리 볼 수 있도록 함께 보내는 장면 그래프 */
  scene?: SceneDeck;
  error?: string;
}

export interface ExportUpdate {
  type: "export";
  status: "started" | "progress" | "success" | "error" | "timeout";
  action: "exportPdf" | "exportPng";
  jobId: ExportJobId;
  meetingId?: number;
  stage?: JobStage;
  completed?: number;
  total?: number;
  path?: string;
  code?: "job-busy" | "invalid-meeting-id" | "meeting-not-found" | "slide-plan-required" | "process-failed" | "review-failed" | "timeout";
  error?: string;
}

export interface MeetingDetailUpdate {
  type: "meeting";
  meetingId: number;
  title: string;
  purpose: string | null;
  transcript: TranscriptEntry[];
  current: Slide | null;
  history: Slide[];
  compiled: null | { title: string; slideCount: number; compiledAt: number; publishedAt: number | null };
  review?: ReviewUpdate | null;
  conclusion?: MeetingConcluded | null;
  slidePlan?: {
    plan: SlidePlan;
    path: string;
    publicationSha256: string;
    publicationStatus: "draft" | "final";
    publicationSeq: number;
    publishedAt: number;
    reviewId?: string;
    reviewedItemIds?: readonly string[];
    geometry?: readonly GeometrySlide[];
  };
}

export type ServerMessage =
  | SlideUpdate
  | CaptionUpdate
  | StatusUpdate
  | TranscriptUpdate
  | ProvidersUpdate
  | CaptureUpdate
  | SttModelsUpdate
  | MeetingsUpdate
  | LineUpdate
  | DetectUpdate
  | SavedUpdate
  | CompileUpdate
  | ExportUpdate
  | MeetingDetailUpdate
  | AttendeesUpdate
  | ReviewUpdate
  | ReviewItemUpdated
  | ReviewConfirmed
  | MeetingConcluded
  | AskUpdate
  | RefineUpdate;

export interface AskUpdate {
  type: "ask";
  requestId: string;
  answer: string;
  matchedCount: number;
  error?: string;
}

export interface RefineUpdate {
  type: "refine";
  requestId: string;
  slideId: string;
  path: string;
  before: string;
  after: string;
  claimIds: string[];
  error?: string;
}

export type ClientAction =
  | { action: "startCapture"; meeting_id?: number }
  | { action: "audio"; data: string }
  | { action: "setCaptureSource"; source: "mic" | "system" }
  | { action: "stopCapture" | "reset" | "status" | "listMeetings" | "transcript" | "recheckProviders" | "recheckSttModels" | "attendees" }
  | { action: "startReview"; meetingId: number; notes?: string; retry?: boolean }
  | { action: "deleteMeeting" | "selectMeeting"; meetingId: number }
  | { action: "compileSlidePlan" | "exportDeck" | "exportPdf" | "exportPng" | "saveNotes" | "saveTranscript" | "saveJson"; meetingId?: number }
  | { action: "persistSlidePlan"; meetingId?: number; plan: unknown }
  | { action: "setProvider"; id: string; model?: string; effort?: string }
  | { action: "connectProvider"; id: string }
  | { action: "setProviderKey"; id: string; key: string }
  | { action: "setAttendees"; purpose?: string | null; attendees: Array<{ name: string; attendeeId?: string; crmPersonId?: string | null }> }
  | { action: "updateItem"; meetingId?: number; reviewId: string; itemId: string; kind: "decision" | "action_item" | "open_item"; patch: Record<string, unknown> }
  | { action: "confirmReview"; meetingId?: number; reviewId: string }
  | { action: "ask"; meetingId: number; question: string; requestId?: string }
  | { action: "refineSlideField"; meetingId: number; slideId: string; path: string; text: string; instruction: string; claimIds: string[]; requestId?: string }
  | { action: "installSttModel" | "cancelSttModel" | "selectSttModel"; modelId: SttModelInfo["id"] };

export type ClientListener = (msg: ServerMessage) => void;
