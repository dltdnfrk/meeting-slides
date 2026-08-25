import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;

const SHA = "a".repeat(64);
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
  const selected = harness.nextClientMessage();
  await page.click('.session-row[data-meeting-id="7"]');
  expect(await selected).toEqual({ action: "selectMeeting", meetingId: 7 });
}

function meeting(slidePlan: unknown = { plan: plan(), path: "ignored", publicationSha256: SHA, publishedAt: 1 }) {
  return { type: "meeting", meetingId: 7, title: "Launch review", transcript: [{ text: "Friday launch.", ts: 1_700_000_000_100 }], current: null, history: [], compiled: null, slidePlan };
}

describe("persisted SlidePlan browser workspace", () => {
  test("restores into the center stage with accessible controls, exports, keyboard, and reduced motion", async () => {
    await selectMeeting();
    harness.pushMessage(meeting());
    await page.waitForSelector('[data-slide-plan-workspace]:not([hidden])');

    expect(await page.evaluate(() => {
globalThis.paper = document.querySelector("[data-slide-plan-paper]") as HTMLElement;
globalThis.stage = document.querySelector(".slide-plan-workspace__stage") as HTMLElement;
globalThis.dock = document.querySelector(".dock") as HTMLElement;
globalThis.body = document.querySelector("[data-slide-plan-body]")?.textContent ?? "";
globalThis.paperBox = paper.getBoundingClientRect();
globalThis.stageBox = stage.getBoundingClientRect();
globalThis.dockBox = dock.getBoundingClientRect();
      return {
        legacyHidden: (document.getElementById("current-slide") as HTMLElement).hidden,
        title: document.querySelector("[data-slide-plan-title]")?.textContent,
        counter: document.querySelector("[data-slide-counter]")?.textContent,
        reduced: document.querySelector("[data-slide-plan-workspace]")?.getAttribute("data-reduced-motion"),
        hrefs: [...document.querySelectorAll("[data-slide-plan-export]")].map((node) => node.getAttribute("href")),
        body,
        paperFitsStage: paperBox.bottom <= stageBox.bottom + 1 && paperBox.top >= stageBox.top - 1,
        paperAboveDock: paperBox.bottom <= dockBox.top + 1,
      };
    })).toEqual({
      legacyHidden: true, title: "Launch review", counter: "1 / 2", reduced: "true",
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

    await page.evaluate(() => window.__slidePlanWorkspace?.setBusy(true));
    await page.click("[data-deck-previous]");
    expect(await page.$eval("#btn-export-pdf", (node) => (node as HTMLButtonElement).disabled)).toBe(true);
    expect(await page.$eval("#btn-export-png", (node) => (node as HTMLButtonElement).disabled)).toBe(true);
    await page.evaluate(() => window.__slidePlanWorkspace?.setBusy(false));
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
    expect(await page.$eval("[data-slide-plan-status]", (node) => node.textContent ?? "")).toContain("Local draft");

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
    expect(message.action).toBe("persistSlidePlan");
    expect(message.plan?.slides?.some((slide: { layout?: string }) => slide.layout === "timeline")).toBe(true);
    expect(await page.evaluate(() => (window as typeof window & { plan?: unknown }).plan)).toEqual({ sentinel: true });
    expect(await page.$eval("[data-slide-title-input]", (node) => (node as HTMLInputElement).disabled)).toBe(true);
    expect(await page.$eval("[data-slide-layout]", (node) => (node as HTMLSelectElement).disabled)).toBe(true);
    harness.pushMessage({ type: "compile", status: "error", meetingId: 7, error: "persist test complete" });
    await page.waitForFunction(() => !(document.getElementById("btn-compile-deck") as HTMLButtonElement).disabled);
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
