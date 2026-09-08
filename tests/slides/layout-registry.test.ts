import { describe, expect, test } from "bun:test";

import { compileGeometrySlide } from "../../src/slides/geometry/compiler.ts";
import type { PlanSlide } from "../../src/slides/model/plan.ts";
import {
  productionTextPolicies,
  ScriptAwareTextMeasurer,
} from "../../src/slides/server-action-support.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../../src/slides/theme/meeting-paper.ts";
import { createDeckTheme, THEME_TOKEN_NAMES } from "../../src/slides/theme/theme.ts";
import {
  LayoutRegistryError,
  type LayoutDraft as SharedLayoutDraft,
  type LayoutElement as SharedLayoutElement,
} from "../../src/slides/layouts/contract.ts";
import {
  PRIMARY_LAYOUT_FAMILIES,
  draftLayout,
  getLayoutDefinition,
} from "../../src/slides/layouts/registry.ts";

interface LayoutElement {
  id: string;
  role: string;
  text: string;
  box: { x: number; y: number; width: number; height: number };
  tokens: Readonly<Record<string, string>>;
  accessibility: { role: string; label: string; readingOrder: number };
  evidence: { fieldPath: string; claimIds: readonly string[] } | null;
}

interface LayoutDraft {
  id: string;
  slideId: string;
  layout: PlanSlide["layout"];
  canvas: { width: number; height: number };
  variant: string;
  elements: readonly LayoutElement[];
}

// Keep the test vocabulary structurally tied to the intended shared contract module.
const sharedContract: {
  draft: SharedLayoutDraft extends LayoutDraft ? true : false;
  element: SharedLayoutElement extends LayoutElement ? true : false;
} = { draft: true, element: true };
void sharedContract;

function compile(slide: unknown): LayoutDraft {
  return draftLayout(slide);
}

const hero: Extract<PlanSlide, { layout: "hero" }> = {
  id: "slide-hero",
  layout: "hero",
  storyRole: "opening",
  title: "Evidence changed the launch decision",
  payload: { variant: "cover", statement: "The beta launches Friday." },
  bindings: { title: ["claim-launch"], statement: ["claim-launch"] },
  editorialPaths: [],
  assetIds: [],
};

const summary: Extract<PlanSlide, { layout: "summary" }> = {
  id: "slide-summary",
  layout: "summary",
  storyRole: "context",
  title: "Three signals now point the same way",
  payload: {
    mode: "overview",
    items: [
      "Retention increased by 12%.",
      "Quality remains the release gate.",
      "The beta launches Friday.",
    ],
  },
  bindings: {
    title: ["claim-retention", "claim-gate", "claim-launch"],
    "items[0]": ["claim-retention"],
    "items[1]": ["claim-gate"],
    "items[2]": ["claim-launch"],
  },
  editorialPaths: [],
  assetIds: [],
};

const decision: Extract<PlanSlide, { layout: "decision" }> = {
  id: "slide-decision",
  layout: "decision",
  storyRole: "decision",
  title: "Friday is the release date",
  payload: {
    decision: "Launch the beta on Friday.",
    rationale: ["Retention increased by 12%.", "QA remains the release gate."],
  },
  bindings: {
    title: ["claim-launch"],
    decision: ["claim-launch"],
    "rationale[0]": ["claim-retention"],
    "rationale[1]": ["claim-gate"],
  },
  editorialPaths: [],
  assetIds: [],
};

const comparison: Extract<PlanSlide, { layout: "comparison" }> = {
  id: "slide-comparison",
  layout: "comparison",
  storyRole: "argument",
  title: "The launch moved from uncertain to owned",
  payload: {
    sides: [
      { label: "Before", items: ["No release date", "No named owner"] },
      { label: "After", items: ["Friday release", "Mina owns release notes"] },
    ],
  },
  bindings: {
    title: ["claim-launch", "claim-action"],
    "sides[0].items[0]": ["claim-launch"],
    "sides[0].items[1]": ["claim-action"],
    "sides[1].items[0]": ["claim-launch"],
    "sides[1].items[1]": ["claim-action"],
  },
  editorialPaths: ["sides[0].label", "sides[1].label"],
  assetIds: [],
};

const timeline: Extract<PlanSlide, { layout: "timeline" }> = {
  id: "slide-timeline",
  layout: "timeline",
  storyRole: "argument",
  title: "QA clears the path to publication",
  payload: {
    mode: "process",
    events: [
      { label: "Verify", text: "QA finishes first." },
      { label: "Publish", text: "Release notes go live Thursday." },
      { label: "Launch", text: "The beta launches Friday." },
    ],
  },
  bindings: {
    title: ["claim-process"],
    "events[0].text": ["claim-process"],
    "events[1].text": ["claim-action"],
    "events[2].text": ["claim-launch"],
  },
  editorialPaths: ["events[0].label", "events[1].label", "events[2].label"],
  assetIds: [],
};

