import type { DeckPlanner, DeckPlannerInput, DeckPlannerRepair } from "./llm.js";
import { parseDeckOutline, type DeckOutline } from "./slide-spec.js";
import type { MeetingStore, StoredLine, StoredSlide } from "./store.js";

export interface DeckCompileResult {
  outline: DeckOutline;
  plannerError: string | null;
  usedFallback: boolean;
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

function canonicalize(outline: DeckOutline, input: DeckPlannerInput): DeckOutline {
  return parseDeckOutline({
    ...outline,
    source: {
      transcriptLineCount: input.transcript.length,
      liveSlideCount: input.liveSlideAnchors.length,
    },
  });
}

/** Plan from canonical store inputs, retry once, then fail with the combined validation errors. */
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
