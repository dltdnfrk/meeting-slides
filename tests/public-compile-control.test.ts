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

  test("녹음 중 전사가 비어 있으면 녹음이 아니라 대화 내용이 필요하다고 안내한다", async () => {
    harness.pushMessage({ type: "capture", capturing: true, mode: "mic", phase: "capturing" });
    await page.waitForFunction(() =>
      (document.getElementById("btn-record") as HTMLButtonElement)?.textContent?.includes("녹음 중지"),
    );
    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    await page.click("#btn-compile-deck");
    expect(await page.$eval("#status-text", (node) => node.textContent?.trim()))
      .toBe("슬라이드를 만들 대화 내용이 아직 없습니다");
    harness.pushMessage({ type: "capture", capturing: false, mode: "mic", phase: "idle" });
    await page.waitForFunction(() =>
      !(document.querySelector(".app") as HTMLElement)?.classList.contains("app--capturing"),
    );
  });

  test("요청을 보내고 진행·완료·실패 상태와 생성 결과를 사용자에게 표시한다", async () => {
    harness.pushMessage({ type: "line", seq: 1, ts: Date.now(), text: "금요일에 출시하기로 결정했습니다", speaker: 1 });
    await page.waitForFunction(() => document.getElementById("transcript-count")?.textContent === "1");
    const action = harness.nextClientMessage();
    // Todo 13 homes compile inside the one contextual disclosure (DESIGN 9.11
    // puts compile behind the More menu). Puppeteer's click requires a visible
    // target, so the test opens the disclosure first - exactly as a user does.
    // Every assertion below is unchanged.
    await page.click("#dock-more > summary");
    await page.click("#btn-compile-deck");
    expect(await action).toEqual({ action: "compileSlidePlan" });
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

  test("저장된 scene 슬라이드는 재연결 후 회의 선택에서 복원되고 탐색된다", async () => {
    harness.pushMessage({
      type: "meetings",
      items: [{ id: 7, title: "복원 회의", started_at: 1_700_000_000_000, status: "ended" }],
    });
    await page.waitForSelector('.session-row[data-meeting-id="7"]');
    const selection = harness.nextClientMessage();
    await page.click('.session-row[data-meeting-id="7"]');
    expect(await selection).toEqual({ action: "selectMeeting", meetingId: 7 });

    harness.pushMessage({
      type: "meeting",
      meetingId: 7,
      title: "복원 회의",
      transcript: [{ text: "금요일에 출시합니다", ts: 1_700_000_000_100 }],
      current: null,
      history: [],
      compiled: null,
      scene: {
        meetingId: 7,
        title: "복원 덱",
        width: 100,
        height: 56.25,
        slides: [
          { id: "slide-1", intent: "cover", background: "F6F1E8", elements: [
            { type: "text", role: "title", text: "복원 덱", x: 6, y: 20, w: 80, h: 12, fontSize: 38, color: "14213D" },
          ] },
          { id: "slide-2", intent: "decision", background: "F6F1E8", elements: [
            { type: "text", role: "title", text: "복원된 결정", x: 6, y: 11, w: 84, h: 10, fontSize: 28, color: "14213D" },
            { type: "text", role: "statement", text: "금요일에 출시합니다", x: 10, y: 29, w: 80, h: 10, fontSize: 25, color: "14213D" },
          ] },
        ],
      },
    });

    await page.waitForFunction(() =>
      document.getElementById("history-count")?.textContent === "2장"
      && document.getElementById("current-slide")?.textContent?.includes("복원 덱"),
    );
    expect(await page.$eval("#current-slide", (element) => element.textContent)).toContain("복원 덱");
    expect(await page.$eval("#dock-history", (element) => getComputedStyle(element).display)).toBe("flex");
    await page.click('.thumbnail[data-index="2"]');
    await page.waitForFunction(() => document.getElementById("current-slide")?.textContent?.includes("복원된 결정"));
    expect(await page.$eval('.thumbnail[data-index="2"]', (element) => ({
      selected: element.classList.contains("thumbnail--viewing"),
      current: element.getAttribute("aria-current"),
    }))).toEqual({ selected: true, current: "true" });
    expect(await page.$eval("#transcript-count", (element) => element.textContent)).toBe("1");
  });

});
