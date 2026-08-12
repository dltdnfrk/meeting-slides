// Canonical deterministic browser states for the Caret operator shell.
//
// Every fixture is a frozen sequence of REAL server messages (see src/session.ts
// ServerMessage) plus the exact client state each message must produce before the
// next one is pushed. Nothing here reads the wall clock, the network, or the
// filesystem: the same fixture must render byte-identical machine JSON forever.
import type { ServerMessage } from "../../src/session.ts";

/** Frozen wall clock for every fixture: 2024-03-14T09:41:00.000+09:00. */
export const FIXED_CLOCK_EPOCH_MS = 1_710_376_860_000;

/** Capture started 125 s before the frozen clock => timer text "02:05". */
export const FIXED_CAPTURE_STARTED_AT = FIXED_CLOCK_EPOCH_MS - 125_000;

export interface CanonicalViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

/** The plan's browser matrix; all captures run at deviceScaleFactor 1. */
export const CANONICAL_VIEWPORTS = {
  reference: { width: 1440, height: 900, deviceScaleFactor: 1 },
  library: { width: 1244, height: 836, deviceScaleFactor: 1 },
  live: { width: 960, height: 760, deviceScaleFactor: 1 },
  stacked: { width: 820, height: 900, deviceScaleFactor: 1 },
  narrow: { width: 375, height: 812, deviceScaleFactor: 1 },
  compact: { width: 320, height: 667, deviceScaleFactor: 1 },
} as const satisfies Record<string, CanonicalViewport>;

export type CanonicalViewportName = keyof typeof CANONICAL_VIEWPORTS;

/**
 * Observable client states the driver can subscribe to BEFORE a trigger frame is
 * pushed. Each one maps to a pure DOM predicate evaluated inside the page; none
 * of them polls a timer or inspects prose copy.
 */
export type AwaitableClientState =
  | "connection:connected"
  | "capture:idle"
  | "capture:capturing"
  | "meetings:listed"
  | "meeting:selected"
  | "meeting:loaded"
  | "slide:rendered"
  | "slide:cleared"
  | `transcript:lines=${number}`
  | "caption:shown"
  | `compile:${"started" | "progress" | "success" | "warning" | "error" | "timeout"}`
  | "detect:on"
  | "detect:off";

/**
 * One fixture step. Exactly one real trigger: either a server message pushed over
 * the harness socket, or a user interaction (click) on a machine-identified
 * selector. Never both and never neither, so every step yields real
 * subscribe-before-trigger ordering evidence rather than a vacuous assertion.
 */
export interface CaretFixtureEvent {
  /** Real server message pushed over the harness websocket. */
  readonly message?: ServerMessage;
  /** Real user interaction dispatched in the page instead of a server frame. */
  readonly click?: string;
  /** Client action the page is expected to send back, asserted in order. */
  readonly expectClientAction?: string;
  /** Client state that must be observed after this step; subscribed first. */
  readonly awaitState: AwaitableClientState;
}

export interface CaretUiFixture {
  readonly id: string;
  readonly description: string;
  readonly viewport: CanonicalViewportName;
  readonly locale: "ko-KR";
  readonly timezone: "Asia/Seoul";
  readonly clockEpochMs: number;
  readonly events: readonly CaretFixtureEvent[];
}

// ── deterministic domain data ────────────────────────────────────────────────

const MEETINGS: ServerMessage = {
  type: "meetings",
  items: [
    { id: 101, title: "제품 로드맵 정렬", started_at: FIXED_CLOCK_EPOCH_MS - 86_400_000, status: "ended" },
    { id: 102, title: "고객 온보딩 리뷰", started_at: FIXED_CLOCK_EPOCH_MS - 172_800_000, status: "ended" },
    { id: 103, title: "분기 회고", started_at: FIXED_CLOCK_EPOCH_MS - 259_200_000, status: "ended" },
  ],
};

const EMPTY_MEETINGS: ServerMessage = { type: "meetings", items: [] };

function slide(index: number, title: string, bullets: string[], emphasis?: string) {
  return {
    index,
    startedAt: FIXED_CLOCK_EPOCH_MS - (4 - index) * 60_000,
    sentenceCount: 6 + index,
    kind: index === 1 ? ("cover" as const) : ("topic" as const),
    title,
    kicker: "제품 로드맵",
    bullets,
    ...(emphasis === undefined ? {} : { emphasis }),
  };
}

