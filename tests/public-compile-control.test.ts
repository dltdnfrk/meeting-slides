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
  test("요청을 보내고 started/success/error 상태를 사용자에게 표시한다", async () => {
    const action = harness.nextClientMessage();
    await page.click("#btn-compile-deck");
    expect(await action).toEqual({ action: "compileDeck" });
    expect(await page.$eval("#btn-compile-deck", (button) => (button as HTMLButtonElement).disabled)).toBe(true);

    harness.pushMessage({ type: "compile", status: "started", meetingId: 1 });
    await page.waitForFunction(() => document.getElementById("compile-status")?.textContent === "컴파일 중…");
    harness.pushMessage({
      type: "compile",
      status: "success",
      meetingId: 1,
      path: "exports/deck-ok/slides",
      outline: { title: "출시 덱", style: "clear-editorial", slideCount: 6, usedFallback: false, plannerError: null },
    });
    await page.waitForFunction(() => document.getElementById("compile-status")?.textContent === "컴파일 완료 · 6장");
    expect(await page.$eval("#btn-compile-deck", (button) => (button as HTMLButtonElement).disabled)).toBe(false);

    harness.pushMessage({ type: "compile", status: "error", meetingId: 1, error: "planner unavailable" });
    await page.waitForFunction(() => document.getElementById("compile-status")?.textContent?.includes("planner unavailable"));
    const state = await page.$eval("#compile-status", (status) => ({
      text: status.textContent,
      state: (status as HTMLElement).dataset.state,
      role: status.getAttribute("role"),
    }));
    expect(state).toEqual({ text: "컴파일 실패: planner unavailable", state: "error", role: "status" });

    harness.pushMessage({
      type: "export",
      status: "error",
      action: "exportPdf",
      code: "compile-busy",
      error: "Deck compile is in progress; export was not started",
    });
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "컴파일 중에는 내보낼 수 없습니다");
  });
});