const metrics: Extract<PlanSlide, { layout: "metrics" }> = {
  id: "slide-metrics",
  layout: "metrics",
  storyRole: "argument",
  title: "Retention rose after the cohort change",
  payload: {
    mode: "chart",
    metrics: [
      { label: "Before", value: "61%", detail: "Baseline cohort" },
      { label: "After", value: "73%", detail: "Current cohort" },
    ],
  },
  bindings: {
    title: ["claim-retention"],
    "metrics[0].label": ["claim-retention"],
    "metrics[0].value": ["claim-retention"],
    "metrics[0].detail": ["claim-retention"],
    "metrics[1].label": ["claim-retention"],
    "metrics[1].value": ["claim-retention"],
    "metrics[1].detail": ["claim-retention"],
  },
  editorialPaths: [],
  assetIds: ["asset-retention-chart"],
};

const actions: Extract<PlanSlide, { layout: "actions" }> = {
  id: "slide-actions",
  layout: "actions",
  storyRole: "commitment",
  title: "Every launch task now has an owner and date",
  payload: {
    items: [
      { task: "Publish release notes", owner: "Mina", due: "Thursday" },
      { task: "Run final QA", owner: "Owen", due: "Friday 09:00" },
    ],
  },
  bindings: {
    title: ["claim-action"],
    "items[0].task": ["claim-action"],
    "items[0].owner": ["claim-action"],
    "items[0].due": ["claim-action"],
    "items[1].task": ["claim-qa"],
    "items[1].owner": ["claim-qa"],
    "items[1].due": ["claim-qa"],
  },
  editorialPaths: [],
  assetIds: [],
};

const representativeSlides = [
  hero,
  summary,
  decision,
  comparison,
  timeline,
  metrics,
  actions,
] as const satisfies readonly PlanSlide[];

function byRole(draft: LayoutDraft, role: string): LayoutElement[] {
  return draft.elements.filter((element) => element.role === role);
}

function texts(draft: LayoutDraft): string[] {
  return draft.elements.map((element) => element.text);
}

function expectLayoutError(
  operation: () => unknown,
  expected: { code: string; path: string; message: RegExp },
): void {
  try {
    operation();
    throw new Error("expected a LayoutRegistryError");
  } catch (error) {
    expect(error).toBeInstanceOf(LayoutRegistryError);
    const typed = error as LayoutRegistryError;
    expect(typed.code).toBe(expected.code);
    expect(typed.path).toBe(expected.path);
    expect(typed.message).toMatch(expected.message);
  }
}

function expectDraftContract(slide: PlanSlide, draft: LayoutDraft): void {
  expect(draft.id).toBe(`${slide.id}:layout`);
  expect(draft.slideId).toBe(slide.id);
  expect(draft.layout).toBe(slide.layout);
  expect(draft.canvas).toEqual({ width: 1280, height: 720 });
  expect(draft.elements.length).toBeGreaterThan(1);
  expect(new Set(draft.elements.map((element) => element.id)).size).toBe(draft.elements.length);

  const allowedTokens = new Set<string>(THEME_TOKEN_NAMES);
  draft.elements.forEach((element, index) => {
    expect(element.id.startsWith(`${slide.id}:`), element.id).toBe(true);
    expect(element.text.trim().length, `${element.id} has semantic content`).toBeGreaterThan(0);

    for (const [coordinate, value] of Object.entries(element.box)) {
      expect(Number.isInteger(value), `${element.id}.box.${coordinate} is an integer`).toBe(true);
    }
    expect(element.box.x).toBeGreaterThanOrEqual(0);
    expect(element.box.y).toBeGreaterThanOrEqual(0);
    expect(element.box.width).toBeGreaterThan(0);
    expect(element.box.height).toBeGreaterThan(0);
    expect(element.box.x + element.box.width).toBeLessThanOrEqual(1280);
    expect(element.box.y + element.box.height).toBeLessThanOrEqual(720);

    expect(Object.keys(element.tokens).length, `${element.id} declares style tokens`).toBeGreaterThan(0);
    for (const [property, token] of Object.entries(element.tokens)) {
      expect(typeof token, `${element.id}.tokens.${property} is a token reference`).toBe("string");
      expect(allowedTokens.has(token), `${element.id}.tokens.${property}=${String(token)}`).toBe(true);
    }

    expect(element.accessibility.readingOrder).toBe(index);
    expect(element.accessibility.role.length).toBeGreaterThan(0);
    expect(element.accessibility.label).toContain(element.text);
    if (element.evidence !== null) {
      expect(element.evidence.fieldPath.length).toBeGreaterThan(0);
      expect(element.evidence.claimIds.length).toBeGreaterThan(0);
    }
  });

  expect(draft.elements.map((element) => element.accessibility.readingOrder)).toEqual(
    draft.elements.map((_, index) => index),
  );
}

