import type { DeckPlanner, DeckPlannerInput, DeckPlannerRepair } from "./llm.js";
import {
  MAX_BULLET_LENGTH,
  MAX_SLIDES,
  MAX_TITLE_LENGTH,
  parseDeckOutline,
  type DeckOutline,
  type SlideSpec,
} from "./slide-spec.js";
import type { MeetingStore, StoredLine, StoredSlide } from "./store.js";

export interface DeckCompileResult {
  outline: DeckOutline;
  plannerError: string | null;
  usedFallback: boolean;
}

function truncate(value: string, max: number): string {
  return [...value.trim()].slice(0, max).join("");
}

function plannerInput(meetingId: number, lines: StoredLine[], slides: StoredSlide[]): DeckPlannerInput {
  return {
    meetingId,
    transcript: lines.map((line) => ({ ...line })),
    liveSlideAnchors: slides.map((slide) => ({ ...slide, bullets: [...slide.bullets] })),
  };
}

function assertNoModelHtml(value: unknown, path = "outline"): void {
  if (typeof value === "string" && /<\/?[a-z][^>]*>/iu.test(value)) {
    throw new TypeError(`${path} must not contain HTML`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoModelHtml(item, `${path}[${index}]`));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) assertNoModelHtml(item, `${path}.${key}`);
  }
}

/** Schema validation plus the minimum narrative shape required by the compiler. */
export function validatePlannedOutline(value: unknown, meetingId: number): DeckOutline {
  const outline = parseDeckOutline(value);
  assertNoModelHtml(outline);
  if (outline.meetingId !== meetingId) throw new TypeError("outline.meetingId must match the requested meeting");
  if (outline.slides[0]?.kind !== "cover") throw new TypeError("outline must start with a cover slide");
  if (outline.slides.at(-1)?.kind !== "closing") throw new TypeError("outline must end with a closing slide");
  if (outline.slides.length < 3) throw new TypeError("outline must contain at least one content slide");
  return outline;
}

function latestAnchorAt(anchors: StoredSlide[], timestamp: number): StoredSlide | undefined {
  let latest: StoredSlide | undefined;
  for (const anchor of anchors) {
    if (anchor.startedAt <= timestamp) latest = anchor;
  }
  return latest;
}

function summarySlides(lines: StoredLine[], anchors: StoredSlide[]): SlideSpec[] {
  const content: SlideSpec[] = [];
  const spokenLines = lines.filter((line) => line.text.trim().length > 0);
  for (let offset = 0; offset < spokenLines.length && content.length < MAX_SLIDES - 2; offset += 6) {
    const chunk = spokenLines.slice(offset, offset + 6);
    const anchor = latestAnchorAt(anchors, chunk[0]!.ts);
    const fallbackTitle = `회의 요약 ${content.length + 1}`;
    content.push({
      kind: "summary",
      title: truncate(anchor?.title ?? fallbackTitle, MAX_TITLE_LENGTH) || fallbackTitle,
      bullets: chunk.map((line) => truncate(line.text, MAX_BULLET_LENGTH)),
    });
  }
  if (content.length === 0) {
    for (const anchor of anchors.slice(0, MAX_SLIDES - 2)) {
      const bullets = anchor.bullets.map((bullet) => truncate(bullet, MAX_BULLET_LENGTH)).filter(Boolean).slice(0, 6);
      if (bullets.length > 0) {
        content.push({
          kind: "summary",
          title: truncate(anchor.title, MAX_TITLE_LENGTH) || `회의 요약 ${content.length + 1}`,
          bullets,
        });
      }
    }
  }
  return content;
}

/** Deterministic, model-free outline used after both planner attempts fail. */
export function buildFallbackDeckOutline(input: DeckPlannerInput): DeckOutline {
  const content = summarySlides(input.transcript, input.liveSlideAnchors);
  return parseDeckOutline({
    meetingId: input.meetingId,
    title: "회의 요약",
    style: "clear-editorial",
    source: {
      transcriptLineCount: input.transcript.length,
      liveSlideCount: input.liveSlideAnchors.length,
    },
    slides: [
      { kind: "cover", title: "회의 요약", subtitle: "전체 전사 기반 정리" },
      ...content,
      { kind: "closing", title: "마무리", bullets: [] },
    ],
  });
}

function canonicalize(outline: DeckOutline, input: DeckPlannerInput): DeckOutline {
  return parseDeckOutline({
    ...outline,
    source: {
      transcriptLineCount: input.transcript.length,
      liveSlideCount: input.liveSlideAnchors.length,
    },
  });
}

/** Plan from canonical store inputs, retry once, then persist a deterministic fallback. */
export async function compileDeckOutline(
  store: MeetingStore,
  meetingId: number,
  planner: DeckPlanner,
): Promise<DeckCompileResult> {
  const input = plannerInput(meetingId, store.lines(meetingId), store.slides(meetingId));
  const failures: string[] = [];
  let repair: DeckPlannerRepair | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const candidate = await planner.planDeck(input, repair);
      const outline = canonicalize(validatePlannedOutline(candidate, meetingId), input);
      store.saveDeckOutline(outline);
      return { outline, plannerError: null, usedFallback: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`attempt ${attempt + 1}: ${message}`);
      repair = { validationError: message };
    }
  }

  const plannerError = failures.join("; ");
  throw new Error(`덱 플래너 실패: ${plannerError}`);
}
