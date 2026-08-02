import { describe, expect, test } from "bun:test";

import {
  MAX_BULLETS,
  MAX_TITLE_LENGTH,
  assertDeckOutline,
  assertSlideSpec,
  legacySlideToMeetingCard,
  parseDeckOutline,
  parseSlideSpec,
  type DeckOutline,
} from "../src/slide-spec.ts";

const validOutline: DeckOutline = {
  meetingId: 42,
  title: "제품 출시 회의",
  style: "clear-editorial",
  source: {
    transcriptLineCount: 28,
    liveSlideCount: 3,
    generatedAt: "2026-08-02T10:00:00.000Z",
  },
  slides: [
    { kind: "cover", title: "제품 출시 회의", subtitle: "출시 준비 최종 점검", kicker: "WEEKLY REVIEW" },
    { kind: "section", title: "출시 준비", kicker: "01", bullets: ["QA 상태", "배포 일정"] },
    { kind: "summary", title: "핵심 요약", bullets: ["금요일 베타 배포", "문서 검수 완료"], emphasis: "일정 유지" },
    { kind: "decision", title: "확정 사항", decision: "금요일에 베타를 배포한다", rationale: ["차단 이슈 없음"] },
    {
      kind: "actions",
      title: "액션 아이템",
      actions: [
        { text: "릴리스 노트 게시", owner: "민지", due: "금요일" },
        { text: "고객 공지 검수" },
      ],
    },
    { kind: "closing", title: "감사합니다", bullets: [], emphasis: "다음 회의: 월요일" },
  ],
};

describe("SlideSpec", () => {
  test("all six slide kinds parse in one valid outline", () => {
    const parsed = parseDeckOutline(JSON.stringify(validOutline));
    expect(parsed).toEqual(validOutline);
    expect(parsed.slides.map((slide) => slide.kind)).toEqual([
      "cover", "section", "summary", "decision", "actions", "closing",
    ]);
    assertDeckOutline(parsed);
    for (const slide of parsed.slides) assertSlideSpec(slide);
  });

  test("rejects an unknown kind", () => {
    expect(() => parseSlideSpec({ kind: "chart", title: "지표" })).toThrow(/kind/);
  });

  test("rejects a missing title", () => {
    expect(() => parseSlideSpec({ kind: "summary", bullets: ["요점"] })).toThrow(/title/);
  });

  test("rejects too many bullets instead of truncating", () => {
    expect(() => parseSlideSpec({
      kind: "summary",
      title: "요약",
      bullets: Array.from({ length: MAX_BULLETS + 1 }, (_, index) => `요점 ${index}`),
    })).toThrow(/bullets/);
  });

  test("rejects over-limit strings and malformed JSON", () => {
    expect(() => parseSlideSpec({ kind: "cover", title: "가".repeat(MAX_TITLE_LENGTH + 1) })).toThrow(/title/);
    expect(() => parseDeckOutline("{not-json")).toThrow(/JSON/);
  });

  test("enforces kind-specific required and empty-array rules", () => {
    expect(() => parseSlideSpec({ kind: "summary", title: "요약", bullets: [] })).toThrow(/bullets/);
    expect(() => parseSlideSpec({ kind: "actions", title: "할 일", actions: [] })).toThrow(/actions/);
    expect(parseSlideSpec({ kind: "closing", title: "끝", bullets: [] })).toEqual({
      kind: "closing", title: "끝", bullets: [],
    });
  });

  test("does not coerce field types", () => {
    expect(() => parseDeckOutline({ ...validOutline, meetingId: "42" })).toThrow(/meetingId/);
    expect(() => parseDeckOutline({
      ...validOutline,
      source: { ...validOutline.source, transcriptLineCount: "28" },
    })).toThrow(/transcriptLineCount/);
  });

  test("maps a legacy slide to a detached live meeting card", () => {
    const bullets = ["첫 번째 요점"];
    const card = legacySlideToMeetingCard({
      index: 2,
      title: "출시 일정",
      bullets,
      startedAt: 1234,
      sentenceCount: 8,
    });
    bullets.push("나중 변경");
    expect(card).toEqual({ title: "출시 일정", bullets: ["첫 번째 요점"] });
  });
});
