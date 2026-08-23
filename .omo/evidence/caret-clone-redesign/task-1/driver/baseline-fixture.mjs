// Deterministic Meeting Slides baseline fixture data.
// Fixed clock, fixed content, exact server message shapes from src/session.ts.
export const FIXED_NOW = 1_754_899_200_000; // 2025-08-11T08:00:00.000Z
export const CAPTURE_STARTED_AT = FIXED_NOW - 754_000; // 12:34 elapsed at FIXED_NOW

export const MEETINGS = [
  { id: 501, title: "제품 로드맵 검토", started_at: FIXED_NOW - 86_400_000, status: "ended" },
  { id: 502, title: "고객 온보딩 회고", started_at: FIXED_NOW - 172_800_000, status: "ended" },
  { id: 503, title: "주간 엔지니어링 싱크", started_at: CAPTURE_STARTED_AT, status: "open" },
];

export const SLIDE = {
  index: 3,
  startedAt: CAPTURE_STARTED_AT,
  sentenceCount: 12,
  kind: "decision",
  kicker: "블록 03",
  title: "8월 릴리스 범위를 확정했습니다",
  bullets: [
    "라이브 전사와 슬라이드 동기화를 우선 순위로 둔다",
    "내보내기 파이프라인은 다음 스프린트로 미룬다",
    "온보딩 회귀 테스트는 금요일까지 마친다",
  ],
  emphasis: "8월 22일 릴리스 확정",
};

export const SLIDE_HISTORY = [
  {
    index: 1,
    startedAt: CAPTURE_STARTED_AT,
    sentenceCount: 6,
    kind: "cover",
    title: "주간 엔지니어링 싱크",
    bullets: [],
    emphasis: "2025년 8월 11일",
  },
  {
    index: 2,
    startedAt: CAPTURE_STARTED_AT + 180_000,
    sentenceCount: 9,
    kind: "section",
    kicker: "블록 02",
    title: "지난주 배포 리뷰",
    bullets: ["장애 없이 두 번 배포", "회귀 두 건은 이미 수정"],
  },
  SLIDE,
];

/** 15 finalized Korean lines - matches the plan's transcript fixture requirement. */
export const TRANSCRIPT_LINES = [
  "지난주 배포는 두 번 있었고 장애 없이 끝났습니다.",
  "회귀 두 건은 어제 패치로 정리했습니다.",
  "이번 주는 8월 릴리스 범위를 확정해야 합니다.",
  "라이브 전사와 슬라이드 동기화가 가장 큰 리스크입니다.",
  "전사 지연이 500밀리초를 넘으면 사용자가 바로 알아챕니다.",
  "그래서 동기화를 최우선 과제로 두는 게 맞다고 봅니다.",
  "내보내기 파이프라인은 지금 손대면 범위가 커집니다.",
  "다음 스프린트로 미루는 데 이견 없으신가요?",
  "없습니다. 대신 온보딩 회귀는 이번 주에 끝내야 합니다.",
  "금요일까지 회귀 테스트를 마치는 것으로 잡겠습니다.",
  "릴리스 날짜는 8월 22일로 확정하겠습니다.",
  "QA 리소스는 수요일부터 이틀 확보해 두었습니다.",
  "문서 업데이트는 릴리스 직전에 한 번에 처리합니다.",
  "그럼 오늘 결정 사항을 정리해서 공유드리겠습니다.",
  "다음 싱크는 다음 주 월요일 같은 시간입니다.",
];

export function transcriptEntries() {
  return TRANSCRIPT_LINES.map((text, i) => ({
    text,
    ts: CAPTURE_STARTED_AT + (i + 1) * 40_000,
    speaker: (i % 3) + 1,
  }));
}

export const PROVISIONAL_CAPTION = "다음 싱크 일정은 캘린더에 바로 걸어두겠습니다";
