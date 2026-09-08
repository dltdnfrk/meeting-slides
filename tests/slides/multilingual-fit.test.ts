import { describe, expect, test } from "bun:test";

import type {
  GeometryCompileResult,
  GeometryElement,
  GeometryPreflightResult,
  TextMeasureInput,
  TextMeasurer,
  TextFitPolicy,
} from "../../src/slides/geometry/contract.ts";
import { compileGeometrySlide } from "../../src/slides/geometry/compiler.ts";
import { fitText } from "../../src/slides/geometry/text-fit.ts";
import { preflightGeometrySlide } from "../../src/slides/geometry/preflight.ts";
import { draftLayout, PRIMARY_LAYOUT_FAMILIES } from "../../src/slides/layouts/registry.ts";
import type { PlanSlide } from "../../src/slides/model/plan.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../../src/slides/theme/meeting-paper.ts";
import { createDeckTheme } from "../../src/slides/theme/theme.ts";

const CANVAS = { width: 1280, height: 720 } as const;
const TITLE_FLOOR = 28;
const BODY_FLOOR = 18;
const LABEL_FLOOR = 14;
const theme = createDeckTheme(MEETING_PAPER_STYLE_PROFILE);

/**
 * Injected metrics model the important script boundaries without consulting an
 * installed font, browser, clock, locale, or process state. Hangul occupies a
 * full em; Latin letters and digits, spaces, and punctuation each have distinct
 * advances. URL-like runs are recorded separately so the fixture proves that
 * its unbroken-word boundary was actually measured.
 */
class MultilingualFontMetrics implements TextMeasurer {
  readonly categories = new Set<"hangul" | "latin" | "space" | "punctuation" | "url-run">();
  readonly calls: TextMeasureInput[] = [];

  measure(input: TextMeasureInput): { width: number; height: number } {
    this.calls.push({ ...input });
    if (/^(?:https?:\/\/|www\.)\S+$/u.test(input.text)) this.categories.add("url-run");

    let ems = 0;
    for (const character of input.text) {
      if (/^[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]$/u.test(character)) {
        this.categories.add("hangul");
        ems += 1;
      } else if (/^[A-Za-z0-9]$/u.test(character)) {
        this.categories.add("latin");
        ems += 0.56;
      } else if (/^\s$/u.test(character)) {
        this.categories.add("space");
        ems += 0.28;
      } else {
        this.categories.add("punctuation");
        ems += 0.36;
      }
    }
    return { width: ems * input.fontSize, height: input.fontSize * 1.2 };
  }
}

const LABEL_ROLES = new Set([
  "summary-marker", "comparison-marker", "comparison-label", "event-label", "metric-label",
]);
const PROMINENT_ROLES = new Set(["statement", "decision", "metric-value", "action-task"]);

function policyFor(role: string): TextFitPolicy {
  return {
    mode: "wrap",
    wordBreak: "keep-all",
    overflowWrap: "break-word",
    fontFloor: role === "title" ? TITLE_FLOOR
      : LABEL_ROLES.has(role) ? LABEL_FLOOR
      : PROMINENT_ROLES.has(role) ? 22
      : BODY_FLOOR,
  };
}

const roles = [
  "title", "statement", "summary-item", "decision", "rationale",
  "comparison-label", "comparison-item", "event-label", "event",
  "metric-label", "metric-value", "metric-detail",
  "action-task", "action-owner", "action-due",
] as const;
const textPolicies = Object.freeze(Object.fromEntries(roles.map((role) => [role, policyFor(role)])));

function bindings(paths: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(paths.map((path) => [path, [`claim-${path.replace(/[^a-z0-9]+/gi, "-")}`]]));
}

const title = (lead: string, tail: string): string => `${lead}\n${tail}`;