describe("semantic layout registry", () => {
  test("is exhaustive and exposes exactly the seven primary layout families", () => {
    expect(PRIMARY_LAYOUT_FAMILIES).toEqual([
      "hero",
      "summary",
      "decision",
      "comparison",
      "timeline",
      "metrics",
      "actions",
    ]);
    expect(new Set(PRIMARY_LAYOUT_FAMILIES).size).toBe(7);

    for (const family of PRIMARY_LAYOUT_FAMILIES) {
      const definition = getLayoutDefinition(family);
      expect(definition.family).toBe(family);
      expect(typeof definition.draft).toBe("function");
    }
  });

  test("produces detached deterministic drafts with stable slide and semantic element IDs", () => {
    for (const slide of representativeSlides) {
      const before = structuredClone(slide);
      const first = compile(slide);
      const second: LayoutDraft = getLayoutDefinition(slide.layout).draft(structuredClone(slide));

      expect(first).toEqual(second);
      expect(first).not.toBe(second);
      expect(first.elements).not.toBe(second.elements);
      expect(slide).toEqual(before);
      expectDraftContract(slide, first);
    }

    expect(compile(hero).elements.map((element) => element.id)).toEqual([
      "slide-hero:title",
      "slide-hero:statement",
    ]);
    expect(compile(actions).elements.map((element) => element.id)).toEqual([
      "slide-actions:title",
      "slide-actions:action-0-task",
      "slide-actions:action-0-owner",
      "slide-actions:action-0-due",
      "slide-actions:action-1-task",
      "slide-actions:action-1-owner",
      "slide-actions:action-1-due",
    ]);
  });

  test("keeps semantic reading and evidence order rather than visual paint order", () => {
    const draft = compile(comparison);

    expect(texts(draft)).toEqual([
      comparison.title,
      "01",
      "Before",
      "No release date",
      "No named owner",
      "02",
      "After",
      "Friday release",
      "Mina owns release notes",
    ]);
    expect(draft.elements.map((element) => element.evidence?.fieldPath ?? null)).toEqual([
      "title",
      null,
      null,
      "sides[0].items[0]",
      "sides[0].items[1]",
      null,
      null,
      "sides[1].items[0]",
      "sides[1].items[1]",
    ]);
    expect(draft.elements[0]!.evidence?.claimIds).toEqual(["claim-launch", "claim-action"]);
    expect(draft.elements[3]!.evidence?.claimIds).toEqual(["claim-launch"]);
  });
});

