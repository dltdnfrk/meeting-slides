// ============================================================
// session.ts - 회의 세션 상태 머신
// ============================================================
// 전사 청크를 누적하고, 주기적으로 LLM에 블록 감지를 요청한다.
// 블록 전환 감지 시 WebSocket 클라이언트에 슬라이드 push.

import {
  deriveFallbackMeetingCard,
  isLowQualityMeetingCard,
  type BlockDetectionResult,
  type BlockDetector,
} from "./llm.js";
import {
  composeNarrativeDeck,
  type NarrativeSlide,
  type SceneDeck,
  type SceneSlide,
} from "./scene-graph.js";
import type { LiveMeetingCard } from "./slide-spec.js";
import type { TranscriptChunk } from "./whisper.js";

export interface Slide extends LiveMeetingCard {
  index: number;
  startedAt: number;
  sentenceCount: number;
  scene?: SceneSlide;
}

function sceneForCard(card: LiveMeetingCard, index: number): SceneSlide {
  let narrative: NarrativeSlide;
  if (card.kind === "cover") {
    narrative = { intent: "cover", title: card.title, ...(card.emphasis ? { subtitle: card.emphasis } : {}) };
  } else if (card.kind === "decision") {
    narrative = {
      intent: "decision",
      title: card.title,
      decision: card.emphasis ?? card.title,
      ...(card.bullets.length > 0 ? { rationale: card.bullets.join(" ") } : {}),
    };
  } else if (card.kind === "actions") {
    narrative = {
      intent: "actions",
      title: card.title,
      items: (card.bullets.length > 0 ? card.bullets : [card.emphasis ?? card.title])
        .map((task) => ({ task })),
    };
  } else {
    narrative = {
      intent: "statement",
      title: card.title,
      statement: card.bullets.join(" ") || card.emphasis || card.title,
      ...(card.emphasis && card.bullets.length > 0 ? { support: card.emphasis } : {}),
    };
  }
  return composeNarrativeDeck({ meetingId: 0, title: card.title, slides: [narrative] }).slides[0]!;
}

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
}

export interface TranscriptEntry {
  text: string;
  ts: number;
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

/** 영속 저장소 연결용 싱크 (server.ts에서 MeetingStore로 연결) */
export interface MeetingSink {
  onLine(entry: TranscriptEntry): void;
  onSlide(slide: Slide): void;
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
}

export interface SttModelInfo {
  id: "small" | "medium" | "large-v3-turbo" | "large-v3";
  label: string;
  sizeBytes: number;
  license: "MIT" | "Apache-2.0";
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
  meeting_id: number;
  attendees: Array<{
    attendee_id: string;
    display_name: string;
    crm_person_entity_id?: string;
  }>;
}

export interface ReviewUpdate {
  type: "review";
  reviewId: string;
  transcriptVersionId: string;
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
    attributedAttendeeId: string | null;
    assigneeAttendeeId?: string | null;
    deadline?: string | null;
    deadlineText?: string | null;
  }>;
}

export interface ReviewItemUpdated {
  type: "reviewItemUpdated";
  reviewId: string;
  itemId: string;
  kind: "decision" | "action_item" | "open_item";
}