const SLIDE_1 = slide(1, "2분기 로드맵 정렬", ["범위 합의", "위험 공유"]);
const SLIDE_2 = slide(2, "온보딩 지표 점검", ["이탈률 12% 감소", "설치 시간 단축", "가이드 재작성"], "결정: 온보딩 튜토리얼을 4단계로 축소");
const SLIDE_3 = slide(3, "다음 스프린트 액션", ["담당 지정", "마감 3월 22일", "리뷰 공유"], "액션: 각 팀 리드가 금요일까지 범위 확정");

/** 15 deterministic Korean transcript entries, 3 s apart, two speakers. */
const TRANSCRIPT_ENTRIES = Array.from({ length: 15 }, (_, i) => ({
  text: [
    "이번 분기 로드맵을 먼저 정렬하고 시작하겠습니다.",
    "온보딩 이탈률이 지난달보다 12퍼센트 줄었습니다.",
    "설치 시간은 평균 4분에서 2분 30초로 짧아졌습니다.",
    "튜토리얼 단계가 여전히 많다는 피드백이 반복됩니다.",
    "그래서 네 단계로 줄이는 방안을 제안합니다.",
    "지원팀 문의 중 절반이 3단계에서 발생했습니다.",
    "그 구간의 문구를 다시 쓰는 것이 우선입니다.",
    "디자인 리소스는 이번 주에 확보할 수 있습니다.",
    "그러면 다음 스프린트에 바로 반영 가능합니다.",
    "지표는 주간 대시보드로 계속 확인하겠습니다.",
    "고객사 두 곳에서 베타 참여 의사를 밝혔습니다.",
    "베타 범위는 온보딩 흐름으로만 한정합니다.",
    "각 팀 리드가 금요일까지 범위를 확정합니다.",
    "리뷰 결과는 회의록으로 공유하겠습니다.",
    "추가 논의는 다음 정기 회의에서 이어가겠습니다.",
  ][i]!,
  ts: FIXED_CLOCK_EPOCH_MS - (15 - i) * 3_000,
  speaker: (i % 2) + 1,
}));

const CAPTURE_IDLE: ServerMessage = { type: "capture", capturing: false, mode: "mic", phase: "idle" };
const CAPTURE_STARTING: ServerMessage = { type: "capture", capturing: false, mode: "mic", phase: "starting" };
const CAPTURE_LIVE: ServerMessage = {
  type: "capture",
  capturing: true,
  mode: "mic",
  phase: "capturing",
  startedAt: FIXED_CAPTURE_STARTED_AT,
};
const CAPTURE_STOPPING: ServerMessage = {
  type: "capture",
  capturing: true,
  mode: "mic",
  phase: "stopping",
  startedAt: FIXED_CAPTURE_STARTED_AT,
};

const LIVE_SLIDES: ServerMessage = {
  type: "slide",
  current: SLIDE_3,
  history: [SLIDE_1, SLIDE_2, SLIDE_3],
};

/** Same deterministic detail payload, awaited on its transcript projection. */
const MEETING_DETAIL_TRANSCRIPT_AWAIT = "transcript:lines=15" as const;

const MEETING_DETAIL: ServerMessage = {
  type: "meeting",
  meetingId: 101,
  title: "제품 로드맵 정렬",
  transcript: TRANSCRIPT_ENTRIES,
  current: SLIDE_2,
  history: [SLIDE_1, SLIDE_2],
  compiled: {
    title: "제품 로드맵 정렬",
    slideCount: 8,
    compiledAt: FIXED_CLOCK_EPOCH_MS - 3_600_000,
    publishedAt: null,
  },
};

const COMPILE_JOB_ID = "compile-fixture-0001" as const;

/** Server messages that make the client show meetings without live capture noise. */
const LIBRARY_PRELUDE: readonly CaretFixtureEvent[] = [
  { message: CAPTURE_IDLE, awaitState: "capture:idle" },
  { message: MEETINGS, awaitState: "meetings:listed" },
];

/**
 * Selecting meeting 101 the way a user does: click the session row (the client
 * sends selectMeeting), then the server answers with the deterministic detail.
 */
