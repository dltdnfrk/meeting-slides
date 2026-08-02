// ============================================================
// deck.ts - 회의 데이터 → reveal.js 강의 덱 HTML 생성
// ============================================================
// lecture-deck(NewTurn2017, MIT)의 템플릿 구조 차용: 타이틀 슬라이드 → 슬라이드
// 블록 섹션(<aside class="notes">에 해당 블록의 전사 라인) → 마무리 슬라이드.
// reveal.js는 CDN, 테마는 deck/theme.css (exports 폴더로 함께 복사).

import type {
  ActionsSlideSpec,
  ClosingSlideSpec,
  CoverSlideSpec,
  DecisionSlideSpec,
  SectionSlideSpec,
  SlideSpec,
  SummarySlideSpec,
} from "./slide-spec.js";
import type { StoredLine, StoredSlide } from "./store.js";

export interface DeckInput {
  title: string;
  startedAt: number;
  provider?: string | null;
  slides: StoredSlide[];
  lines: StoredLine[];
}

const DENSE_TOPIC_MIN_BULLETS = 5;
const DENSE_TOPIC_MIN_CHARACTERS = 180;
const LONG_COVER_TITLE_MIN_CHARACTERS = 24;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] ?? c));
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("ko-KR", { hour12: false });
}

/** Product-capped topics need a compact layout before their content can overflow a slide. */
function isDenseTopic(slide: Pick<StoredSlide, "bullets">): boolean {
  const characterCount = slide.bullets.reduce((total, bullet) => total + [...bullet].length, 0);
  return slide.bullets.length >= DENSE_TOPIC_MIN_BULLETS || characterCount >= DENSE_TOPIC_MIN_CHARACTERS;
}

function isLongCoverTitle(title: string): boolean {
  return [...title].length >= LONG_COVER_TITLE_MIN_CHARACTERS;
}

/** 블록 시작 시각 구간으로 전사 라인을 각 슬라이드에 배정한다. */
export function linesForSlide(slides: StoredSlide[], lines: StoredLine[], index: number): StoredLine[] {
  const start = slides[index]?.startedAt ?? 0;
  const end = index + 1 < slides.length ? slides[index + 1].startedAt : Number.POSITIVE_INFINITY;
  return lines.filter((l) => l.ts >= start && l.ts < end);
}