const slides = [
  {
    id: "fit-hero", layout: "hero", storyRole: "opening",
    title: title("출시 신호", "Launch signal"),
    payload: {
      variant: "cover",
      statement: "고객 검증을 마쳤습니다\nThe reviewed beta is ready for Friday.",
    },
    bindings: bindings(["title", "statement"]), editorialPaths: [], assetIds: [],
  },
  {
    id: "fit-summary", layout: "summary", storyRole: "context",
    title: title("출시 준비 Release readiness", "여섯 신호가 정렬되었습니다"),
    payload: {
      mode: "takeaways",
      items: [
        "고객 유지율은 상승했습니다\nRetention improved in the reviewed cohort.",
        "최종 QA가 배포 기준입니다\nFinal QA remains the release gate.",
        "금요일 베타 일정이 확정됐습니다\nThe Friday beta date is confirmed.",
        "릴리스 노트 담당자가 정해졌습니다\nMina owns the release notes.",
        "지원팀 운영 절차를 점검했습니다\nSupport reviewed the launch playbook.",
        "위험 항목과 대응책을 연결했습니다\nEvery launch risk now has a response.",
      ],
    },
    bindings: bindings(["title", ...Array.from({ length: 6 }, (_, index) => `items[${index}]`)]),
    editorialPaths: [], assetIds: [],
  },
  {
    id: "fit-decision", layout: "decision", storyRole: "decision",
    title: title("금요일 출시 Friday launch", "검토된 결정입니다"),
    payload: {
      decision: "최종 QA 통과 후 금요일에 베타를 출시합니다\nShip the reviewed beta on Friday after final QA.",
      rationale: [
        "유지율 상승 확인\nRetention trend verified.",
        "오류 예산 충족\nError budget is healthy.",
        "지원 인력 확정\nSupport coverage confirmed.",
        "배포 책임자 지정\nRelease owner assigned.",
        "복구 절차 검증\nRollback path rehearsed.",
        "고객 공지 준비\nCustomer notice approved.",
      ],
    },
    bindings: bindings(["title", "decision", ...Array.from({ length: 6 }, (_, index) => `rationale[${index}]`)]),
    editorialPaths: [], assetIds: [],
  },
  {
    id: "fit-comparison", layout: "comparison", storyRole: "argument",
    title: title("출시 전후 Before and after", "책임과 기준이 선명해졌습니다"),
    payload: {
      sides: [
        {
          label: "이전 Before",
          items: [
            "출시일 미정\nNo approved date.", "담당자 미정\nNo named owner.",
            "품질 기준 분산\nQuality gates varied.", "복구 훈련 없음\nRollback untested.",
            "공지 초안 없음\nNotice not drafted.", "지표 링크 없음\nNo metric source.",
          ],
        },
        {
          label: "현재 Now",
          items: [
            "금요일 확정\nFriday approved.", "민지가 담당\nMina owns release.",
            "QA 기준 통합\nOne QA gate.", "복구 훈련 완료\nRollback rehearsed.",
            "공지 검토 완료\nNotice reviewed.", "문서 확인\nhttps://go.example/r2",
          ],
        },
      ],
    },
    bindings: bindings([
      "title",
      ...Array.from({ length: 2 }, (_, side) =>
        Array.from({ length: 6 }, (_, item) => `sides[${side}].items[${item}]`)).flat(),
    ]),
    editorialPaths: ["sides[0].label", "sides[1].label"], assetIds: [],
  },
  {
    id: "fit-timeline", layout: "timeline", storyRole: "argument",
    title: title("출시 경로 Launch path", "검증부터 고객 공지까지"),
    payload: {
      mode: "process",
      events: [
        { label: "검증 QA", text: "회귀 테스트를 완료합니다\nComplete regression checks." },
        { label: "승인 Sign", text: "품질 기준을 승인합니다\nApprove the quality gate." },
        { label: "문서 Docs", text: "릴리스 노트를 게시합니다\nPublish release notes." },
        { label: "배포 Ship", text: "검토된 빌드를 배포합니다\nDeploy the reviewed build." },
        { label: "관찰 Watch", text: "핵심 지표를 관찰합니다\nMonitor launch metrics." },
        { label: "공지 Tell", text: "고객에게 결과를 알립니다\nNotify beta customers." },
      ],
    },
    bindings: bindings(["title", ...Array.from({ length: 6 }, (_, index) => `events[${index}].text`)]),
    editorialPaths: Array.from({ length: 6 }, (_, index) => `events[${index}].label`), assetIds: [],
  },
  {
    id: "fit-metrics", layout: "metrics", storyRole: "argument",
    title: title("출시 지표 Launch metrics", "여섯 기준이 목표를 충족했습니다"),
    payload: {
      mode: "cards",
      metrics: [
        { label: "유지율 RET", value: "73%", detail: "전주 대비\n+12% WoW" },
        { label: "성공률 SLO", value: "99%", detail: "목표 이상\nAbove goal" },
        { label: "오류율 ERR", value: "0.8%", detail: "기준 이하\nBelow cap" },
        { label: "응답속도 P95", value: "180ms", detail: "목표 충족\nOn target" },
        { label: "담당률 OWN", value: "100%", detail: "전부 지정\nAll assigned" },
        { label: "준비도 RDY", value: "6/6", detail: "검토 완료\nReviewed" },
      ],
    },
    bindings: bindings([
      "title",
      ...Array.from({ length: 6 }, (_, index) => [
        `metrics[${index}].label`, `metrics[${index}].value`, `metrics[${index}].detail`,
      ]).flat(),
    ]),
    editorialPaths: [], assetIds: [],
  },
  {
    id: "fit-actions", layout: "actions", storyRole: "commitment",
    title: title("출시 작업 Launch actions", "모든 항목에 담당자와 기한이 있습니다"),
    payload: {
      items: [
        { task: "회귀 QA 완료 / Finish QA", owner: "김민지 Mina", due: "목요일 Thu" },
        { task: "릴리스 노트 / Publish notes", owner: "이준 Leo", due: "목요일 Thu" },
        { task: "복구 훈련 / Run rollback", owner: "박서윤 Sue", due: "금요일 Fri" },
        { task: "지표 확인 / Check metrics", owner: "최도윤 Dan", due: "금요일 Fri" },
        { task: "고객 공지 / Notify users", owner: "정하나 Hana", due: "금요일 Fri" },
        { task: "회고 준비 / Prep review", owner: "오지훈 Owen", due: "월요일 Mon" },
      ],
    },
    bindings: bindings([
      "title",
      ...Array.from({ length: 6 }, (_, index) => [
        `items[${index}].task`, `items[${index}].owner`, `items[${index}].due`,
      ]).flat(),
    ]),
    editorialPaths: [], assetIds: [],
  },
] as const satisfies readonly PlanSlide[];