const SELECT_MEETING_101: readonly CaretFixtureEvent[] = [
  {
    click: '#session-list .session-row[data-meeting-id="101"]',
    expectClientAction: "selectMeeting",
    awaitState: "meeting:selected",
  },
  { message: MEETING_DETAIL, awaitState: "meeting:loaded" },
];

/** Live prelude: authoritative capture state first, so slides are never dropped. */
const LIVE_PRELUDE: readonly CaretFixtureEvent[] = [
  { message: CAPTURE_LIVE, awaitState: "capture:capturing" },
  { message: MEETINGS, awaitState: "meetings:listed" },
];

function fixture(
  id: string,
  description: string,
  viewport: CanonicalViewportName,
  events: readonly CaretFixtureEvent[],
): CaretUiFixture {
  return Object.freeze({
    id,
    description,
    viewport,
    locale: "ko-KR",
    timezone: "Asia/Seoul",
    clockEpochMs: FIXED_CLOCK_EPOCH_MS,
    events: Object.freeze(events.map((event) => Object.freeze({
      ...(event.message === undefined ? {} : { message: Object.freeze(event.message) }),
      ...(event.click === undefined ? {} : { click: event.click }),
      ...(event.expectClientAction === undefined ? {} : { expectClientAction: event.expectClientAction }),
      awaitState: event.awaitState,
    }))),
  }) satisfies CaretUiFixture;
}

