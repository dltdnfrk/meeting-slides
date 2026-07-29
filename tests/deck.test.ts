import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildDeckHtml, buildSlideFiles, linesForSlide } from "../src/deck.ts";

const slides = [
  { idx: 1, title: "출시 일정", bullets: ["베타 금요일", "QA 수요일"], startedAt: 1000 },
  { idx: 2, title: "고객 피드백", bullets: ["이탈률 높음"], startedAt: 5000 },
];
const lines = [
  { seq: 1, ts: 1200, speaker: 1, text: "베타는 금요일로" },
  { seq: 2, ts: 5200, speaker: 2, text: "이탈률이 문제예요" },
  { seq: 3, ts: 5400, speaker: null, text: "동의합니다" },
];
const standaloneThemeCss = readFileSync(join(import.meta.dir, "..", "deck", "theme.css"), "utf-8");

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

  test("Given meeting imagery assets, When reveal deck is built, Then semantic cover and topic content reference only local decorative images", () => {
    // Given
    const sections = html.match(/<section[\s\S]*?<\/section>/g) ?? [];

    // When
    const cover = sections[0] ?? "";
    const topics = sections.slice(1, -1);

    // Then
    expect(cover).toContain('src="./assets/meeting-cover.png"');
    expect(cover).toContain('alt=""');
    expect(topics).toHaveLength(2);
    expect(topics.every((topic) => topic.includes('src="./assets/meeting-topic-map.png"'))).toBe(true);
    expect(sections.at(-1)).not.toContain("meeting-cover.png");
    expect(sections.at(-1)).not.toContain("meeting-topic-map.png");
    expect(html).not.toMatch(/<img[^>]+src=["']https?:\/\//);
    expect(html).not.toMatch(/<img[^>]+src=["'][^"']*(?:\/Users\/|file:)/);
  });
});

describe("buildSlideFiles (slides-grab 계약)", () => {
  const files = buildSlideFiles({ title: "Meeting Notes", startedAt: 1000, provider: "cli:codex", slides, lines });

  test("타이틀+블록+마무리 개별 파일 생성", () => {
    expect(files.map((f) => f.filename)).toEqual(["slide-00.html", "slide-01.html", "slide-02.html", "slide-03.html"]);
    expect(files[0].html).toContain("MEETING SLIDES");
    expect(files[1].html).toContain("01");
    expect(files[1].html).toContain("출시 일정");
    expect(files[1].html).toContain("베타 금요일");
    expect(files[3].html).toContain("회의 정리");
  });

  test("16:9 고정 프레임과 로컬 테마 링크", () => {
    expect(files[1].html).toContain('href="./theme.css"');
    expect(standaloneThemeCss).toContain("width: 1280px");
    expect(standaloneThemeCss).toContain("height: 720px");
  });

  test("Given standalone slide files, When normal and empty decks are built, Then every page delegates styling and geometry to the shared theme", () => {
    // Given
    const emptyFiles = buildSlideFiles({ title: "T", startedAt: 0, slides: [], lines: [] });
    const allFiles = [...files, ...emptyFiles];

    // When
    const standalonePages = allFiles.map((file) => file.html);

    // Then
    expect(emptyFiles).toHaveLength(2);
    expect(standalonePages).toHaveLength(6);
    for (const page of standalonePages) {
      expect(page).toContain('<meta charset="utf-8" />');
      expect((page.match(/<link rel="stylesheet" href="\.\/theme\.css" \/>/g) ?? [])).toHaveLength(1);
      expect(page).not.toMatch(/<style\b/);
      expect(page).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    }
    expect(standaloneThemeCss).toContain("width: 1280px");
    expect(standaloneThemeCss).toContain("height: 720px");
  });

  test("Given slides-grab's 960x540 presentation viewport, When standalone slide files are built, Then the shared frame adapter preserves the 1280x720 design surface", () => {
    // Given
    const standalonePages = files.map((file) => file.html);

    // When
    const rootDocuments = standalonePages.filter((page) => page.includes('<html lang="ko" class="standalone-slide">'));

    // Then
    expect(rootDocuments).toHaveLength(standalonePages.length);
    expect(standaloneThemeCss).toContain("html.standalone-slide, html.standalone-slide body");
    expect(standaloneThemeCss).toContain("width: 960px; height: 540px");
    expect(standaloneThemeCss).toContain("width: 1280px; height: 720px");
    expect(standaloneThemeCss).toContain("transform: scale(0.75)");
    expect(standaloneThemeCss).toContain("transform-origin: top left");
  });

  test("Given topic slide pages, When standalone files are built, Then cover and topics use their matching local decorative assets while closing remains typography-only", () => {
    // Given
    const [cover, firstTopic, secondTopic, closing] = files;

    // When
    const topicPages = [firstTopic?.html ?? "", secondTopic?.html ?? ""];

    // Then
    expect(cover?.html).toContain('src="./assets/meeting-cover.png"');
    expect(topicPages.every((page) => page.includes('src="./assets/meeting-topic-map.png"'))).toBe(true);
    expect(closing?.html).not.toContain("meeting-topic-map.png");
    expect(closing?.html).not.toContain("meeting-cover.png");
  });

  test("Given six product-limit Korean bullets, When a dense topic is built, Then both outputs use the compact presentation contract without losing text", () => {
    // Given
    const denseBullet = "핵심 실행 항목을 담당 부서와 함께 확인하고 다음 회의까지 책임자와 완료 기준을 명확하게 정리합니다 ".repeat(3).slice(0, 80);
    const denseTopic = { idx: 1, title: "장문 한국어 안건", bullets: Array.from({ length: 6 }, () => denseBullet), startedAt: 1000 };
    const input = { title: "Meeting Notes", startedAt: 1000, slides: [denseTopic], lines: [] };

    // When
    const revealHtml = buildDeckHtml(input);
    const standaloneHtml = buildSlideFiles(input)[1]?.html ?? "";

    // Then
    expect(revealHtml).toContain('class="topic-slide is-dense"');
    expect(standaloneHtml).toContain('class="slide-page is-topic is-dense"');
    expect(revealHtml).toContain(denseBullet);
    expect(standaloneHtml).toContain(denseBullet);
  });

  test("Given a long Korean cover title, When deck outputs are built, Then both cover surfaces use the readable long-title contract without deleting text", () => {
    // Given
    const title = "분기별 제품 출시 준비와 고객 안내 정책 검토 회의";
    const input = { title, startedAt: 1000, slides: [], lines: [] };

    // When
    const revealHtml = buildDeckHtml(input);
    const standaloneHtml = buildSlideFiles(input)[0]?.html ?? "";

    // Then
    expect(revealHtml).toContain('class="title-slide is-long-cover"');
    expect(standaloneHtml).toContain('class="slide-page is-cover is-long-cover"');
    expect(revealHtml).toContain(title);
    expect(standaloneHtml).toContain(title);
  });
});
