// ============================================================
// deck.ts - 회의 데이터 → reveal.js 강의 덱 HTML 생성
// ============================================================
// lecture-deck(NewTurn2017, MIT)의 템플릿 구조 차용: 타이틀 슬라이드 → 슬라이드
// 블록 섹션(<aside class="notes">에 해당 블록의 전사 라인) → 마무리 슬라이드.
// reveal.js는 CDN, 테마는 deck/theme.css (exports 폴더로 함께 복사).

import type { StoredLine, StoredSlide } from "./store.js";

export interface DeckInput {
  title: string;
  startedAt: number;
  provider?: string | null;
  slides: StoredSlide[];
  lines: StoredLine[];
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] ?? c));
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("ko-KR", { hour12: false });
}

/** 블록 시작 시각 구간으로 전사 라인을 각 슬라이드에 배정한다. */
export function linesForSlide(slides: StoredSlide[], lines: StoredLine[], index: number): StoredLine[] {
  const start = slides[index]?.startedAt ?? 0;
  const end = index + 1 < slides.length ? slides[index + 1].startedAt : Number.POSITIVE_INFINITY;
  return lines.filter((l) => l.ts >= start && l.ts < end);
}

export function buildDeckHtml(input: DeckInput): string {
  const date = new Date(input.startedAt).toLocaleString("ko-KR", { hour12: false });

  const sections = input.slides.map((slide, i) => {
    const notes = linesForSlide(input.slides, input.lines, i)
      .map((l) => `[${fmtTime(l.ts)}] ${l.speaker ? `화자 ${l.speaker}: ` : ""}${l.text}`)
      .join("\n");
    const bullets = slide.bullets.map((b) => `            <li>${esc(b)}</li>`).join("\n");
    return `        <section>
          <h2>${String(slide.idx).padStart(2, "0")}. ${esc(slide.title)}</h2>
          <ul class="bullets big">
${bullets}
          </ul>
          <aside class="notes">${esc(notes || "(이 블록의 전사 없음)")}</aside>
        </section>`;
  }).join("\n\n");

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>${esc(input.title)}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4.6.1/dist/reset.css" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4.6.1/dist/reveal.css" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css" />
    <link rel="stylesheet" href="theme.css" />
  </head>
  <body>
    <div class="reveal">
      <div class="slides">

        <section class="title-slide" data-background-gradient="linear-gradient(160deg, #0A0A0A 0%, #05140b 100%)">
          <div class="title-block">
            <p class="eyebrow">MEETING SLIDES</p>
            <h1>${esc(input.title)}</h1>
            <p class="subtitle">${esc(date)}${input.provider ? ` · ${esc(input.provider)}` : ""}</p>
          </div>
          <p class="footer-meta">슬라이드 ${input.slides.length}장 · 전사 ${input.lines.length}문장 · S 키 = 발표자 노트</p>
          <aside class="notes">회의 시작 ${esc(date)}</aside>
        </section>

${sections}

        <section>
          <h2>회의 정리</h2>
          <ul class="bullets big">
            <li>슬라이드 ${input.slides.length}장, 전사 ${input.lines.length}문장을 기록했습니다</li>
            <li>전체 전사는 각 슬라이드의 발표자 노트(S 키)에 들어 있습니다</li>
          </ul>
          <aside class="notes">Meeting Slides로 생성 · lecture-deck(MIT) 템플릿 차용</aside>
        </section>

      </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/reveal.js@4.6.1/dist/reveal.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/reveal.js@4.6.1/plugin/notes/notes.js"></script>
    <script>
      Reveal.initialize({ hash: true, plugins: [RevealNotes] });
    </script>
  </body>
</html>
`;
}
