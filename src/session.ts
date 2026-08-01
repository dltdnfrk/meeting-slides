// ============================================================
// session.ts - 회의 세션 상태 머신
// ============================================================
// 전사 청크를 누적하고, 주기적으로 LLM에 블록 감지를 요청한다.
// 블록 전환 감지 시 WebSocket 클라이언트에 슬라이드 push.

import type { BlockDetectionResult, BlockDetector } from "./llm.js";
import type { TranscriptChunk } from "./whisper.js";

export interface Slide {
  index: number;
  title: string;
  bullets: string[];
  startedAt: number;
  sentenceCount: number;
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
  available: boolean;
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

export interface CaptureUpdate {
  type: "capture";
  capturing: boolean;
  mode: string;
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

export type ServerMessage = SlideUpdate | CaptionUpdate | StatusUpdate | TranscriptUpdate | ProvidersUpdate | CaptureUpdate | AttendeesUpdate | LineUpdate | DetectUpdate | SavedUpdate;

export type ClientListener = (msg: ServerMessage) => void;

interface TopicRule {
  title: string;
  pattern: RegExp;
}

const TOPIC_RULES: readonly TopicRule[] = [
  { title: "고객 피드백", pattern: /고객|피드백|온보딩|가입|사용자|의견/ },
  { title: "출시 일정", pattern: /출시|일정|배포|베타|QA|큐에이|월요일|화요일|마무리/ },
  { title: "액션 아이템", pattern: /담당자|작업 목록|공유|할 일|액션|마지막/ },
];

const TOPIC_SHIFT_PATTERN = /첫\s*번째|두\s*번째|세\s*번째|마지막|다음\s*안건|다음은|첫째|둘째|셋째/;
const BULLET_PREFIX_PATTERN = /^(?:첫\s*번째|두\s*번째|세\s*번째)(?:는|로|으로)?\s*|^마지막(?:으로)?\s*/;

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
  private static readonly MAX_SENTENCES = 200;
  private static readonly ADVANCE_THRESHOLD = 2;

  constructor(
    private llm: BlockDetector,
    private detectInterval: number,
    private contextWindow: number,
    private listeners: Set<ClientListener>,
    private sink: MeetingSink | null = null,
  ) {}

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
    if (this.sentences.length - this.lastDetectCount >= this.detectInterval) {
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
      const result = await this.llm.detectBlock(context);
      // await 도중 reset()이 돌았으면 stale 결과 적용 금지.
      if (epoch !== this.epoch) return;
      this.applyDetection(result);
    } catch (e) {
      if (epoch !== this.epoch) return;
      const message = e instanceof Error ? e.message : String(e);
      this.broadcast({ type: "status", text: `LLM 오류: ${message} — 로컬 요약 fallback 사용` });
      this.applyDetection(this.fallbackDetect(context));
    } finally {
      this.detecting = false;
      this.broadcast({ type: "detect", detecting: false });
    }
  }

  private fallbackDetect(context: string[]): BlockDetectionResult {
    if (context.length === 0) {
      return { shouldAdvance: false, blockTitle: "", bullets: [] };
    }

    const joined = context.join(" ");
    let title = "회의 요약";
    let startIndex = Math.max(0, context.length - 5);
    for (const rule of TOPIC_RULES) {
      const idx = context.findIndex((s) => rule.pattern.test(s));
      if (idx >= 0) {
        title = rule.title;
        startIndex = idx;
        break;
      }
    }

    const bullets = context.slice(startIndex)
      .map((s) => s
        .replace(BULLET_PREFIX_PATTERN, "")
        .replace(/^[은는]\s*/, "")
        .trim())
      .filter((s) => s.length > 0)
      .slice(0, 5);

    const shouldAdvance = this.currentSlide === null
      || (this.currentSlide.title !== title && TOPIC_SHIFT_PATTERN.test(joined));

    return { shouldAdvance, blockTitle: title, bullets };
  }

  private applyDetection(result: BlockDetectionResult): void {
    // 빈 결과 (LLM이 내용 없다고 판단) → 슬라이드 생성/업데이트 스킵
    const isEmpty = result.bullets.length === 0 && !result.blockTitle;
    if (isEmpty) {
      this.advanceStreak = 0;
      return;
    }

    // Hysteresis: 첫 슬라이드가 아닌 경우, 연속 N회 advance 시그널이 있어야
    // 실제로 새 슬라이드를 만든다. 중복 슬라이드 spam 방지.
    let shouldAdvance = result.shouldAdvance;
    if (shouldAdvance && this.currentSlide !== null) {
      this.advanceStreak++;
      if (this.advanceStreak < MeetingSession.ADVANCE_THRESHOLD) {
        shouldAdvance = false; // 아직 확정 아님 — 불렛만 갱신
      }
    }
    if (!result.shouldAdvance) {
      this.advanceStreak = 0;
    }

    let changed = false;
    if (shouldAdvance || this.currentSlide === null) {
      // 첫 슬라이드이거나 새 블록 시작 (hysteresis 통과)
      if (this.currentSlide !== null) {
        this.history.push(this.currentSlide);
        if (this.history.length > 50) this.history.shift();
      }
      this.slideIndex++;
      this.currentSlide = {
        index: this.slideIndex,
        title: result.blockTitle || `(블록 ${this.slideIndex})`,
        bullets: result.bullets,
        startedAt: Date.now(),
        sentenceCount: this.sentences.length,
      };
      try {
        this.sink?.onSlide(this.currentSlide);
      } catch (e) {
        console.error("[store] 슬라이드 저장 실패:", e);
      }
      this.advanceStreak = 0;
      changed = true;
    } else if (this.currentSlide) {
      // 같은 블록 — 실제 표시 내용이 달라진 경우만 업데이트
      // 라이브 UI뿐 아니라 SQLite/export도 최신 불렛을 보려면 sink에 반드시 반영.
      const current = this.currentSlide;
      const nextTitle = result.blockTitle || current.title;
      const nextBullets = result.bullets.length > 0 ? result.bullets : current.bullets;
      const bulletsChanged = nextBullets.length !== current.bullets.length
        || nextBullets.some((b, i) => b !== current.bullets[i]);
      if (nextTitle !== current.title || bulletsChanged) {
        current.title = nextTitle;
        current.bullets = nextBullets;
        current.sentenceCount = this.sentences.length;
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
    this.broadcast({ type: "slide", current: null, history: [] });
    this.broadcast({ type: "status", text: "세션 초기화" });
  }
}
