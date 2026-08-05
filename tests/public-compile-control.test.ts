import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
});

afterAll(async () => {
  await browser?.close();
  harness.stop();
});

describe("컴파일 컨트롤", () => {
  test("PowerPoint 생성은 하나의 명확한 주 버튼으로 제공한다", async () => {
    expect(await page.$("#btn-export-pptx")).toBeNull();
    expect(await page.$eval("#btn-compile-deck", (button) => button.textContent?.trim())).toBe("슬라이드 초안 만들기");
  });

  test("요청을 보내고 진행·완료·실패 상태와 생성 결과를 사용자에게 표시한다", async () => {
    harness.pushMessage({ type: "line", seq: 1, ts: Date.now(), text: "금요일에 출시하기로 결정했습니다", speaker: 1 });
    await page.waitForFunction(() => document.getElementById("transcript-count")?.textContent === "1");
    const action = harness.nextClientMessage();
    await page.click("#btn-compile-deck");
    expect(await action).toEqual({ action: "compileTranscriptSnapshot" });
    expect(await page.$eval("#btn-compile-deck", (button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(await page.$eval("#btn-record", (button) => (button as HTMLButtonElement).disabled)).toBe(false);

    harness.pushMessage({ type: "compile", status: "started", meetingId: 1 });
    await page.waitForFunction(() => document.getElementById("compile-status")?.textContent === "슬라이드 초안을 만드는 중…");
    harness.pushMessage({
      type: "compile",
      status: "success",
      meetingId: 1,
      path: "exports/deck-ok/slides",
      outline: { title: "출시 덱", style: "scene-graph", slideCount: 2, usedFallback: false, plannerError: null },
      scene: {
        meetingId: 1,
        title: "출시 덱",
        width: 100,
        height: 56.25,
        slides: [
          { id: "slide-1", intent: "cover", background: "F6F1E8", elements: [
            { type: "text", role: "title", text: "출시 덱", x: 6, y: 20, w: 80, h: 12, fontSize: 38, color: "14213D" },
          ] },
          { id: "slide-2", intent: "decision", background: "F6F1E8", elements: [
            { type: "text", role: "title", text: "출시일 확정", x: 6, y: 11, w: 84, h: 10, fontSize: 28, color: "14213D" },
            { type: "text", role: "statement", text: "금요일에 출시합니다", x: 10, y: 29, w: 80, h: 10, fontSize: 25, color: "14213D" },
          ] },
        ],
      },
    });
    await page.waitForFunction(() => document.getElementById("compile-status")?.textContent === "슬라이드 2장 완성");
    expect(await page.$eval("#history-count", (element) => element.textContent)).toBe("2장");
    expect(await page.$eval("#current-slide", (element) => element.textContent)).toContain("출시 덱");
    expect(await page.$eval("#btn-compile-deck", (button) => (button as HTMLButtonElement).disabled)).toBe(false);

    harness.pushMessage({ type: "compile", status: "error", meetingId: 1, error: "planner unavailable" });
    await page.waitForFunction(() => document.getElementById("compile-status")?.textContent?.includes("planner unavailable"));
    const state = await page.$eval("#compile-status", (status) => ({
      text: status.textContent,
      state: (status as HTMLElement).dataset.state,
      role: status.getAttribute("role"),
    }));
    expect(state).toEqual({ text: "슬라이드를 만들지 못했습니다: planner unavailable", state: "error", role: "status" });

    harness.pushMessage({
      type: "export",
      status: "error",
      action: "exportPdf",
      code: "compile-busy",
      error: "Deck compile is in progress; export was not started",
    });
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "슬라이드를 만드는 중에는 다른 파일을 저장할 수 없습니다");
  });
});
