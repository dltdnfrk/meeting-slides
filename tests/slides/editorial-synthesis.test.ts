import { expect, test } from "bun:test";

import {
  planTranscriptToSlides,
  type SlidePlannerCompletionRequest,
  type TranscriptSnapshot,
} from "../../src/slides/planning/planner.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../../src/slides/theme/meeting-paper.ts";
import type { SlidePlan } from "../../src/slides/model/plan.ts";

type ModelPlanContent = Omit<SlidePlan, "planId" | "snapshot" | "createdAt" | "updatedAt" | "theme">;

const snapshot: TranscriptSnapshot = {
  state: "finalized",
  meetingId: 7,
  transcriptVersionId: "transcript-editorial",
  contentSha256: "a".repeat(64),
  lines: [
    { seq: 1, speaker: "민아", text: "신규 고객의 첫 주 이탈률이 18퍼센트라서 가입 흐름을 줄여야 한다고 이야기했습니다." },
    { seq: 2, speaker: "준", text: "다음 분기에는 온보딩 단계를 세 단계로 줄이는 방향으로 결정했습니다." },
    { seq: 3, speaker: "지민", text: "지민이 금요일까지 새 온보딩 프로토타입을 공유하기로 했습니다." },
  ],
};

function copiedPlan(): ModelPlanContent {
  const [attrition, onboarding, prototype] = snapshot.lines;
  if (!attrition || !onboarding || !prototype) throw new Error("editorial fixture is incomplete");
  const source = (line: typeof attrition) => ({
    transcriptVersionId: snapshot.transcriptVersionId,
    startSeq: line.seq,
    endSeq: line.seq,
    evidenceQuote: line.text,
  });
  return {
    schemaVersion: 1,
    revision: 0,
    title: "온보딩 회의",
    claims: [
      { id: "attrition", kind: "fact", text: attrition.text, sources: [source(attrition)], method: "extractive" },
      { id: "onboarding", kind: "decision", text: onboarding.text, sources: [source(onboarding)], method: "extractive" },
      { id: "prototype", kind: "action", text: prototype.text, sources: [source(prototype)], method: "extractive" },
    ],
    assets: [],
    slides: [
      {
        id: "hero", layout: "hero", storyRole: "opening", title: attrition.text,
        payload: { variant: "cover", statement: attrition.text },
        bindings: { title: ["attrition"], statement: ["attrition"] }, editorialPaths: [], assetIds: [],
      },
      {
        id: "summary", layout: "summary", storyRole: "context", title: onboarding.text,
        payload: { mode: "overview", items: [attrition.text, onboarding.text, prototype.text] },
        bindings: {
          title: ["onboarding"], "items[0]": ["attrition"],
          "items[1]": ["onboarding"], "items[2]": ["prototype"],
        },
        editorialPaths: [], assetIds: [],
      },
      {
        id: "decision", layout: "decision", storyRole: "decision", title: onboarding.text,
        payload: { decision: onboarding.text, rationale: [attrition.text] },
        bindings: {
          title: ["onboarding"], decision: ["onboarding"], "rationale[0]": ["attrition"],
        },
        editorialPaths: [], assetIds: [],
      },
      {
        id: "comparison", layout: "comparison", storyRole: "argument", title: attrition.text,
        payload: {
          sides: [
            { label: "현재", items: [attrition.text] },
            { label: "목표", items: [onboarding.text] },
          ],
        },
        bindings: {
          title: ["attrition"], "sides[0].items[0]": ["attrition"],
          "sides[1].items[0]": ["onboarding"],
        },
        editorialPaths: ["sides[0].label", "sides[1].label"], assetIds: [],
      },
      {
        id: "timeline", layout: "timeline", storyRole: "argument", title: prototype.text,
        payload: { mode: "process", events: [{ label: "금요일", text: prototype.text }] },
        bindings: { title: ["prototype"], "events[0].text": ["prototype"] },
        editorialPaths: ["events[0].label"], assetIds: [],
      },
      {
        id: "metrics", layout: "metrics", storyRole: "argument", title: attrition.text,
        payload: { mode: "cards", metrics: [{ label: "이탈률", value: "18%", detail: attrition.text }] },
        bindings: {
          title: ["attrition"], "metrics[0].label": ["attrition"],
          "metrics[0].value": ["attrition"], "metrics[0].detail": ["attrition"],
        },
        editorialPaths: [], assetIds: [],
      },
      {
        id: "actions", layout: "actions", storyRole: "commitment", title: prototype.text,
        payload: { items: [{ task: prototype.text, owner: "지민", due: "금요일" }] },
        bindings: {
          title: ["prototype"], "items[0].task": ["prototype"],
          "items[0].owner": ["prototype"], "items[0].due": ["prototype"],
        },
        editorialPaths: [], assetIds: [],
      },
    ],
  };
}

