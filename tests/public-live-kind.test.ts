// 라이브 무대 kind 분기가 실시간으로 보여야 한다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function pushSlide(page: Page, slide: Record<string, unknown>) {
  await page.evaluate((title) => {
    const root = document.getElementById("current-slide")!;
    (globalThis as unknown as { __slideReady: Promise<void> }).__slideReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`slide timeout ${title}`)), 5_000);
      const observer = new MutationObserver(() => {
        if (root.querySelector(".slide__title")?.textContent === title) {
          clearTimeout(timer);
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(root, { childList: true, subtree: true });
      if (root.querySelector(".slide__title")?.textContent === title) {
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      }
    });
  }, String(slide.title));
  harness.pushMessage({
    type: "slide",
    current: {
      index: 1,
      startedAt: Date.now(),
      sentenceCount: 2,
      ...slide,
    },
    history: [],
  });
  await page.evaluate(() => (globalThis as unknown as { __slideReady: Promise<void> }).__slideReady);
}

beforeAll(async () => {
  browser = await puppeteer.launch({ executablePath: chrome, args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
}, 20_000);

afterAll(async () => {
  await browser?.close();
  harness.stop();
});

describe("live multi-kind design", () => {
  test("기본 주제 카드는 topic 레이아웃(비주얼 밴드)으로 렌더된다", async () => {
    await pushSlide(page, {
      title: "베타 배포 일정",
      kicker: "일정",
      bullets: ["금요일 베타 배포", "QA 수요일 마감", "릴리스 노트 민수"],
    });
    const kind = await page.evaluate(() =>
      document.querySelector(".slide__inner")?.getAttribute("data-live-kind")
    );
    expect(kind).toBe("topic");
    expect(await page.$(".slide__topic-visual")).not.toBeNull();
  });

  test("결정 emphasis는 decision 레이아웃으로 전환된다", async () => {
    await pushSlide(page, {
      title: "출시 게이트",
      kicker: "결정",
      bullets: ["금요일 배포로 확정", "롤백 플랜 공유"],
      emphasis: "결정: 금요일 배포",
    });
    const kind = await page.evaluate(() =>
      document.querySelector(".slide__inner")?.getAttribute("data-live-kind")
    );
    expect(kind).toBe("decision");
    expect(await page.$(".slide__inner--decision")).not.toBeNull();
  });

  test("액션 불릿 다수는 actions 레이아웃으로 전환된다", async () => {
    await pushSlide(page, {
      title: "후속 액션",
      kicker: "액션",
      bullets: ["민수 담당 릴리스 노트", "수요일까지 QA 완료", "목요일 공유 미팅"],
    });
    const kind = await page.evaluate(() =>
      document.querySelector(".slide__inner")?.getAttribute("data-live-kind")
    );
    expect(kind).toBe("actions");
    expect(await page.$(".slide__actions")).not.toBeNull();
  });
});