export function buildDeckHtml(input: DeckInput): string {
  const date = new Date(input.startedAt).toLocaleString("ko-KR", { hour12: false });
  const coverClass = isLongCoverTitle(input.title) ? "title-slide is-long-cover" : "title-slide";
  const sections = input.slides.map((slide, i) => {
    const notes = linesForSlide(input.slides, input.lines, i)
      .map((l) => `[${fmtTime(l.ts)}] ${l.speaker ? `화자 ${l.speaker}: ` : ""}${l.text}`)
      .join("\n");
    const bullets = slide.bullets.map((b) => `            <li>${esc(b)}</li>`).join("\n");
    const topicClass = isDenseTopic(slide) ? "topic-slide is-dense" : "topic-slide";
    return `        <section class="${topicClass}">
          <div class="topic-copy">
            <h2>${String(slide.idx).padStart(2, "0")}. ${esc(slide.title)}</h2>
            <ul class="bullets big">
${bullets}
            </ul>
          </div>
          <img class="topic-map" src="./assets/meeting-topic-map.png" alt="" aria-hidden="true" />
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

        <section class="${coverClass}">
          <img class="cover-visual" src="./assets/meeting-cover.png" alt="" aria-hidden="true" />
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

// ============================================================
// slides-grab 계약: 슬라이드별 standalone HTML (slide-XX.html)
// ============================================================
// slides-grab CLI(pdf/png/convert)는 슬라이드 파일 개별 렌더 방식이라,
// reveal 덱과 별도로 16:9 고정 프레임의 개별 파일을 떨어뜨린다.

export interface SlideFile {
  filename: string;
  html: string;
}

type SlidePageKind = SlideSpec["kind"] | "topic";
type RegisteredSlideSpec = SlideSpec;

function slidePageHtml(inner: string, kind: SlidePageKind, dense = false, longCover = false): string {
  return `<!doctype html>
<html lang="ko" class="standalone-slide">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="./theme.css" />
</head>
<body>
<div class="slide-page is-${kind}${dense ? " is-dense" : ""}${longCover ? " is-long-cover" : ""}">
${inner}
</div>
</body>
</html>
`;
}

function renderCoverTemplate(spec: CoverSlideSpec): string {
  return slidePageHtml(`
  <img class="cover-visual" src="./assets/meeting-cover.png" alt="" aria-hidden="true" />
  <p class="eyebrow">${esc(spec.kicker ?? "MEETING SLIDES")}</p>
  <h1>${esc(spec.title)}</h1>
  <p class="meta">${esc(spec.subtitle ?? "")}</p>`, "cover", false, isLongCoverTitle(spec.title));
}

function renderSectionTemplate(spec: SectionSlideSpec): string {
  const bullets = spec.bullets.map((bullet) => `    <li>${esc(bullet)}</li>`).join("\n");
  return slidePageHtml(`
  <div class="topic-layout">
    <div class="topic-copy">
      <h2><span class="idx">${esc(spec.kicker ?? "")}</span>${esc(spec.title)}</h2>
      <ul>
${bullets}
      </ul>
    </div>
    <img class="topic-map" src="./assets/meeting-topic-map.png" alt="" aria-hidden="true" />
  </div>`, "topic", isDenseTopic(spec));
}

function renderSummaryTemplate(spec: SummarySlideSpec): string {
  const bullets = spec.bullets.map((bullet) => `    <li>${esc(bullet)}</li>`).join("\n");
  return slidePageHtml(`
  <p class="eyebrow">SUMMARY</p>
  <h2>${esc(spec.title)}</h2>
  <ul>
${bullets}
  </ul>
  ${spec.emphasis ? `<p class="emphasis">${esc(spec.emphasis)}</p>` : ""}`, "summary", isDenseTopic(spec));
}

function renderDecisionTemplate(spec: DecisionSlideSpec): string {
  const rationale = spec.rationale?.map((item) => `    <li>${esc(item)}</li>`).join("\n") ?? "";
  return slidePageHtml(`
  <p class="eyebrow">DECISION</p>
  <h2>${esc(spec.title)}</h2>
  <p class="decision-statement">${esc(spec.decision)}</p>
  ${rationale ? `<ul class="rationale">\n${rationale}\n  </ul>` : ""}`, "decision", (spec.rationale?.length ?? 0) >= DENSE_TOPIC_MIN_BULLETS);
}

function renderActionsTemplate(spec: ActionsSlideSpec): string {
  const actions = spec.actions.map((action, index) => `    <li>
      <span class="action-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="action-text">${esc(action.text)}</span>
      ${action.owner ? `<span class="action-meta">${esc(action.owner)}${action.due ? ` · ${esc(action.due)}` : ""}</span>` : action.due ? `<span class="action-meta">${esc(action.due)}</span>` : ""}
    </li>`).join("\n");
  return slidePageHtml(`
  <p class="eyebrow">NEXT ACTIONS</p>
  <h2>${esc(spec.title)}</h2>
  <ol class="action-list">
${actions}
  </ol>`, "actions", spec.actions.length >= DENSE_TOPIC_MIN_BULLETS);
}

function renderClosingTemplate(spec: ClosingSlideSpec): string {
  const bullets = spec.bullets.map((bullet) => `    <li>${esc(bullet)}</li>`).join("\n");
  return slidePageHtml(`
  <p class="eyebrow">CLOSING</p>
  <h2>${esc(spec.title)}</h2>
  ${bullets ? `<ul>\n${bullets}\n  </ul>` : ""}
  ${spec.emphasis ? `<p class="emphasis">${esc(spec.emphasis)}</p>` : ""}`, "closing");
}

const slideTemplateRegistry = {
  cover: renderCoverTemplate,
  section: renderSectionTemplate,
  summary: renderSummaryTemplate,
  decision: renderDecisionTemplate,
  actions: renderActionsTemplate,
  closing: renderClosingTemplate,
} satisfies { [Kind in RegisteredSlideSpec["kind"]]: (spec: Extract<RegisteredSlideSpec, { kind: Kind }>) => string };

export class UnsupportedSlideTemplateError extends TypeError {
  constructor(readonly kind: string) {
    super(`No standalone slide template registered for kind: ${kind}`);
    this.name = "UnsupportedSlideTemplateError";
  }
}

/** Render one validated SlideSpec through the standalone template registry. */
export function renderSlideSpec(spec: SlideSpec, index: number): SlideFile {
  const template = slideTemplateRegistry[spec.kind as keyof typeof slideTemplateRegistry];
  if (!template) throw new UnsupportedSlideTemplateError(spec.kind);
  return {
    filename: `slide-${String(index).padStart(2, "0")}.html`,
    html: template(spec as never),
  };
}

function legacySlideSpecs(input: DeckInput): RegisteredSlideSpec[] {
  const date = new Date(input.startedAt).toLocaleString("ko-KR", { hour12: false });
  return [
    {
      kind: "cover",
      title: input.title,
      kicker: "MEETING SLIDES",
      subtitle: `${date}${input.provider ? ` · ${input.provider}` : ""}`,
    },
    ...input.slides.map((slide): SectionSlideSpec => ({
      kind: "section",
      title: slide.title,
      kicker: String(slide.idx).padStart(2, "0"),
      bullets: slide.bullets,
    })),
    {
      kind: "closing",
      title: "회의 정리",
      bullets: [
        `슬라이드 ${input.slides.length}장, 전사 ${input.lines.length}문장을 기록했습니다`,
        "Meeting Slides로 생성 · lecture-deck(MIT) 테마",
      ],
    },
  ];
}

/** slides-grab용 개별 슬라이드 파일 목록 (타이틀 + 블록들 + 마무리). */
export function buildSlideFiles(input: DeckInput): SlideFile[] {
  return legacySlideSpecs(input).map(renderSlideSpec);
}