function synthesizedPlan(): ModelPlanContent {
  const plan = copiedPlan();
  for (const slide of plan.slides) {
    switch (slide.layout) {
      case "hero":
        slide.title = "첫 주 이탈을 먼저 줄입니다";
        slide.payload.statement = "가입 흐름을 세 단계로 단순화합니다";
        break;
      case "summary":
        slide.title = "문제와 결정, 실행이 연결됐습니다";
        slide.payload.items = ["첫 주 이탈 18%", "온보딩 세 단계", "금요일 프로토타입"];
        break;
      case "decision":
        slide.title = "온보딩을 세 단계로 줄입니다";
        slide.payload.decision = "가입 여정을 단순화합니다";
        slide.payload.rationale = ["첫 주 이탈이 가장 큽니다"];
        break;
      case "comparison":
        if (!slide.payload.sides[0] || !slide.payload.sides[1]) {
          throw new Error("comparison fixture is incomplete");
        }
        slide.title = "18% 이탈을 한 자리로 낮춥니다";
        slide.payload.sides[0].items = ["현재 18%"];
        slide.payload.sides[1].items = ["온보딩 세 단계"];
        break;
      case "timeline":
        break;
      case "metrics":
        break;
      case "actions":
        break;
    }
  }
  const timeline = plan.slides.findIndex((slide) => slide.layout === "timeline");
  const metrics = plan.slides.findIndex((slide) => slide.layout === "metrics");
  const actions = plan.slides.findIndex((slide) => slide.layout === "actions");
  if (timeline < 0 || metrics < 0 || actions < 0) throw new Error("layout fixture is incomplete");
  plan.slides[timeline] = {
    id: "action-detail", layout: "actions", storyRole: "commitment",
    title: "금요일까지 프로토타입을 준비합니다",
    payload: { items: [{ task: "온보딩 프로토타입 공유", owner: "지민", due: "금요일" }] },
    bindings: {
      title: ["prototype"], "items[0].task": ["prototype"],
      "items[0].owner": ["prototype"], "items[0].due": ["prototype"],
    },
    editorialPaths: [], assetIds: [],
  };
  plan.slides[metrics] = {
    id: "risk-detail", layout: "decision", storyRole: "argument",
    title: "첫 주 이탈률이 마지막 기준입니다",
    payload: { decision: "이탈률 목표 확정", rationale: ["현재 18%에서 개선"] },
    bindings: {
      title: ["attrition"], decision: ["attrition"], "rationale[0]": ["attrition"],
    },
    editorialPaths: [], assetIds: [],
  };
  plan.slides[actions] = {
    id: "closing", layout: "summary", storyRole: "closing",
    title: "출시 준비는 세 항목으로 닫힙니다",
    payload: { mode: "takeaways", items: ["온보딩 세 단계", "금요일 프로토타입", "이탈률 목표"] },
    bindings: {
      title: ["attrition", "onboarding", "prototype"],
      "items[0]": ["onboarding"], "items[1]": ["prototype"], "items[2]": ["attrition"],
    },
    editorialPaths: [], assetIds: [],
  };
  return plan;
}

test("rejects a deck that copies source sentences instead of synthesizing presentation copy", async () => {
  // Given
  const calls: SlidePlannerCompletionRequest[] = [];
  const output = JSON.stringify(copiedPlan());
  const complete = async (request: SlidePlannerCompletionRequest): Promise<string> => {
    calls.push(request);
    return output;
  };

  // When
  let failure: unknown;
  try {
    await planTranscriptToSlides(snapshot, {
      complete,
      createId: () => "editorial-plan",
      now: () => "2026-08-31T00:00:00.000Z",
      theme: MEETING_PAPER_STYLE_PROFILE,
    });
  } catch (error) {
    failure = error;
  }

  // Then
  expect(calls).toHaveLength(2);
  const contractMatch = calls[0]?.systemPrompt.match(
    /<slide-plan-contract>([\s\S]+)<\/slide-plan-contract>/u,
  );
  expect(contractMatch).not.toBeNull();
  const contract: unknown = JSON.parse(contractMatch?.[1] ?? "{}");
  expect(contract).toMatchObject({
    editorialSynthesis: {
      profile: "presentation-editor-v1",
      sourceTextRole: "evidence-not-display-copy",
      copyingGate: { minimumCopiedFields: 3, maxCopiedShareExclusive: 0.5 },
    },
  });
  expect(calls[1]?.validationFailure).toMatchObject({ kind: "editorial-copying" });
  expect(failure).toMatchObject({ code: "model-output-invalid", attempts: 2 });
});

test("repairs copied source sentences into concise slide-specific copy", async () => {
  // Given
  const calls: SlidePlannerCompletionRequest[] = [];
  const outputs = [copiedPlan(), synthesizedPlan()];
  const complete = async (request: SlidePlannerCompletionRequest): Promise<string> => {
    calls.push(request);
    const output = outputs[calls.length - 1];
    if (!output) throw new Error("editorial completion fixture exhausted");
    return JSON.stringify(output);
  };

  // When
  const plan = await planTranscriptToSlides(snapshot, {
    complete,
    createId: () => "editorial-plan",
    now: () => "2026-08-31T00:00:00.000Z",
    theme: MEETING_PAPER_STYLE_PROFILE,
  });

  // Then
  expect(calls).toHaveLength(2);
  expect(calls[1]?.validationFailure).toMatchObject({ kind: "editorial-copying" });
  expect(plan.slides.map((slide) => slide.title)).toEqual([
    "첫 주 이탈을 먼저 줄입니다",
    "문제와 결정, 실행이 연결됐습니다",
    "온보딩을 세 단계로 줄입니다",
    "18% 이탈을 한 자리로 낮춥니다",
    "금요일까지 프로토타입을 준비합니다",
    "첫 주 이탈률이 마지막 기준입니다",
    "출시 준비는 세 항목으로 닫힙니다",
  ]);
  expect(plan.slides.map((slide) => slide.layout)).toEqual([
    "hero", "summary", "decision", "comparison", "actions", "decision", "summary",
  ]);
});