export const CARET_UI_STATES: readonly CaretUiFixture[] = Object.freeze([
  fixture("reference-library", "1440x900 기준 비교용 라이브러리/상세", "reference", [
    ...LIBRARY_PRELUDE,
    ...SELECT_MEETING_101,
  ]),

  fixture("empty-library", "새 설치 직후의 빈 라이브러리", "library", [
    { message: CAPTURE_IDLE, awaitState: "capture:idle" },
    { message: EMPTY_MEETINGS, awaitState: "meetings:listed" },
  ]),

  fixture("library-overview", "회의 세 건 + 선택된 회의 개요", "library", [
    ...LIBRARY_PRELUDE,
    ...SELECT_MEETING_101,
  ]),

  fixture("library-notes", "개요에서 노트로 전환한 상세 문서", "library", [
    ...LIBRARY_PRELUDE,
    ...SELECT_MEETING_101,
    { message: { type: "saved", path: "/tmp/meeting-101-notes.md" }, awaitState: "meeting:loaded" },
  ]),

  fixture("library-transcript", "확정 15줄 전사가 있는 상세 문서", "library", [
    ...LIBRARY_PRELUDE,
    {
      click: '#session-list .session-row[data-meeting-id="101"]',
      expectClientAction: "selectMeeting",
      awaitState: "meeting:selected",
    },
    { message: MEETING_DETAIL, awaitState: MEETING_DETAIL_TRANSCRIPT_AWAIT },
  ]),

  fixture("live-starting", "녹음 시작 요청 직후", "live", [
    { message: CAPTURE_IDLE, awaitState: "capture:idle" },
    { message: MEETINGS, awaitState: "meetings:listed" },
    { message: CAPTURE_STARTING, awaitState: "capture:idle" },
    { message: CAPTURE_LIVE, awaitState: "capture:capturing" },
  ]),

  fixture("live-capturing", "슬라이드 3장 + 전사 + 잠정 자막의 라이브 상태", "live", [
    ...LIVE_PRELUDE,
    { message: LIVE_SLIDES, awaitState: "slide:rendered" },
    { message: { type: "transcript", entries: TRANSCRIPT_ENTRIES, reason: "snapshot" }, awaitState: "transcript:lines=15" },
    {
      message: { type: "caption", text: "추가 논의는 다음 정기 회의에서 이어가겠습니다.", ts: FIXED_CLOCK_EPOCH_MS - 1_000, speaker: 2 },
      awaitState: "caption:shown",
    },
  ]),

  fixture("live-stopping", "중지 중에도 남은 확정 줄이 도착하는 상태", "live", [
    ...LIVE_PRELUDE,
    { message: LIVE_SLIDES, awaitState: "slide:rendered" },
    { message: { type: "transcript", entries: TRANSCRIPT_ENTRIES, reason: "snapshot" }, awaitState: "transcript:lines=15" },
    { message: CAPTURE_STOPPING, awaitState: "capture:capturing" },
    {
      message: { type: "line", text: "마지막으로 회의록 공유 일정을 확정합니다.", ts: FIXED_CLOCK_EPOCH_MS - 500, speaker: 1 },
      awaitState: "transcript:lines=16",
    },
  ]),

  fixture("live-reconnecting", "전송이 끊겼다가 스냅샷으로 복구되는 상태", "live", [
    ...LIVE_PRELUDE,
    { message: LIVE_SLIDES, awaitState: "slide:rendered" },
    { message: { type: "status", text: "앱 서버 연결이 끊겼습니다. 다시 연결하는 중…" }, awaitState: "capture:capturing" },
    { message: { type: "transcript", entries: TRANSCRIPT_ENTRIES, reason: "snapshot" }, awaitState: "transcript:lines=15" },
  ]),

  fixture("history-preview", "라이브 중 과거 슬라이드를 미리 보는 상태", "live", [
    ...LIVE_PRELUDE,
    { message: LIVE_SLIDES, awaitState: "slide:rendered" },
    { message: { type: "detect", detecting: true }, awaitState: "detect:on" },
    { message: { type: "detect", detecting: false }, awaitState: "detect:off" },
  ]),

  fixture("compile-progress", "슬라이드 초안 생성 진행 중", "library", [
    ...LIBRARY_PRELUDE,
    ...SELECT_MEETING_101,
    { message: { type: "compile", status: "started", jobId: COMPILE_JOB_ID, meetingId: 101 }, awaitState: "compile:started" },
    {
      message: { type: "compile", status: "progress", jobId: COMPILE_JOB_ID, meetingId: 101, stage: "planning", completed: 3, total: 8 },
      awaitState: "compile:progress",
    },
  ]),

  fixture("compile-fallback", "플래너 실패 후 기본 형식으로 완성", "library", [
    ...LIBRARY_PRELUDE,
    ...SELECT_MEETING_101,
    { message: { type: "compile", status: "started", jobId: COMPILE_JOB_ID, meetingId: 101 }, awaitState: "compile:started" },
    {
      message: {
        type: "compile",
        status: "success",
        jobId: COMPILE_JOB_ID,
        meetingId: 101,
        path: "/tmp/meeting-101.pptx",
        outline: { title: "제품 로드맵 정렬", style: "default", slideCount: 6, usedFallback: true, plannerError: "planner unavailable" },
      },
      awaitState: "compile:warning",
    },
  ]),

  fixture("compile-error", "슬라이드 생성이 실패한 상태", "library", [
    ...LIBRARY_PRELUDE,
    ...SELECT_MEETING_101,
    { message: { type: "compile", status: "started", jobId: COMPILE_JOB_ID, meetingId: 101 }, awaitState: "compile:started" },
    {
      message: { type: "compile", status: "error", jobId: COMPILE_JOB_ID, meetingId: 101, error: "compile failed" },
      awaitState: "compile:error",
    },
  ]),

  fixture("stacked-live", "820x900 - 900px 이하에서 무대가 전사 위로 쌓이는 라이브", "stacked", [
    ...LIVE_PRELUDE,
    { message: LIVE_SLIDES, awaitState: "slide:rendered" },
    { message: { type: "transcript", entries: TRANSCRIPT_ENTRIES, reason: "snapshot" }, awaitState: "transcript:lines=15" },
  ]),

  fixture("narrow-live", "375x812 좁은 화면 라이브", "narrow", [
    ...LIVE_PRELUDE,
    { message: LIVE_SLIDES, awaitState: "slide:rendered" },
    { message: { type: "transcript", entries: TRANSCRIPT_ENTRIES, reason: "snapshot" }, awaitState: "transcript:lines=15" },
  ]),

  fixture("narrow-compact", "320x667 최소 화면 라이브", "compact", [
    ...LIVE_PRELUDE,
    { message: LIVE_SLIDES, awaitState: "slide:rendered" },
    { message: { type: "transcript", entries: TRANSCRIPT_ENTRIES, reason: "snapshot" }, awaitState: "transcript:lines=15" },
  ]),
]);

export function fixtureIds(): string[] {
  return CARET_UI_STATES.map((fixtureState) => fixtureState.id);
}

export function fixtureById(id: string): CaretUiFixture {
  const found = CARET_UI_STATES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`unknown caret fixture: ${id}`);
  return found;
}