function compile(slide: PlanSlide, measurer = new MultilingualFontMetrics()): GeometryCompileResult {
  return compileGeometrySlide(draftLayout(slide), theme, { textMeasurer: measurer, textPolicies });
}

function preflight(slide: PlanSlide, measurer = new MultilingualFontMetrics()): GeometryPreflightResult {
  return preflightGeometrySlide(compile(slide, measurer));
}

function words(text: string): string[] {
  return text.trim().split(/\s+/u);
}

function expectExplicitBreaksRetained(element: GeometryElement): void {
  const paragraphs = element.text.split("\n");
  if (paragraphs.length < 2) return;

  const outputBoundaries: number[] = [];
  let outputWords = 0;
  for (const line of element.lines) {
    outputWords += words(line).length;
    outputBoundaries.push(outputWords);
  }

  let sourceWords = 0;
  for (const paragraph of paragraphs.slice(0, -1)) {
    sourceWords += words(paragraph).length;
    expect(outputBoundaries, `${element.id} lost an explicit line break`).toContain(sourceWords);
  }
  expect(element.lines.flatMap(words), `${element.id} changed text while wrapping`).toEqual(
    paragraphs.flatMap(words),
  );
}

function expectContainedAndAboveFloors(result: GeometryPreflightResult): void {
  expect(result.status, `${result.slide.layout}: ${result.issues.map((issue) => issue.code).join(",")}`).toBe("publishable");
  expect(result.issues).toEqual([]);
  expect(result.slide.canvas).toEqual(CANVAS);

  for (const element of result.slide.elements) {
    expect(element.box.x, `${element.id}.box.x`).toBeGreaterThanOrEqual(0);
    expect(element.box.y, `${element.id}.box.y`).toBeGreaterThanOrEqual(0);
    expect(element.box.x + element.box.width, `${element.id}.box right`).toBeLessThanOrEqual(CANVAS.width);
    expect(element.box.y + element.box.height, `${element.id}.box bottom`).toBeLessThanOrEqual(CANVAS.height);
    expect(element.fitTrace.outcome, element.id).toBe("fit");
    expect(element.fitTrace.finalFontSize, `${element.id} crossed its role floor`).toBeGreaterThanOrEqual(
      element.role === "title" ? TITLE_FLOOR : LABEL_ROLES.has(element.role) ? LABEL_FLOOR : BODY_FLOOR,
    );
    expectExplicitBreaksRetained(element);
  }
}

function withImpossibleText(slide: PlanSlide, target: "title" | "body"): PlanSlide {
  const impossible = `https://release.example/${"검증Release-2026.08.14/".repeat(80)}`;
  if (target === "title") return { ...slide, title: impossible };
  if (slide.layout !== "actions") throw new Error("body boundary fixture requires actions");
  return {
    ...slide,
    payload: {
      ...slide.payload,
      items: slide.payload.items.map((item, index) => index === 0 ? { ...item, task: impossible } : item),
    },
  };
}

/**
 * Minimal deterministic metrics for the keep-all wrap unit: Hangul syllables
 * occupy one em, every other code point (space, punctuation, Latin) half an em.
 */
