// 확정 전사 문장이 여러 줄 보여야 한다 (work order P1).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--no-sandbox"],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
  await page.waitForSelector("#transcript-stream", { timeout: 5_000 });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  harness.stop();
});

describe("전사 피드 다줄 표시", () => {
  test("15개 line 이벤트가 모두 .transcript-stream에 남는다", async () => {
    // ensure empty first
    await page.evaluate(() => {
      const root = document.getElementById("transcript-stream");
      if (root) root.innerHTML = "";
      const empty = document.getElementById("transcript-empty");
      if (empty) empty.hidden = false;
    });

    for (let i = 0; i < 15; i++) {
      harness.pushMessage({
        type: "line",
        text: `확정 문장 ${i + 1}번 회의 내용입니다`,
        ts: 1_700_000_000_000 + i * 1000,
        speaker: (i % 2) + 1,
      });
    }

    await page.waitForFunction(
      () => document.querySelectorAll("#transcript-stream .feed-line").length >= 15,
      { timeout: 5_000 },
    );

    const state = await page.evaluate(() => {
      const lines = [...document.querySelectorAll("#transcript-stream .feed-line__text")].map((el) => el.textContent ?? "");
      const empty = document.getElementById("transcript-empty") as HTMLElement | null;
      return {
        count: lines.length,
        first: lines[0] ?? "",
        last: lines[lines.length - 1] ?? "",
        emptyHidden: empty?.hidden ?? true,
      };
    });

    expect(state.count).toBe(15);
    expect(state.first).toContain("1번");
    expect(state.last).toContain("15번");
    expect(state.emptyHidden).toBe(true);
  });

  test("status 텍스트가 매우 길어도 160자 내로 잘린다", async () => {
    const long = `whisper stderr: ${"device ".repeat(80)} metal init complete`;
    harness.pushMessage({ type: "status", text: long });
    await page.waitForFunction(
      () => {
        const t = document.getElementById("status-text")?.textContent ?? "";
        return t.includes("whisper stderr") && t.length <= 160;
      },
      { timeout: 5_000 },
    );
    const shown = await page.evaluate(() => document.getElementById("status-text")?.textContent ?? "");
    expect(shown.length).toBeLessThanOrEqual(160);
    expect(shown.startsWith("whisper stderr")).toBe(true);
  });
});