export interface ReviewConfirmed {
  type: "reviewConfirmed";
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
export type JobStage = "planning" | "render" | "publish" | "prepare" | "validate" | "preview" | "review" | "design-gate";

export interface CompileUpdate {
  type: "compile";
  status: "started" | "progress" | "success" | "error" | "timeout";
  jobId: CompileJobId;
  meetingId?: number;
  stage?: JobStage;
  completed?: number;
  total?: number;
  path?: string;
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
  action: "exportPdf" | "exportPng" | "exportPptx";
  jobId: ExportJobId;
  meetingId?: number;
  stage?: JobStage;
  completed?: number;
  total?: number;
  path?: string;
  code?: "job-busy" | "invalid-meeting-id" | "meeting-not-found" | "process-failed" | "review-failed" | "timeout";
  error?: string;
}

export interface MeetingDetailUpdate {
  type: "meeting";
  meetingId: number;
  title: string;
  transcript: TranscriptEntry[];
  current: Slide | null;
  history: Slide[];
  compiled: null | { title: string; slideCount: number; compiledAt: number; publishedAt: number | null };
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
  | MeetingConcluded;

export type ClientAction =
  | { action: "startCapture"; meeting_id?: number }
  | { action: "stopCapture" | "reset" | "status" | "listMeetings" | "transcript" | "recheckProviders" | "recheckSttModels" | "attendees" | "startReview" }
  | { action: "deleteMeeting"; meetingId: number }
  | { action: "selectMeeting" | "compileDeck" | "compileTranscriptSnapshot" | "exportDeck" | "exportPptx" | "exportPdf" | "exportPng" | "saveNotes" | "saveTranscript" | "saveJson"; meetingId?: number }
  | { action: "setProvider"; id: string; model?: string; effort?: string }
  | { action: "connectProvider"; id: string }
  | { action: "setProviderKey"; id: string; key: string }
  | { action: "setAttendees"; attendees: Array<{ name: string; crmPersonId?: string }> }
  | { action: "updateItem"; reviewId: string; itemId: string; kind: "decision" | "action_item" | "open_item"; patch: Record<string, unknown> }
  | { action: "confirmReview"; reviewId: string }
  | { action: "installSttModel" | "cancelSttModel" | "selectSttModel"; modelId: SttModelInfo["id"] };

export type ClientListener = (msg: ServerMessage) => void;

export interface MeetingSessionOptions {
  automaticDetection?: boolean;
}

export class MeetingSession {
  private sentences: string[] = [];
  // 전사본보내기용 전체 로그. sentences[]는 LLM 컨텍스트용이라 상한(200)을
  // 두지만, 전사 원문은 회의 끝까지 전부 보관한다 (50k 안전 상한).
  private transcriptLog: TranscriptEntry[] = [];
  private transcriptTruncated = false;
  private static readonly MAX_TRANSCRIPT_ENTRIES = 50_000;
  private currentSlide: Slide | null = null;
  private history: Slide[] = [];
  private slideIndex = 0;
  private lastDetectCount = 0;
  private detecting = false;
  private captionBuffer = "";
  private captionSpeaker: number | undefined = undefined;
  private captionFlushTimer: NodeJS.Timeout | null = null;
  private epoch = 0;
  private advanceStreak = 0;
  private pendingAdvanceTitle: string | null = null;
  private static readonly MAX_SENTENCES = 200;
  private static readonly ADVANCE_THRESHOLD = 2;
  private readonly automaticDetection: boolean;

  constructor(
    private llm: BlockDetector,
    private detectInterval: number,
    private contextWindow: number,
    private listeners: Set<ClientListener>,
    private sink: MeetingSink | null = null,
    options: MeetingSessionOptions = {},
  ) {
    this.automaticDetection = options.automaticDetection ?? true;
  }

  addListener(l: ClientListener) { this.listeners.add(l); }
  removeListener(l: ClientListener) { this.listeners.delete(l); }

  /** 런타임에 LLM 백엔드 교체 (사용자 프로바이더 선택). 다음 감지부터 적용. */
  setDetector(detector: BlockDetector): void {
    this.llm = detector;
  }

  snapshot(): SlideUpdate {
    return { type: "slide", current: this.currentSlide, history: [...this.history] };
  }

  transcript(reason: "snapshot" | "export" = "export"): TranscriptUpdate {
    return {
      type: "transcript",
      entries: [...this.transcriptLog],
      reason,
      truncated: this.transcriptTruncated,
    };
  }

