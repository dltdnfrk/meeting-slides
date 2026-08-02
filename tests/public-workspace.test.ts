// Tiro 스타일 3분할 워크스페이스 셸 레이아웃 검증 (todo 1).
// 스플리터(todo 2)/전사 배선(todo 3)은 범위 밖 — 여기서는 구조와 무대 보존만 본다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
});

afterAll(async () => {
  await browser?.close();
  harness.stop();
});

describe("워크스페이스 셸 구조", () => {
  test("워크스페이스가 좌/중앙/우 세 패널을 담는다", async () => {
    const panes = await page.evaluate(() => {
      const workspace = document.querySelector(".workspace");
      if (!workspace) return null;
      const owns = (selector: string) =>
        workspace.querySelector(selector)?.parentElement === workspace;
      return {
        rail: owns(".session-rail"),
        stage: owns(".stage-pane"),
        transcript: owns(".transcript-pane"),
        // 좌 → 중앙 → 우 순서가 DOM 순서로도 유지돼야 스플리터(todo 2)가 성립한다
        order: [...workspace.children].map((child) => child.className.split(" ")[0]),
      };
    });

    expect(panes).not.toBeNull();
    expect(panes!.rail).toBe(true);
    expect(panes!.stage).toBe(true);
    expect(panes!.transcript).toBe(true);
    expect(panes!.order).toEqual(["session-rail", "stage", "transcript-pane"]);
  });

  test("중앙 패널이 기존 시각 자료 무대를 그대로 품는다", async () => {
    const stage = await page.evaluate(() => {
      const pane = document.querySelector(".stage-pane");
      if (!pane) return null;
      const slideRoot = document.getElementById("current-slide");
      return {
        // 슬라이드 렌더 루트(#current-slide)가 중앙 패널 안에 살아 있어야 app.js가 그대로 동작한다
        slideRootInside: slideRoot !== null && pane.contains(slideRoot),
        frameInside: pane.querySelector("#slide-frame") !== null,
        islandInside: pane.querySelector("#island") !== null,
        placeholder: pane.querySelector(".slide__placeholder") !== null,
        // 대시보드가 아니라 실제 무대여야 한다
        dashboardCopy: (pane.textContent ?? "").includes("오늘 미팅을 한눈에"),
      };
    });

    expect(stage).not.toBeNull();
    expect(stage!.slideRootInside).toBe(true);
    expect(stage!.frameInside).toBe(true);
    expect(stage!.islandInside).toBe(true);
    expect(stage!.placeholder).toBe(true);
    expect(stage!.dashboardCopy).toBe(false);
  });

  test("세 패널이 가로로 나란히 놓이고 하단 도크가 보존된다", async () => {
    const layout = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector(selector);
        return el ? el.getBoundingClientRect() : null;
      };
      const rail = box(".session-rail")!;
      const stage = box(".stage-pane")!;
      const transcript = box(".transcript-pane")!;
      const dock = box(".dock")!;
      const workspace = box(".workspace")!;
      return {
        railLeftOfStage: rail.right <= stage.left + 1,
        stageLeftOfTranscript: stage.right <= transcript.left + 1,
        sameRow: Math.abs(rail.top - stage.top) <= 1 && Math.abs(stage.top - transcript.top) <= 1,
        // 히어로가 가장 넓은 슬롯이어야 Tiro 배치가 성립한다
        stageWidest: stage.width > rail.width && stage.width > transcript.width,
        railVisible: rail.width > 0,
        transcriptVisible: transcript.width > 0,
        dockBelowWorkspace: dock.top >= workspace.bottom - 1,
        dockHasCompileButton: document.querySelector(".dock #btn-compile-deck") !== null,
      };
    });

    expect(layout).toEqual({
      railLeftOfStage: true,
      stageLeftOfTranscript: true,
      sameRow: true,
      stageWidest: true,
      railVisible: true,
      transcriptVisible: true,
      dockBelowWorkspace: true,
      dockHasCompileButton: true,
    });
  });

  test("워크스페이스가 가로 오버플로 없이 뷰포트에 맞는다", async () => {
    const overflow = await page.evaluate(() => {
      const workspace = document.querySelector(".workspace")!;
      return {
        horizontal: workspace.scrollWidth - workspace.clientWidth,
        beyondViewport: workspace.getBoundingClientRect().right - window.innerWidth,
      };
    });
    expect(overflow.horizontal).toBeLessThanOrEqual(0);
    expect(overflow.beyondViewport).toBeLessThanOrEqual(1);
  });
});