describe("layout-specific semantic structures", () => {
  test("hero cover and statement variants remain deliberately asymmetric", () => {
    const cover = compile(hero);
    const statementSlide: Extract<PlanSlide, { layout: "hero" }> = {
      ...hero,
      id: "slide-hero-statement",
      payload: { variant: "statement", statement: "Quality is the release gate." },
      bindings: { title: ["claim-gate"], statement: ["claim-gate"] },
    };
    const statement = compile(statementSlide);

    expect(cover.variant).toBe("cover");
    expect(statement.variant).toBe("statement");
    expect(cover.elements.map((element) => element.role)).toEqual(["title", "statement"]);
    expect(statement.elements.map((element) => element.role)).toEqual(["title", "statement"]);

    for (const draft of [cover, statement]) {
      const title = byRole(draft, "title")[0]!;
      const emphasis = byRole(draft, "statement")[0]!;
      expect(title.box.x).not.toBe(emphasis.box.x);
      expect(title.box.width).not.toBe(emphasis.box.width);
      expect(Math.abs((title.box.x + title.box.width / 2) - 640)).toBeGreaterThan(80);
    }
  });

  test("summary selects list, quote, and statement presentations without losing source metadata", () => {
    const quote: Extract<PlanSlide, { layout: "summary" }> = {
      ...summary,
      id: "slide-summary-quote",
      title: "The release gate is explicit",
      payload: { mode: "overview", items: ["“Quality is the release gate.”"] },
      bindings: { title: ["claim-quote"], "items[0]": ["claim-quote"] },
    };
    const statement: Extract<PlanSlide, { layout: "summary" }> = {
      ...summary,
      id: "slide-summary-statement",
      title: "The launch now has a date",
      payload: { mode: "overview", items: ["The beta launches Friday."] },
      bindings: { title: ["claim-launch"], "items[0]": ["claim-launch"] },
    };

    const listDraft = compile(summary);
    const quoteDraft = compile(quote);
    const statementDraft = compile(statement);

    expect(listDraft.variant).toBe("list");
    expect(quoteDraft.variant).toBe("quote");
    expect(statementDraft.variant).toBe("statement");
    expect(listDraft.elements.map((element) => element.role)).toEqual([
      "title",
      "summary-marker", "summary-item",
      "summary-marker", "summary-item",
      "summary-marker", "summary-item",
    ]);
    expect(quoteDraft.elements.map((element) => element.role)).toEqual(["title", "quote"]);
    expect(statementDraft.elements.map((element) => element.role)).toEqual(["title", "statement"]);
    expect(quoteDraft.elements[1]!.evidence).toEqual({
      fieldPath: "items[0]",
      claimIds: ["claim-quote"],
    });
  });

  test("decision gives the decision priority and preserves ordered rationale", () => {
    const draft = compile(decision);

    expect(draft.variant).toBe("decision-rationale");
    expect(draft.elements.map((element) => element.role)).toEqual([
      "title", "decision", "rationale", "rationale",
    ]);
    expect(texts(draft)).toEqual([
      decision.title,
      decision.payload.decision,
      ...decision.payload.rationale,
    ]);
    expect(byRole(draft, "decision")[0]!.box.width).toBeGreaterThan(
      byRole(draft, "rationale")[0]!.box.width,
    );
  });

  test("comparison requires and renders exactly two semantically grouped sides", () => {
    const draft = compile(comparison);
    const sideLabels = byRole(draft, "comparison-label");
    const sideItems = byRole(draft, "comparison-item");

    expect(draft.variant).toBe("two-sided");
    expect(sideLabels.map((element) => element.text)).toEqual(["Before", "After"]);
    expect(sideItems.map((element) => element.text)).toEqual([
      "No release date", "No named owner", "Friday release", "Mina owns release notes",
    ]);
    expect(sideLabels[0]!.box.x).toBeLessThan(sideLabels[1]!.box.x);
    expect(sideItems[0]!.box.x).toBeLessThan(sideItems[2]!.box.x);
  });

  test("timeline distinguishes process from chronology and retains event order", () => {
    const chronology: Extract<PlanSlide, { layout: "timeline" }> = {
      ...timeline,
      id: "slide-chronology",
      payload: {
        mode: "chronology",
        events: [
          { label: "Thursday", text: "Release notes go live." },
          { label: "Friday", text: "The beta launches." },
        ],
      },
      bindings: {
        title: ["claim-process"],
        "events[0].text": ["claim-action"],
        "events[1].text": ["claim-launch"],
      },
      editorialPaths: ["events[0].label", "events[1].label"],
    };

    const processDraft = compile(timeline);
    const chronologyDraft = compile(chronology);

    expect(processDraft.variant).toBe("process");
    expect(chronologyDraft.variant).toBe("chronology");
    expect(byRole(processDraft, "event-label").map((element) => element.text)).toEqual([
      "Verify", "Publish", "Launch",
    ]);
    expect(byRole(processDraft, "event").map((element) => element.text)).toEqual([
      "QA finishes first.", "Release notes go live Thursday.", "The beta launches Friday.",
    ]);
    expect(byRole(chronologyDraft, "event-label").map((element) => element.text)).toEqual([
      "Thursday", "Friday",
    ]);
    expect(byRole(chronologyDraft, "event")[1]!.evidence?.fieldPath).toBe("events[1].text");
  });

  test("metrics distinguishes chart from cards and keeps label, value, detail semantics", () => {
    const cards: Extract<PlanSlide, { layout: "metrics" }> = {
      ...metrics,
      id: "slide-metric-cards",
      payload: {
        mode: "cards",
        metrics: [
          { label: "Retention", value: "+12%", detail: "After the cohort change" },
          { label: "Launch", value: "Friday", detail: "Reviewed decision" },
        ],
      },
      bindings: {
        title: ["claim-retention"],
        "metrics[0].label": ["claim-retention"],
        "metrics[0].value": ["claim-retention"],
        "metrics[0].detail": ["claim-retention"],
        "metrics[1].label": ["claim-launch"],
        "metrics[1].value": ["claim-launch"],
        "metrics[1].detail": ["claim-launch"],
      },
      assetIds: [],
    };

    const chartDraft = compile(metrics);
    const cardsDraft = compile(cards);

    expect(chartDraft.variant).toBe("chart");
    expect(cardsDraft.variant).toBe("cards");
    for (const draft of [chartDraft, cardsDraft]) {
      expect(byRole(draft, "metric-label")).toHaveLength(2);
      expect(byRole(draft, "metric-value")).toHaveLength(2);
      expect(byRole(draft, "metric-detail")).toHaveLength(2);
    }
    expect(byRole(chartDraft, "metric-value").map((element) => element.text)).toEqual(["61%", "73%"]);
    expect(byRole(cardsDraft, "metric-value").map((element) => element.text)).toEqual(["+12%", "Friday"]);
    expect(byRole(chartDraft, "metric-value")[0]!.accessibility.label).toMatch(/Before.*61%/i);
  });

  test("actions expose each task with its owner and due date in reading order", () => {
    const draft = compile(actions);

    expect(draft.variant).toBe("owner-due");
    expect(draft.elements.map((element) => element.role)).toEqual([
      "title",
      "action-task", "action-owner", "action-due",
      "action-task", "action-owner", "action-due",
    ]);
    expect(texts(draft)).toEqual([
      actions.title,
      "Publish release notes", "Mina", "Thursday",
      "Run final QA", "Owen", "Friday 09:00",
    ]);
    expect(byRole(draft, "action-owner")[0]!.accessibility.label).toMatch(/owner.*Mina/i);
    expect(byRole(draft, "action-due")[1]!.accessibility.label).toMatch(/due.*Friday 09:00/i);
    expect(byRole(draft, "action-owner")[0]!.evidence?.fieldPath).toBe("items[0].owner");
    expect(byRole(draft, "action-due")[1]!.evidence?.fieldPath).toBe("items[1].due");
  });
});

