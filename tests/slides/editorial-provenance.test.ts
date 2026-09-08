import { expect, test } from "bun:test";

import type { SlidePlan } from "../../src/slides/model/plan.ts";
import {
  findEditorialCopying,
  findEditorialProvenanceFailure,
} from "../../src/slides/planning/editorial-validation.ts";
import {
  planTranscriptToSlides,
  type SlidePlannerCompletionRequest,
  type TranscriptSnapshot,
} from "../../src/slides/planning/planner.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../../src/slides/theme/meeting-paper.ts";

type ModelPlanContent = Omit<SlidePlan, "planId" | "snapshot" | "createdAt" | "updatedAt" | "theme">;

function planContent(
  kind: "fact" | "quote",
  method: "extractive" | "verbatim",
  evidenceQuote: string,
  display: string,
): ModelPlanContent {
  const bind = ["claim"];
  return {
    schemaVersion: 1,
    revision: 0,
    title: "근거 계획",
    claims: [{
      id: "claim",
      kind,
      text: evidenceQuote,
      sources: [{
        transcriptVersionId: "transcript-provenance",
        startSeq: 1,
        endSeq: 1,
        evidenceQuote,
      }],
      method,
    }],
    assets: [],
    slides: [
      {
        id: "hero", layout: "hero", storyRole: "opening", title: "첫 근거를 봅니다",
        payload: { variant: "cover", statement: display },
        bindings: { title: bind, statement: bind }, editorialPaths: [], assetIds: [],
      },
      {
        id: "summary", layout: "summary", storyRole: "context", title: "근거를 요약합니다",
        payload: { mode: "overview", items: [display] },
        bindings: { title: bind, "items[0]": bind }, editorialPaths: [], assetIds: [],
      },
      {
        id: "decision", layout: "decision", storyRole: "decision", title: "근거로 판단합니다",
        payload: { decision: display, rationale: [display] },
        bindings: { title: bind, decision: bind, "rationale[0]": bind },
        editorialPaths: [], assetIds: [],
      },
      {
        id: "comparison", layout: "comparison", storyRole: "argument", title: "근거를 비교합니다",
        payload: { sides: [{ label: "A", items: [display] }, { label: "B", items: [display] }] },
        bindings: {
          title: bind, "sides[0].items[0]": bind, "sides[1].items[0]": bind,
        },
        editorialPaths: ["sides[0].label", "sides[1].label"], assetIds: [],
      },
      {
        id: "actions", layout: "actions", storyRole: "commitment", title: "근거를 실행으로 옮깁니다",
        payload: { items: [{ task: display, owner: "담당자", due: "미정" }] },
        bindings: {
          title: bind, "items[0].task": bind, "items[0].owner": bind, "items[0].due": bind,
        },
        editorialPaths: [], assetIds: [],
      },
      {
        id: "detail", layout: "hero", storyRole: "argument", title: "근거를 다시 확인합니다",
        payload: { variant: "statement", statement: display },
        bindings: { title: bind, statement: bind }, editorialPaths: [], assetIds: [],
      },
      {
        id: "closing", layout: "summary", storyRole: "closing", title: "근거로 마무리합니다",
        payload: { mode: "takeaways", items: [display] },
        bindings: { title: bind, "items[0]": bind }, editorialPaths: [], assetIds: [],
      },
    ],
  };
}

async function runPlanner(
  line: string,
  content: ModelPlanContent,
): Promise<{ readonly calls: readonly SlidePlannerCompletionRequest[]; readonly result: unknown }> {
  const calls: SlidePlannerCompletionRequest[] = [];
  const output = JSON.stringify(content);
  const complete = async (request: SlidePlannerCompletionRequest): Promise<string> => {
    calls.push(request);
    return output;
  };
  const snapshot: TranscriptSnapshot = {
    state: "finalized",
    meetingId: 11,
    transcriptVersionId: "transcript-provenance",
    contentSha256: "c".repeat(64),
    lines: [{ seq: 1, speaker: null, text: line }],
  };
  try {
    return {
      calls,
      result: await planTranscriptToSlides(snapshot, {
        complete,
        createId: () => "provenance-plan",
        now: () => "2026-08-31T00:00:00.000Z",
        theme: MEETING_PAPER_STYLE_PROFILE,
      }),
    };
  } catch (error) {
    return { calls, result: error };
  }
}

test("allows quote-heavy slides when exact copy is bound to a quote claim", async () => {
  const quote = "고객이 직접 선택한 문장입니다.";

  const run = await runPlanner(quote, planContent("quote", "verbatim", quote, quote));

  expect(run.calls).toHaveLength(1);
  expect(run.result).toMatchObject({ planId: "provenance-plan" });
});

