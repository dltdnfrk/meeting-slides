import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;

const SHA = "a".repeat(64);

type SlidePlanWorkspaceContract = {
  readonly setBusy: (busy: boolean) => void;
  readonly currentPublicationStatus: () => string | null;
  readonly isDirty: () => boolean;
  readonly currentPlan: () => {
    readonly slides: readonly {
      readonly title: string;
      readonly boxOverrides?: readonly {
        readonly elementId: string;
        readonly box: {
          readonly x: number;
          readonly y: number;
          readonly width: number;
          readonly height: number;
        };
      }[];
    }[];
  } | null;
};

type SlidePlanWorkspaceWindow = Window & {
  readonly __slidePlanWorkspace?: SlidePlanWorkspaceContract;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function plan() {
  const theme = {
    id: "meeting-paper-v1", canvas: { width: 1280, height: 720 },
    font: { family: "Pretendard", localPath: "fonts/Pretendard.woff2", sha256: SHA },
    colors: { paper: "F6F1E8", raised: "FFFDF8", ink: "14213D", muted: "5B6475", rule: "D9D2C4", coral: "AD4B2F", blue: "335C81", focus: "1E5AA8" },
    spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 },
    typography: { display: { size: 64, lineHeight: 68, weight: 700 }, heading: { size: 36, lineHeight: 42, weight: 700 }, body: { size: 22, lineHeight: 30, weight: 400 }, label: { size: 16, lineHeight: 20, weight: 600 } },
    stroke: { thin: 1, strong: 3 }, radius: { small: 8, large: 24 },
  };
  const source = { transcriptVersionId: "transcript-v1", startSeq: 1, endSeq: 1, evidenceQuote: "Friday launch." };
  return {
    schemaVersion: 1, planId: "plan:launch", revision: 4,
    snapshot: { meetingId: 7, transcriptVersionId: "transcript-v1", contentSha256: SHA, lineCount: 1 },
    title: "Launch review", theme,
    claims: [{ id: "claim-launch", kind: "decision", text: "Friday launch.", method: "reviewed", sources: [source] }], assets: [],
    slides: [
      { id: "opening", layout: "hero", storyRole: "opening", title: "Launch review", payload: { variant: "cover", statement: "Friday launch." }, bindings: { title: ["claim-launch"], statement: ["claim-launch"] }, editorialPaths: [], assetIds: [], notes: "Welcome the room." },
      { id: "decision", layout: "decision", storyRole: "decision", title: "Ship Friday", payload: { decision: "Friday launch.", rationale: ["Review complete."] }, bindings: { title: ["claim-launch"], decision: ["claim-launch"], "rationale[0]": ["claim-launch"] }, editorialPaths: [], assetIds: [], notes: "Confirm the owner." },
    ], createdAt: "2026-08-14T10:00:00.000Z", updatedAt: "2026-08-14T10:05:00.000Z",
  };
}

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
}, 20_000);

afterAll(async () => { await browser?.close(); harness.stop(); });

async function selectMeeting() {
  harness.pushMessage({ type: "meetings", items: [{ id: 7, title: "Launch review", started_at: 1_700_000_000_000, status: "ended" }] });
  await page.waitForSelector('.session-row[data-meeting-id="7"]');
  const already = await page.$('.session-row--selected[data-meeting-id="7"]');
  if (already) return;
  const selected = harness.nextClientMessage();
  await page.click('.session-row[data-meeting-id="7"]');
  expect(await selected).toEqual({ action: "selectMeeting", meetingId: 7 });
}

function meeting(slidePlan: unknown = {
  plan: plan(),
  path: "ignored",
  publicationSha256: SHA,
  publicationStatus: "draft",
  publishedAt: 1,
}) {
  return { type: "meeting", meetingId: 7, title: "Launch review", transcript: [{ text: "Friday launch.", ts: 1_700_000_000_100 }], current: null, history: [], compiled: null, slidePlan };
}

function geometryElement(id: string, text: string, fieldPath: string, box: { x: number; y: number; width: number; height: number }) {
  return {
    id, role: fieldPath, text, box, tokens: {},
    resolvedTokens: { color: "14213D", size: fieldPath === "title" ? 42 : 22 },
    accessibility: { role: fieldPath, label: text, readingOrder: 0 },
    evidence: { fieldPath, claimIds: ["claim-launch"] },
    lines: [text],
    fitTrace: {
      policy: "wrap", requestedFontSize: 42, finalFontSize: 42, fontFloor: 28,
      outcome: "fit", lines: [text], attempts: [],
    },
  };
}