describe("production text-fit policies", () => {
  test("compiling one quoted summary item under productionTextPolicies yields a fitted quote element", () => {
    const quote: Extract<PlanSlide, { layout: "summary" }> = {
      ...summary,
      id: "slide-summary-quote",
      title: "The release gate is explicit",
      payload: { mode: "overview", items: ["“Quality is the release gate.”"] },
      bindings: { title: ["claim-quote"], "items[0]": ["claim-quote"] },
    };
    const result = compileGeometrySlide(compile(quote), createDeckTheme(MEETING_PAPER_STYLE_PROFILE), {
      textMeasurer: new ScriptAwareTextMeasurer(),
      textPolicies: productionTextPolicies(),
    });
    const quoteElement = result.slide.elements.find((element) => element.role === "quote");

    expect(result.issues).toEqual([]);
    expect(quoteElement).toBeDefined();
    expect(quoteElement!.fitTrace).toMatchObject({ policy: "wrap", outcome: "fit" });
  });
});

describe("layout registry boundary failures", () => {
  test("unknown layouts fail with a typed path-rich registry error", () => {
    expectLayoutError(
      () => getLayoutDefinition("dashboard"),
      {
        code: "unknown-layout",
        path: "layout",
        message: /layout.*dashboard.*hero.*summary.*decision.*comparison.*timeline.*metrics.*actions/i,
      },
    );

    expectLayoutError(
      () => draftLayout({ ...hero, layout: "dashboard" }),
      {
        code: "unknown-layout",
        path: "slide.layout",
        message: /slide\.layout.*dashboard/i,
      },
    );
  });

  test("malformed payloads identify the exact failing payload path", () => {
    expectLayoutError(
      () => draftLayout({ ...hero, payload: { variant: "cover" } }),
      {
        code: "invalid-payload",
        path: "slide.payload.statement",
        message: /slide\.payload\.statement.*required/i,
      },
    );

    expectLayoutError(
      () => draftLayout({ ...comparison, payload: { sides: [comparison.payload.sides[0]] } }),
      {
        code: "invalid-payload",
        path: "slide.payload.sides",
        message: /slide\.payload\.sides.*exactly two/i,
      },
    );

    expectLayoutError(
      () => draftLayout({
        ...actions,
        payload: { items: [{ task: "Publish release notes", owner: "Mina", due: "" }] },
      }),
      {
        code: "invalid-payload",
        path: "slide.payload.items[0].due",
        message: /slide\.payload\.items\[0\]\.due.*empty/i,
      },
    );
  });
});
