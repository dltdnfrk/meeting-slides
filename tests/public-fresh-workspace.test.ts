import { afterAll, beforeAll, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  const firstMessage = harness.nextClientMessage();
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
  await firstMessage;
}, 20_000);

afterAll(async () => {
  await browser?.close();
  harness.stop();
});

test("비캡처 재접속은 이전 라이브 화면 대신 빈 작업면을 유지한다", async () => {
  harness.pushMessage({ type: "capture", capturing: false, mode: "mic" });
  harness.pushMessage({
    type: "slide",
    current: { index: 1, title: "이전 회의", bullets: ["지난 내용"], startedAt: 1, sentenceCount: 1 },
    history: [],
  });
  harness.pushMessage({
    type: "transcript",
    reason: "snapshot",
    entries: [{ text: "이전 전사", ts: 1 }],
    truncated: false,
  });
  harness.pushMessage({ type: "saved", path: "/tmp/previous/presentation.pptx" });

  await page.evaluate(() => {
    const root = document.getElementById("session-rail")!;
    (globalThis as unknown as { __freshSync: Promise<void> }).__freshSync = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error("fresh workspace sync timeout"));
      }, 5_000);
      const observer = new MutationObserver(() => {
        if (document.querySelectorAll(".session-row").length !== 1) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      });
      observer.observe(root, { childList: true, subtree: true });
    });
  });
  harness.pushMessage({
    type: "meetings",
    items: [{ id: 1, title: "이전 회의", started_at: 1, status: "ended" }],
  });
  await page.evaluate(() =>
    (globalThis as unknown as { __freshSync: Promise<void> }).__freshSync,
  );

  const state = await page.evaluate(() => ({
    hasPlaceholder: document.querySelector(".slide__placeholder") !== null,
    transcriptCount: document.getElementById("transcript-count")?.textContent,
    selectedMeetings: document.querySelectorAll(".session-row--selected").length,
    lastSavedHidden: document.getElementById("last-saved")?.hidden,
  }));
  expect(state).toEqual({
    hasPlaceholder: true,
    transcriptCount: "0",
    selectedMeetings: 0,
    lastSavedHidden: true,
  });
});

test("WebSocket 종료는 로컬 앱 서버 연결 상태로 노출된다", async () => {
  await page.evaluate(() => {
    (globalThis as unknown as { __disconnected: Promise<void> }).__disconnected =
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error("disconnect state timeout"));
        }, 5_000);
        const observer = new MutationObserver(() => {
          if (document.documentElement.dataset.connection !== "disconnected") return;
          clearTimeout(timer);
          observer.disconnect();
          resolve();
        });
        observer.observe(document.documentElement, { attributes: true });
      });
  });
  harness.disconnectClients();
  await page.evaluate(() =>
    (globalThis as unknown as { __disconnected: Promise<void> }).__disconnected,
  );
  expect(await page.evaluate(() => document.documentElement.dataset.connection)).toBe("disconnected");
});