class KeepAllWrapMetrics implements TextMeasurer {
  measure(input: TextMeasureInput): { width: number; height: number } {
    const ems = [...input.text].reduce((sum, character) =>
      sum + (/^[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]$/u.test(character) ? 1 : 0.5), 0);
    return { width: ems * input.fontSize, height: input.fontSize * 1.2 };
  }
}

function keepAllWrap(text: string, width: number): ReturnType<typeof fitText> {
  return fitText({
    text,
    width,
    height: 400,
    fontFamily: "fixture",
    fontSize: 22,
    policy: { mode: "wrap", wordBreak: "keep-all", overflowWrap: "break-word", fontFloor: 18 },
    measurer: new KeepAllWrapMetrics(),
  });
}

describe("keep-all word break policy in the fit engine", () => {
  test("wraps a spaced Hangul sentence only at spaces when keep-all + break-word", () => {
    const trace = keepAllWrap("출시 결정은 금요일 확정", 132);

    expect(trace.lines).toEqual(["출시 결정은", "금요일 확정"]);
  });

  test("splits a single over-wide Hangul token only when it alone exceeds the width", () => {
    const wide = keepAllWrap("회귀테스트를완료합니다", 242);
    const narrow = keepAllWrap("회귀테스트를완료합니다", 110);

    expect(wide.lines).toEqual(["회귀테스트를완료합니다"]);
    expect(narrow.lines.length).toBeGreaterThan(1);
    expect(narrow.lines.every((line) =>
      new KeepAllWrapMetrics().measure({ text: line, fontFamily: "fixture", fontSize: 22 }).width <= 110)).toBe(true);
    expect(narrow.lines.join("")).toBe("회귀테스트를완료합니다");
  });

  test("breaks at punctuation under keep-all instead of splitting a word per code point", () => {
    const trace = keepAllWrap("출시 결정은,금요일 확정", 132);

    expect(trace.lines).toEqual(["출시 결정은,", "금요일 확정"]);
    expect(trace.lines.join("")).toBe("출시 결정은,금요일 확정");
  });

  test("keeps the existing wrap behavior under wordBreak normal", () => {
    const trace = fitText({
      text: "ABCDEFGHIJKL",
      width: 66,
      height: 400,
      fontFamily: "fixture",
      fontSize: 22,
      policy: { mode: "wrap", wordBreak: "normal", overflowWrap: "break-word", fontFloor: 18 },
      measurer: new KeepAllWrapMetrics(),
    });

    expect(trace.lines).toEqual(["ABCDEF", "GHIJKL"]);
  });
});

describe("multilingual long-copy containment across semantic layouts", () => {
  test("all seven realistic maximum-density layouts are publishable, contained, floor-safe, and deterministic", () => {
    expect(slides.map((slide) => slide.layout)).toEqual([...PRIMARY_LAYOUT_FAMILIES]);
    const categories = new Set<string>();

    for (const slide of slides) {
      const firstMetrics = new MultilingualFontMetrics();
      const first = preflight(slide, firstMetrics);
      const second = preflight(structuredClone(slide));

      expectContainedAndAboveFloors(first);
      expect(JSON.stringify(second), `${slide.layout} output is not byte-deterministic`).toBe(JSON.stringify(first));
      for (const category of firstMetrics.categories) categories.add(category);
      expect(first.slide.elements.some((element) => element.text.includes("\n")), `${slide.layout} has no line-break evidence`).toBe(true);
    }

    expect([...categories].sort()).toEqual(["hangul", "latin", "punctuation", "space", "url-run"]);
  });

  test("impossible unbroken title and body runs block publication instead of being clipped", () => {
    const boundaries = [
      { slide: withImpossibleText(slides[0], "title"), elementId: "fit-hero:title" },
      { slide: withImpossibleText(slides[6], "body"), elementId: "fit-actions:action-0-task" },
    ] as const;

    for (const boundary of boundaries) {
      const first = preflight(boundary.slide);
      const second = preflight(structuredClone(boundary.slide));
      const failed = first.slide.elements.find((element) => element.id === boundary.elementId)!;

      expect(first.status).toBe("blocked");
      expect(first.issues.map((issue) => ({ code: issue.code, elementIds: issue.elementIds }))).toEqual([{
        code: "text-overflow",
        elementIds: [boundary.elementId],
      }]);
      expect(failed.fitTrace).toMatchObject({ policy: "wrap", outcome: "overflow" });
      expect(failed.lines.length).toBeGreaterThan(1);
      expect(failed.lines.join("")).toBe(failed.text);
      expect(failed.box.x + failed.box.width).toBeLessThanOrEqual(CANVAS.width);
      expect(failed.box.y + failed.box.height).toBeLessThanOrEqual(CANVAS.height);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });
});