function openingGeometry(elements: ReturnType<typeof geometryElement>[]) {
  return {
    plan: plan(),
    path: "ignored",
    publicationSha256: SHA,
    publishedAt: 1,
    geometry: [{
      id: "opening:geometry",
      slideId: "opening",
      layout: "hero",
      canvas: { width: 1280, height: 720 },
      variant: "cover",
      elements,
    }],
  };
}

function firePointer(el: Element, type: string, x: number, y: number, extra: PointerEventInit = {}) {
  el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerId: 1,
    pointerType: "mouse", isPrimary: true, clientX: x, clientY: y,
    buttons: type === "pointerup" ? 0 : 1,
    ...extra,
  }));
}

describe("persisted SlidePlan browser workspace", () => {
  test("restores into the center stage with accessible controls, exports, keyboard, and reduced motion", async () => {
    await selectMeeting();
    harness.pushMessage(meeting());
    await page.waitForSelector('[data-slide-plan-workspace]:not([hidden])');

    expect(await page.evaluate(() => {
      const paper = document.querySelector<HTMLElement>("[data-slide-plan-paper]");
      const stage = document.querySelector<HTMLElement>(".slide-plan-workspace__stage");
      const dock = document.querySelector<HTMLElement>(".dock");
      if (paper === null || stage === null || dock === null) {
        throw new TypeError("slide plan workspace geometry is incomplete");
      }
      const body = document.querySelector("[data-slide-plan-body]")?.textContent ?? "";
      const paperBox = paper.getBoundingClientRect();
      const stageBox = stage.getBoundingClientRect();
      const dockBox = dock.getBoundingClientRect();
      return {
        legacyHidden: (document.getElementById("current-slide") as HTMLElement).hidden,
        title: document.querySelector("[data-slide-plan-title]")?.textContent,
        counter: document.querySelector("[data-slide-counter]")?.textContent,
        reduced: document.querySelector("[data-slide-plan-workspace]")?.getAttribute("data-reduced-motion"),
        publicationStatus: document.querySelector("[data-slide-plan-workspace]")?.getAttribute("data-publication-status"),
        workspaceLabel: document.querySelector("[data-slide-plan-workspace]")?.getAttribute("aria-label"),
        badgeStatus: document.querySelector("[data-slide-plan-publication-status]")?.getAttribute("data-publication-status"),
        badgeText: document.querySelector("[data-slide-plan-publication-status]")?.textContent,
        savedStatus: document.querySelector("[data-slide-plan-status]")?.textContent,
        hrefs: [...document.querySelectorAll("[data-slide-plan-export]")].map((node) => node.getAttribute("href")),
        body,
        paperFitsStage: paperBox.bottom <= stageBox.bottom + 1 && paperBox.top >= stageBox.top - 1,
        paperAboveDock: paperBox.bottom <= dockBox.top + 1,
      };
    })).toEqual({
      legacyHidden: true, title: "Launch review", counter: "1 / 2", reduced: "true",
      publicationStatus: "draft", workspaceLabel: "편집 가능한 슬라이드 초안",
      badgeStatus: "draft", badgeText: "초안",
      savedStatus: "초안",
      hrefs: [
        "/slide-plan-artifacts/plan%3Alaunch/standalone/index.html",
        "/slide-plan-artifacts/plan%3Alaunch/editable/deck.pptx",
        "/slide-plan-artifacts/plan%3Alaunch/raster/deck.pdf",
        "/slide-plan-artifacts/plan%3Alaunch/raster/png/slide-01.png",
      ],
      body: "Friday launch.",
      paperFitsStage: true,
      paperAboveDock: true,
    });

    await page.click("[data-deck-next]");
    expect(await page.$eval("[data-slide-counter]", (node) => node.textContent)).toBe("2 / 2");
    await page.click("[data-deck-previous]");
    await page.click("[data-deck-overview-toggle]");
    expect(await page.$eval("[data-deck-overview]", (node) => (node as HTMLElement).hidden)).toBe(false);
    await page.$eval('[data-slide-id="decision"]', (node) => (node as HTMLButtonElement).click());
    await page.click("[data-presenter-toggle]");
    await page.click("[data-speaker-notes-toggle]");
    expect(await page.$eval("[data-speaker-notes]", (node) => node.textContent)).toBe("Confirm the owner.");
    await page.click("[data-presenter-toggle]");
    await page.focus("[data-deck-stage]");
    await page.keyboard.press("ArrowLeft");
    expect(await page.$eval("[data-slide-counter]", (node) => node.textContent)).toBe("1 / 2");
    await page.keyboard.press("ArrowRight");
    const beforeOutsideKey = await page.$eval("[data-slide-counter]", (node) => node.textContent);
    await page.evaluate(() => {
      const outside = document.createElement("div");
      outside.id = "outside-slide-plan-key-target";
      outside.tabIndex = 0;
      document.body.append(outside);
      outside.focus();
    });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("outside-slide-plan-key-target");
    await page.keyboard.press("PageUp");
    expect(await page.$eval("[data-slide-counter]", (node) => node.textContent)).toBe(beforeOutsideKey);

    await page.evaluate(() => {
      const workspaceWindow: SlidePlanWorkspaceWindow = window;
      workspaceWindow.__slidePlanWorkspace?.setBusy(true);
    });
    await page.click("[data-deck-previous]");
    expect(await page.$eval("#btn-export-pdf", (node) => (node as HTMLButtonElement).disabled)).toBe(true);
    expect(await page.$eval("#btn-export-png", (node) => (node as HTMLButtonElement).disabled)).toBe(true);
    await page.evaluate(() => {
      const workspaceWindow: SlidePlanWorkspaceWindow = window;
      workspaceWindow.__slidePlanWorkspace?.setBusy(false);
    });
  });

  test("exposes the loaded publication status without widening the editor state seam", async () => {
    await selectMeeting();
    harness.pushMessage(meeting());
    await page.waitForSelector('[data-slide-plan-workspace][data-publication-status="draft"]');
    expect(await page.evaluate(() => {
      const workspaceWindow: SlidePlanWorkspaceWindow = window;
      const workspace = workspaceWindow.__slidePlanWorkspace;
      return { publicationStatus: workspace?.currentPublicationStatus(), dirty: workspace?.isDirty() };
    })).toEqual({ publicationStatus: "draft", dirty: false });
  });

  test("projects final publication status onto the workspace and status badge", async () => {
    await selectMeeting();
    harness.pushMessage(meeting({
      plan: plan(),
      path: "ignored",
      publicationSha256: SHA,
      publicationStatus: "final",
      publishedAt: 2,
    }));
    await page.waitForFunction(() =>
      document.querySelector("[data-slide-plan-workspace]")?.getAttribute("data-publication-status") === "final");

    expect(await page.evaluate(() => ({
      workspace: document.querySelector("[data-slide-plan-workspace]")?.getAttribute("data-publication-status"),
      workspaceLabel: document.querySelector("[data-slide-plan-workspace]")?.getAttribute("aria-label"),
      badge: document.querySelector("[data-slide-plan-publication-status]")?.getAttribute("data-publication-status"),
      badgeText: document.querySelector("[data-slide-plan-publication-status]")?.textContent,
      savedStatus: document.querySelector("[data-slide-plan-status]")?.textContent,
    }))).toEqual({
      workspace: "final",
      workspaceLabel: "편집 가능한 슬라이드 확정본",
      badge: "final",
      badgeText: "확정본",
      savedStatus: "확정본",
    });
  });

  test("keeps edits local, supports layout/undo/redo, and gates stale exports", async () => {
    await page.$eval('[data-slide-id="decision"]', (node) => (node as HTMLButtonElement).click());
    await page.select("[data-slide-layout]", "timeline");

    expect(await page.evaluate(() => ({
      title: (document.querySelector("[data-slide-title-input]") as HTMLInputElement).value,
      layout: (document.querySelector("[data-slide-layout]") as HTMLSelectElement).value,
      status: document.querySelector("[data-slide-plan-status]")?.textContent,
      stale: [...document.querySelectorAll("[data-slide-plan-export]")].every((node) => node.getAttribute("aria-disabled") === "true" && !node.hasAttribute("href")),
      legacyExportsDisabled: ["btn-export-deck", "btn-export-pdf", "btn-export-png"].every((id) => (document.getElementById(id) as HTMLButtonElement).disabled),
    }))).toMatchObject({ layout: "timeline", stale: true, legacyExportsDisabled: true });
    await page.$eval("[data-deck-undo]", (node) => (node as HTMLButtonElement).click());
    expect(await page.$eval("[data-slide-layout]", (node) => (node as HTMLSelectElement).value)).toBe("decision");
    await page.$eval("[data-deck-redo]", (node) => (node as HTMLButtonElement).click());
    expect(await page.$eval("[data-slide-layout]", (node) => (node as HTMLSelectElement).value)).toBe("timeline");
  });

  test("persists a dirty local draft instead of compiling a new plan", async () => {
    await page.select("[data-slide-layout]", "timeline");
    await page.evaluate(() => { (window as typeof window & { plan?: unknown }).plan = { sentinel: true }; });
    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    const persist = harness.nextClientMessage();
    await page.click("#btn-compile-deck");
    const message = await persist;
    if (!isRecord(message)) throw new TypeError("persist message must be an object");
    expect(message.action).toBe("persistSlidePlan");
    const persistedPlan = message.plan;
    if (!isRecord(persistedPlan) || !Array.isArray(persistedPlan.slides)) {
      throw new TypeError("persist message plan must contain slides");
    }
    expect(persistedPlan.slides.some((slide) => isRecord(slide) && slide.layout === "timeline")).toBe(true);
    expect(await page.evaluate(() => (window as typeof window & { plan?: unknown }).plan)).toEqual({ sentinel: true });
    expect(await page.$eval("[data-slide-title-input]", (node) => (node as HTMLInputElement).disabled)).toBe(true);
    expect(await page.$eval("[data-slide-layout]", (node) => (node as HTMLSelectElement).disabled)).toBe(true);
    harness.pushMessage({ type: "compile", status: "error", meetingId: 7, error: "persist test complete" });
    await page.waitForFunction(() => !(document.getElementById("btn-compile-deck") as HTMLButtonElement).disabled);
  });

  test("Given compiled geometry, When a title box is dragged, Then the local plan stores a box override", async () => {
    await selectMeeting();
    harness.pushMessage(meeting({
      plan: plan(),
      path: "ignored",
      publicationSha256: SHA,
      publishedAt: 1,
      geometry: [{
        id: "opening:geometry",
        slideId: "opening",
        layout: "hero",
        canvas: { width: 1280, height: 720 },
        variant: "cover",
        elements: [{
          id: "opening:title",
          role: "title",
          text: "Launch review",
          box: { x: 80, y: 72, width: 500, height: 180 },
          tokens: {},
          resolvedTokens: { color: "14213D", size: 42 },
          accessibility: { role: "title", label: "Launch review", readingOrder: 0 },
          evidence: { fieldPath: "title", claimIds: ["claim-launch"] },
          lines: ["Launch review"],
          fitTrace: {
            policy: "wrap", requestedFontSize: 42, finalFontSize: 42, fontFloor: 28,
            outcome: "fit", lines: ["Launch review"], attempts: [],
          },
        }],
      }],
    }));
    await page.waitForSelector('[data-geometry-element="opening:title"]');
    const before = await page.$eval('[data-geometry-element="opening:title"]', (node) => {
      const style = getComputedStyle(node);
      return { left: style.left, top: style.top };
    });
    await page.$eval('[data-geometry-element="opening:title"]', (node) => {
      const el = node as HTMLButtonElement;
      el.scrollIntoView({ block: "center" });
      const rect = el.getBoundingClientRect();
      const fire = (type: string, x: number, y: number) => {
        el.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          clientX: x,
          clientY: y,
          buttons: type === "pointerup" ? 0 : 1,
        }));
      };
      fire("pointerdown", rect.left + 4, rect.top + 4);
      fire("pointermove", rect.left + 80, rect.top + 40);
      fire("pointerup", rect.left + 80, rect.top + 40);
    });
    const after = await page.$eval('[data-geometry-element="opening:title"]', (node) => {
      const style = getComputedStyle(node);
      return { left: style.left, top: style.top };
    });
    expect(after).not.toEqual(before);
    const overrides = await page.evaluate(() => {
      const workspaceWindow: SlidePlanWorkspaceWindow = window;
      return workspaceWindow.__slidePlanWorkspace?.currentPlan()?.slides[0]?.boxOverrides ?? null;
    });
    expect(Array.isArray(overrides) && overrides.length === 1).toBe(true);
  });

  test("Given a selected title, When the southeast handle is dragged, Then the override stores a larger box", async () => {
    await selectMeeting();
    harness.pushMessage(meeting({
      plan: plan(),
      path: "ignored",
      publicationSha256: SHA,
      publishedAt: 1,
      geometry: [{
        id: "opening:geometry",
        slideId: "opening",
        layout: "hero",
        canvas: { width: 1280, height: 720 },
        variant: "cover",
        elements: [{
          id: "opening:title",
          role: "title",
          text: "Launch review",
          box: { x: 80, y: 72, width: 500, height: 180 },
          tokens: {},
          resolvedTokens: { color: "14213D", size: 42 },
          accessibility: { role: "title", label: "Launch review", readingOrder: 0 },
          evidence: { fieldPath: "title", claimIds: ["claim-launch"] },
          lines: ["Launch review"],
          fitTrace: {
            policy: "wrap", requestedFontSize: 42, finalFontSize: 42, fontFloor: 28,
            outcome: "fit", lines: ["Launch review"], attempts: [],
          },
        }],
      }],
    }));
    await page.waitForSelector('[data-geometry-element="opening:title"]');
    await page.$eval('[data-geometry-element="opening:title"]', (node) => {
      const el = node as HTMLButtonElement;
      const rect = el.getBoundingClientRect();
      const fire = (type: string, x: number, y: number) => {
        el.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true, pointerId: 1,
          pointerType: "mouse", isPrimary: true, clientX: x, clientY: y,
          buttons: type === "pointerup" ? 0 : 1,
        }));
      };
      fire("pointerdown", rect.left + 4, rect.top + 4);
      fire("pointerup", rect.left + 4, rect.top + 4);
    });
    await page.waitForSelector('[data-resize-handle="se"]');
    const before = await page.$eval('[data-geometry-element="opening:title"]', (node) => ({
      width: (node as HTMLElement).style.width,
      height: (node as HTMLElement).style.height,
    }));
    await page.$eval('[data-resize-handle="se"]', (node) => {
      const handle = node as HTMLElement;
      const rect = handle.getBoundingClientRect();
      const fire = (type: string, x: number, y: number) => {
        handle.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true, pointerId: 1,
          pointerType: "mouse", isPrimary: true, clientX: x, clientY: y,
          buttons: type === "pointerup" ? 0 : 1,
        }));
      };
      fire("pointerdown", rect.left + 2, rect.top + 2);
      fire("pointermove", rect.left + 60, rect.top + 40);
      fire("pointerup", rect.left + 60, rect.top + 40);
    });
    const after = await page.$eval('[data-geometry-element="opening:title"]', (node) => ({
      width: (node as HTMLElement).style.width,
      height: (node as HTMLElement).style.height,
    }));
    expect(after).not.toEqual(before);
    const box = await page.evaluate(() => {
      const workspaceWindow: SlidePlanWorkspaceWindow = window;
      return workspaceWindow.__slidePlanWorkspace?.currentPlan()?.slides[0]?.boxOverrides?.[0]?.box ?? null;
    });
    expect(box?.width).toBeGreaterThan(500);
    expect(box?.height).toBeGreaterThan(180);
  });

  test("Given a selected title, When ArrowRight is pressed, Then the override nudges the box", async () => {
    await selectMeeting();
    harness.pushMessage(meeting({
      plan: plan(),
      path: "ignored",
      publicationSha256: SHA,
      publishedAt: 1,
      geometry: [{
        id: "opening:geometry",
        slideId: "opening",
        layout: "hero",
        canvas: { width: 1280, height: 720 },
        variant: "cover",
        elements: [{
          id: "opening:title",
          role: "title",
          text: "Launch review",
          box: { x: 80, y: 72, width: 500, height: 180 },
          tokens: {},
          resolvedTokens: { color: "14213D", size: 42 },
          accessibility: { role: "title", label: "Launch review", readingOrder: 0 },
          evidence: { fieldPath: "title", claimIds: ["claim-launch"] },
          lines: ["Launch review"],
          fitTrace: {
            policy: "wrap", requestedFontSize: 42, finalFontSize: 42, fontFloor: 28,
            outcome: "fit", lines: ["Launch review"], attempts: [],
          },
        }],
      }],
    }));
    await page.waitForSelector('[data-geometry-element="opening:title"]');
    await page.$eval('[data-geometry-element="opening:title"]', (node) => {
      const el = node as HTMLButtonElement;
      el.focus();
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, composed: true, pointerId: 1,
        pointerType: "mouse", isPrimary: true, clientX: rect.left + 4, clientY: rect.top + 4, buttons: 1,
      }));
      el.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, composed: true, pointerId: 1,
        pointerType: "mouse", isPrimary: true, clientX: rect.left + 4, clientY: rect.top + 4, buttons: 0,
      }));
    });
    await page.keyboard.press("ArrowRight");
    const box = await page.evaluate(() => {
      const workspaceWindow: SlidePlanWorkspaceWindow = window;
      return workspaceWindow.__slidePlanWorkspace?.currentPlan()?.slides[0]?.boxOverrides?.[0]?.box ?? null;
    });
    expect(box?.x).toBeGreaterThan(80);
  });

  test("Given two compiled boxes, When they are shift-selected and dragged, Then one revision moves both", async () => {
    await selectMeeting();
    harness.pushMessage(meeting(openingGeometry([
      geometryElement("opening:title", "Launch review", "title", { x: 80, y: 72, width: 500, height: 180 }),
      geometryElement("opening:statement", "Friday launch.", "statement", { x: 80, y: 280, width: 640, height: 120 }),
    ])));
    await page.waitForSelector('[data-geometry-element="opening:title"]');
    await page.waitForSelector('[data-geometry-element="opening:statement"]');
    await page.$eval('[data-geometry-element="opening:title"]', (node) => {
      const el = node as HTMLButtonElement;
      const rect = el.getBoundingClientRect();
      const fire = (type: string, x: number, y: number, extra: PointerEventInit = {}) => {
        el.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true, pointerId: 1,
          pointerType: "mouse", isPrimary: true, clientX: x, clientY: y,
          buttons: type === "pointerup" ? 0 : 1, ...extra,
        }));
      };
      fire("pointerdown", rect.left + 4, rect.top + 4);
      fire("pointerup", rect.left + 4, rect.top + 4);
    });
    await page.$eval('[data-geometry-element="opening:statement"]', (node) => {
      const el = node as HTMLButtonElement;
      const rect = el.getBoundingClientRect();
      const fire = (type: string, x: number, y: number, extra: PointerEventInit = {}) => {
        el.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true, pointerId: 1,
          pointerType: "mouse", isPrimary: true, clientX: x, clientY: y,
          buttons: type === "pointerup" ? 0 : 1, shiftKey: true, ...extra,
        }));
      };
      fire("pointerdown", rect.left + 4, rect.top + 4, { shiftKey: true });
      fire("pointerup", rect.left + 4, rect.top + 4, { shiftKey: true });
    });
    expect(await page.$$eval("[data-geometry-element][aria-selected='true']", (nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.geometryElement),
    )).toEqual(["opening:title", "opening:statement"]);
    await page.$eval('[data-geometry-element="opening:title"]', (node) => {
      const el = node as HTMLButtonElement;
      const rect = el.getBoundingClientRect();
      const fire = (type: string, x: number, y: number) => {
        el.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true, pointerId: 1,
          pointerType: "mouse", isPrimary: true, clientX: x, clientY: y,
          buttons: type === "pointerup" ? 0 : 1,
        }));
      };
      fire("pointerdown", rect.left + 4, rect.top + 4);
      fire("pointermove", rect.left + 80, rect.top + 40);
      fire("pointerup", rect.left + 80, rect.top + 40);
    });
    const overrides = await page.evaluate(() => {
      const workspaceWindow: SlidePlanWorkspaceWindow = window;
      return workspaceWindow.__slidePlanWorkspace?.currentPlan()?.slides[0]?.boxOverrides ?? null;
    });
    expect(overrides).toHaveLength(2);
    expect(overrides?.map((entry) => entry.elementId).sort()).toEqual(["opening:statement", "opening:title"]);
    expect(overrides?.every((entry) => entry.box.x > 80)).toBe(true);
    const delta = (overrides?.find((entry) => entry.elementId === "opening:title")?.box.x ?? 0)
      - (overrides?.find((entry) => entry.elementId === "opening:statement")?.box.x ?? 1);
    expect(delta).toBe(0);
    await page.$eval("[data-deck-undo]", (node) => (node as HTMLButtonElement).click());
    const undone = await page.evaluate(() => {
      const workspaceWindow: SlidePlanWorkspaceWindow = window;
      return workspaceWindow.__slidePlanWorkspace?.currentPlan()?.slides[0]?.boxOverrides ?? null;
    });
    expect(undone == null || (Array.isArray(undone) && undone.length === 0)).toBe(true);
  });

  test("Given a selected title, When refine returns a proposal, Then apply stores it through setText", async () => {
    await selectMeeting();
    harness.pushMessage(meeting({
      plan: plan(),
      path: "ignored",
      publicationSha256: SHA,
      publishedAt: 1,
      geometry: [{
        id: "opening:geometry",
        slideId: "opening",
        layout: "hero",
        canvas: { width: 1280, height: 720 },
        variant: "cover",
        elements: [{
          id: "opening:title",
          role: "title",
          text: "Launch review",
          box: { x: 80, y: 72, width: 500, height: 180 },
          tokens: {},
          resolvedTokens: { color: "14213D", size: 42 },
          accessibility: { role: "title", label: "Launch review", readingOrder: 0 },
          evidence: { fieldPath: "title", claimIds: ["claim-launch"] },
          lines: ["Launch review"],
          fitTrace: {
            policy: "wrap", requestedFontSize: 42, finalFontSize: 42, fontFloor: 28,
            outcome: "fit", lines: ["Launch review"], attempts: [],
          },
        }],
      }],
    }));
    await page.waitForSelector('[data-geometry-element="opening:title"]');
    await page.$eval('[data-geometry-element="opening:title"]', (node) => {
      const el = node as HTMLButtonElement;
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, composed: true, pointerId: 1,
        pointerType: "mouse", isPrimary: true, clientX: rect.left + 4, clientY: rect.top + 4, buttons: 1,
      }));
      el.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, composed: true, pointerId: 1,
        pointerType: "mouse", isPrimary: true, clientX: rect.left + 4, clientY: rect.top + 4, buttons: 0,
      }));
    });
    await page.waitForFunction(() => {
      const input = document.querySelector("[data-slide-refine-input]") as HTMLInputElement | null;
      return input !== null && input.disabled === false;
    });
    await page.type("[data-slide-refine-input]", "더 짧게");
    const refine = harness.nextClientMessage();
    await page.click("[data-slide-refine-submit]");
    const sent = await refine;
    if (!isRecord(sent) || typeof sent.requestId !== "string") {
      throw new TypeError("refine message must contain a requestId");
    }
    expect(sent).toMatchObject({
      action: "refineSlideField", meetingId: 7, slideId: "opening", path: "title",
      text: "Launch review", instruction: "더 짧게", claimIds: ["claim-launch"],
    });
    harness.pushMessage({
      type: "refine", requestId: sent.requestId, slideId: "opening", path: "title",
      before: "Launch review", after: "Launch Friday", claimIds: ["claim-launch"],
    });
    await page.waitForSelector("[data-slide-refine-proposal]:not([hidden])");
    await page.click("[data-slide-refine-apply]");
    const title = await page.evaluate(() => {
      const workspaceWindow: SlidePlanWorkspaceWindow = window;
      return workspaceWindow.__slidePlanWorkspace?.currentPlan()?.slides[0]?.title ?? null;
    });
    expect(title).toBe("Launch Friday");
  });

  test("falls back for meetings without a SlidePlan and compiles then reselects the current meeting", async () => {
    harness.pushMessage(meeting(null));
    await page.waitForFunction(() => (document.querySelector("[data-slide-plan-workspace]") as HTMLElement)?.hidden === true);
    expect(await page.$eval("#current-slide", (node) => (node as HTMLElement).hidden)).toBe(false);

    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    const compile = harness.nextClientMessage();
    await page.click("#btn-compile-deck");
    expect(await compile).toEqual({ action: "compileSlidePlan", meetingId: 7 });

    const reselect = harness.nextClientMessage();
    harness.pushMessage({ type: "compile", status: "success", meetingId: 7, outline: { slideCount: 2, usedFallback: false } });
    expect(await reselect).toEqual({ action: "selectMeeting", meetingId: 7 });
  });
});