  async flush(): Promise<void> {
    this.flushCaption();
    if (!this.automaticDetection) return;
    // 진행 중 감지가 끝날 때까지 대기 — LLM 타임아웃(30s) 상한 보다 충분히 큰 40s로 가드.
    const deadline = Date.now() + 40_000;
    while (this.detecting && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    if (this.detecting) {
      // 가드 타임아웃 — 감지가 멈추지 않으면 강제로 플래그 해제.
      this.detecting = false;
      this.broadcast({ type: "detect", detecting: false });
      this.broadcast({ type: "status", text: "감지 대기 시간 초과 — 강제 종료" });
    }
    if (this.sentences.length === 0 || this.sentences.length === this.lastDetectCount) {
      return;
    }
    this.lastDetectCount = this.sentences.length;
    await this.maybeDetect();
  }

  private broadcast(msg: ServerMessage) {
    for (const l of this.listeners) {
      try { l(msg); } catch {}
    }
  }

  onChunk(chunk: TranscriptChunk): void {
    this.sentences.push(chunk.text);
    const entry: TranscriptEntry = { text: chunk.text, ts: chunk.ts, speaker: chunk.speaker };
    this.transcriptLog.push(entry);
    // 실시간 전사 피드 + 영속 저장 (anarlog 방식)
    this.broadcast({ type: "line", text: chunk.text, ts: chunk.ts, speaker: chunk.speaker });
    // 싱크(영속 저장) 실패가 세션을 죽이지 않도록 격리
    try {
      this.sink?.onLine(entry);
    } catch (e) {
      console.error("[store] 라인 저장 실패:", e);
    }
    if (this.transcriptLog.length > MeetingSession.MAX_TRANSCRIPT_ENTRIES) {
      this.transcriptLog.shift();
      this.transcriptTruncated = true;
    }
    // 장시간 회의 메모리 상한
    if (this.sentences.length > MeetingSession.MAX_SENTENCES) {
      const removed = this.sentences.length - MeetingSession.MAX_SENTENCES;
      this.sentences = this.sentences.slice(-MeetingSession.MAX_SENTENCES);
      this.lastDetectCount = Math.max(0, this.lastDetectCount - removed);
    }

    // 실시간 자막: 화자가 바뀌면 기존 버퍼를 먼저 보내고 새 화자로 시작.
    // 그 후 200ms 디바운스로 묶어서 브로드캐스트.
    if (chunk.speaker !== undefined && this.captionSpeaker !== undefined && chunk.speaker !== this.captionSpeaker) {
      this.flushCaption();
    }
    if (chunk.speaker !== undefined) this.captionSpeaker = chunk.speaker;
    this.captionBuffer += (this.captionBuffer ? " " : "") + chunk.text;
    this.scheduleCaptionFlush();

    // detectInterval 문장마다 블록 감지. 감지 중이면 maybeDetect가 반환하고,
    // flush()가 마지막 미처리 문장을 다시 감지한다.
    if (this.automaticDetection && this.sentences.length - this.lastDetectCount >= this.detectInterval) {
      this.maybeDetect();
    }
  }

  private scheduleCaptionFlush(): void {
    if (this.captionFlushTimer) clearTimeout(this.captionFlushTimer);
    this.captionFlushTimer = setTimeout(() => {
      this.flushCaption();
    }, 200);
  }

  private flushCaption(): void {
    if (this.captionFlushTimer !== null) {
      clearTimeout(this.captionFlushTimer);
      this.captionFlushTimer = null;
    }
    if (this.captionBuffer) {
      this.broadcast({ type: "caption", text: this.captionBuffer, ts: Date.now(), speaker: this.captionSpeaker });
      this.captionBuffer = "";
    }
  }

  private async maybeDetect(): Promise<void> {
    if (this.detecting) return;
    const context = this.sentences.slice(-this.contextWindow);
    this.lastDetectCount = this.sentences.length;
    this.detecting = true;
    this.broadcast({ type: "detect", detecting: true });
    const epoch = this.epoch;
    try {
      const detected = await this.llm.detectBlock(context);
      const result = detected.title || detected.bullets.length > 0
        ? detected
        : deriveFallbackMeetingCard(context) ?? detected;
      // await 도중 reset()이 돌았으면 stale 결과 적용 금지.
      if (epoch !== this.epoch) return;
      this.applyDetection(result);
    } catch (e) {
      if (epoch !== this.epoch) return;
      const message = e instanceof Error ? e.message : String(e);
      this.broadcast({ type: "status", text: `LLM 오류: ${message}` });
    } finally {
      this.detecting = false;
      this.broadcast({ type: "detect", detecting: false });
    }
  }

  private applyDetection(result: BlockDetectionResult): void {
    // 빈 내부 no-op 결과(문장 없음)는 슬라이드를 만들지 않는다.
    const isEmpty = result.bullets.length === 0 && !result.title;
    if (isEmpty) {
      this.advanceStreak = 0;
      this.pendingAdvanceTitle = null;
      return;
    }
    // LLM의 메타·공허 카드는 스테이지에 올리지 않는다.
    if (result.title && isLowQualityMeetingCard({
      title: result.title,
      bullets: result.bullets,
      ...(result.kicker === undefined ? {} : { kicker: result.kicker }),
      ...(result.emphasis === undefined ? {} : { emphasis: result.emphasis }),
    })) {
      this.advanceStreak = 0;
      this.pendingAdvanceTitle = null;
      return;
    }

    // Hysteresis: pending candidate는 현재 카드와 분리한다. 같은 제목의 후보가
    // 연속 N회 확인될 때만 archive/advance하며, B 다음 C는 새 streak로 시작한다.
    let shouldAdvance = result.shouldAdvance;
    if (shouldAdvance && this.currentSlide !== null) {
      if (this.pendingAdvanceTitle === result.title) {
        this.advanceStreak++;
      } else {
        this.pendingAdvanceTitle = result.title;
        this.advanceStreak = 1;
      }
      if (this.advanceStreak < MeetingSession.ADVANCE_THRESHOLD) {
        return;
      }
    }
    if (!result.shouldAdvance) {
      this.advanceStreak = 0;
      this.pendingAdvanceTitle = null;
    }

    let changed = false;
    if (shouldAdvance || this.currentSlide === null) {
      if (this.currentSlide !== null) {
        this.history.push(this.currentSlide);
        if (this.history.length > 50) this.history.shift();
      }
      this.slideIndex++;
      this.currentSlide = {
        index: this.slideIndex,
        title: result.title || `(블록 ${this.slideIndex})`,
        ...(result.kind === undefined ? {} : { kind: result.kind }),
        ...(result.kicker === undefined ? {} : { kicker: result.kicker }),
        bullets: result.bullets,
        ...(result.emphasis === undefined ? {} : { emphasis: result.emphasis }),
        startedAt: Date.now(),
        sentenceCount: this.sentences.length,
        scene: sceneForCard({
          title: result.title || `(블록 ${this.slideIndex})`,
          bullets: result.bullets,
          ...(result.kind === undefined ? {} : { kind: result.kind }),
          ...(result.kicker === undefined ? {} : { kicker: result.kicker }),
          ...(result.emphasis === undefined ? {} : { emphasis: result.emphasis }),
        }, this.slideIndex),
      };
      try {
        this.sink?.onSlide(this.currentSlide);
      } catch (e) {
        console.error("[store] 슬라이드 저장 실패:", e);
      }
      this.advanceStreak = 0;
      this.pendingAdvanceTitle = null;
      changed = true;
    } else if (this.currentSlide) {
      // 같은 블록의 완전한 MeetingCard를 반영한다. 선택 필드가 생략되면 이전의
      // stale kicker/emphasis도 제거되어 모델의 최신 카드와 일치한다.
      const current = this.currentSlide;
      const nextBullets = result.bullets.length > 0 ? result.bullets : current.bullets;
      const bulletsChanged = nextBullets.length !== current.bullets.length
        || nextBullets.some((b, i) => b !== current.bullets[i]);
      const cardChanged = result.title !== current.title
        || result.kicker !== current.kicker
        || result.emphasis !== current.emphasis
        || result.kind !== current.kind
        || bulletsChanged;
      if (cardChanged) {
        current.title = result.title || current.title;
        current.bullets = nextBullets;
        if (result.kicker === undefined) delete current.kicker;
        else current.kicker = result.kicker;
        if (result.emphasis === undefined) delete current.emphasis;
        else current.emphasis = result.emphasis;
        if (result.kind === undefined) delete current.kind;
        else current.kind = result.kind;
        current.sentenceCount = this.sentences.length;
        current.scene = sceneForCard(current, current.index);
        try {
          this.sink?.onSlide(current);
        } catch (e) {
          console.error("[store] 슬라이드 갱신 저장 실패:", e);
        }
        changed = true;
      }
    }
    if (changed) {
      this.broadcast({ type: "slide", current: this.currentSlide, history: [...this.history] });
    }
  }

  reset(): void {
    // 진행 중 감지를 무효화: await에서 돌아와도 epoch 불일치로 결과 폐기.
    this.epoch++;
    if (this.captionFlushTimer !== null) {
      clearTimeout(this.captionFlushTimer);
      this.captionFlushTimer = null;
    }
    this.sentences = [];
    this.transcriptLog = [];
    this.transcriptTruncated = false;
    this.currentSlide = null;
    this.history = [];
    this.slideIndex = 0;
    this.lastDetectCount = 0;
    this.captionBuffer = "";
    this.captionSpeaker = undefined;
    this.advanceStreak = 0;
    this.pendingAdvanceTitle = null;
    this.broadcast({ type: "slide", current: null, history: [] });
    this.broadcast({ type: "status", text: "새 회의를 준비했습니다" });
  }
}
