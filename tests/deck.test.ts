import { describe, expect, test } from "bun:test";

import { buildDeckHtml, linesForSlide } from "../src/deck.ts";

const slides = [
  { idx: 1, title: "출시 일정", bullets: ["베타 금요일", "QA 수요일"], startedAt: 1000 },
  { idx: 2, title: "고객 피드백", bullets: ["이탈률 높음"], startedAt: 5000 },
];
const lines = [
  { seq: 1, ts: 1200, speaker: 1, text: "베타는 금요일로" },
  { seq: 2, ts: 5200, speaker: 2, text: "이탈률이 문제예요" },
  { seq: 3, ts: 5400, speaker: null, text: "동의합니다" },
];

describe("linesForSlide", () => {
  test("블록 시작 시각 구간으로 라인 배정", () => {
    expect(linesForSlide(slides, lines, 0).map((l) => l.seq)).toEqual([1]);
    expect(linesForSlide(slides, lines, 1).map((l) => l.seq)).toEqual([2, 3]);
  });
});

describe("buildDeckHtml", () => {
  const html = buildDeckHtml({
    title: "Meeting Notes",
    startedAt: 1000,
    provider: "cli:codex",
    slides,
    lines,
  });

  test("타이틀/본문/마무리 섹션 구성", () => {
    expect(html).toContain('class="title-slide"');
    expect(html).toContain("01. 출시 일정");
    expect(html).toContain("02. 고객 피드백");
    expect(html).toContain("회의 정리");
    expect(html).toContain("cli:codex");
  });

  test("불렛과 발표자 노트(전사) 포함", () => {
    expect(html).toContain("<li>베타 금요일</li>");
    expect(html).toContain("베타는 금요일로");
    expect(html).toContain("화자 2");
    expect((html.match(/<aside class="notes">/g) ?? []).length).toBe(4); // 타이틀+2블록+마무리
  });

  test("HTML 이스케이프", () => {
    const evil = buildDeckHtml({
      title: "T",
      startedAt: 0,
      slides: [{ idx: 1, title: "<script>alert(1)</script>", bullets: ["<b>"], startedAt: 0 }],
      lines: [],
    });
    expect(evil).not.toContain("<script>alert");
    expect(evil).toContain("&lt;script&gt;");
  });
});