test("rejects repeated exact evidence excerpts even when the transcript line is longer", async () => {
  const excerpt = "오류율 기준은 추가 확인이 필요합니다";

  const run = await runPlanner(
    `출시 전에 ${excerpt}라는 결론을 기록했습니다.`,
    planContent("fact", "extractive", excerpt, excerpt),
  );

  expect(run.calls).toHaveLength(2);
  expect(run.calls[1]?.validationFailure).toMatchObject({ kind: "editorial-copying" });
});

test("rejects a new numeric fact absent from every bound claim source", async () => {
  const run = await runPlanner(
    "현재 이탈률은 18퍼센트입니다.",
    planContent("fact", "extractive", "현재 이탈률은 18퍼센트입니다.", "목표 10% 미만"),
  );

  expect(run.calls).toHaveLength(2);
  expect(run.calls[1]?.validationFailure).toMatchObject({ kind: "editorial-provenance" });
});

test.each([
  ["품질 지표를 확인합니다.", "KPI 확정"],
  ["내부 문서를 확인합니다.", "https://example.invalid 확인"],
  ["내년 일정을 논의합니다.", "2027년 출시"],
  ["다음 주 출시 일정을 논의합니다.", "Friday 출시"],
  ["다음 주 출시 일정을 논의합니다.", "Fri 출시"],
  ["기능 설정을 확인합니다.", "feature_flag 확인"],
])("rejects a new technical atom absent from the bound claim: %s", async (line, display) => {
  const run = await runPlanner(
    line,
    planContent("fact", "extractive", line, display),
  );

  expect(run.calls).toHaveLength(2);
  expect(run.calls[1]?.validationFailure).toMatchObject({ kind: "editorial-provenance" });
});

test.each([
  ["owner", "KPI"],
  ["due", "2027년"],
] as const)("checks action %s as a factual display field", (field, value) => {
  const content = planContent("fact", "extractive", "업무를 준비합니다.", "업무 준비");
  const plan = {
    ...content,
    slides: content.slides.map((slide) => slide.layout !== "actions" ? slide : {
      ...slide,
      payload: {
        items: [{
          ...slide.payload.items[0]!,
          [field]: value,
        }],
      },
    }),
  };

  expect(findEditorialProvenanceFailure(plan)?.path)
    .toBe(`slides[4].payload.items[0].${field}`);
});

test.each([
  ["label", "feature_flag"],
  ["value", "2027"],
] as const)("checks metric %s as a factual display field", (field, value) => {
  const content = planContent("fact", "extractive", "품질 지표를 확인합니다.", "품질 확인");
  const metrics: SlidePlan["slides"][number] = {
    id: "metrics",
    layout: "metrics",
    storyRole: "argument",
    title: "품질 지표를 봅니다",
    payload: { mode: "cards", metrics: [{ label: "품질", value: "미정", detail: "추가 확인" }] },
    bindings: {
      title: ["claim"],
      "metrics[0].label": ["claim"],
      "metrics[0].value": ["claim"],
      "metrics[0].detail": ["claim"],
    },
    editorialPaths: [],
    assetIds: [],
  };
  const metric = metrics.payload.metrics[0]!;
  const plan = {
    claims: content.claims,
    slides: [{
      ...metrics,
      payload: { ...metrics.payload, metrics: [{ ...metric, [field]: value }] },
    }],
  };

  expect(findEditorialProvenanceFailure(plan)?.path)
    .toBe(`slides[0].payload.metrics[0].${field}`);
});

test("quote-only fields do not dilute the exact-copy denominator", () => {
  const copiedText = "오류율 기준은 추가 확인이 필요합니다";
  const quoteText = "고객이 직접 선택한 문장입니다";
  const fact = planContent("fact", "extractive", copiedText, copiedText);
  const quote = planContent("quote", "verbatim", quoteText, quoteText);
  const quoteClaim = { ...quote.claims[0]!, id: "quote" };
  const quoteSlides = quote.slides.slice(0, 4).map((slide) => ({
    ...slide,
    id: `quote-${slide.id}`,
    bindings: Object.fromEntries(
      Object.keys(slide.bindings).map((key) => [key, ["quote"]]),
    ),
  }));
  const plan = {
    claims: [fact.claims[0]!, quoteClaim],
    slides: [...fact.slides.slice(0, 3), ...quoteSlides],
  };

  expect(findEditorialCopying(plan, [copiedText, quoteText])).toMatchObject({
    copiedFields: 4,
    eligibleFields: 4,
  });
});
