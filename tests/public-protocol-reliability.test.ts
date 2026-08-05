import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;

async function waitForClientAction(action: string): Promise<Record<string, unknown>> {
  const message = await harness.nextClientMessage() as Record<string, unknown>;
  if (message.action !== action) throw new Error(`expected ${action}, received ${String(message.action)}`);
  return message;
}

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  const initial = harness.nextClientMessage();
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
  await initial;
}, 20_000);

afterAll(async () => {
  await browser?.close();
  harness.stop();
});

describe("public meeting/export protocol reliability", () => {
  test("transcript uses its dedicated action and selected meeting target", async () => {
    harness.pushMessage({
      type: "meetings",
      items: [{ id: 7, title: "과거 회의", started_at: 1_700_000_000_000, status: "ended" }],
    });
    await page.waitForSelector('.session-row[data-meeting-id="7"]');
    const select = waitForClientAction("selectMeeting");
    await page.$eval('.session-row[data-meeting-id="7"]', (button) => (button as HTMLButtonElement).click());
    expect(await select).toEqual({ action: "selectMeeting", meetingId: 7 });

    const transcript = waitForClientAction("saveTranscript");
    await page.click("#btn-export-transcript");
    expect(await transcript).toEqual({ action: "saveTranscript", meetingId: 7 });

    const notes = waitForClientAction("saveNotes");
    await page.click("#btn-export-md");
    expect(await notes).toEqual({ action: "saveNotes", meetingId: 7 });
  });

  test("historical payload hydrates transcript, current/history slides and compiled selection", async () => {
    harness.pushMessage({
      type: "meeting",
      meetingId: 7,
      title: "과거 회의",
      transcript: [{ text: "과거 전사", ts: 1_700_000_000_000, speaker: 2 }],
      current: { index: 2, title: "현재 장", bullets: ["현재 요점"], startedAt: 2, sentenceCount: 1 },
      history: [{ index: 1, title: "이전 장", bullets: ["이전 요점"], startedAt: 1, sentenceCount: 1 }],
      compiled: { compiledAt: 1234, publishedAt: 1235, slideCount: 6, title: "컴파일 덱" },
    });
    await page.waitForFunction(() =>
      document.querySelectorAll("#thumbnails .thumbnail").length === 2
      && document.querySelector("#current-slide")?.textContent?.includes("현재 장")
      && document.querySelector("#transcript-stream")?.textContent?.includes("과거 전사"),
    );
    const state = await page.evaluate(() => ({
      filmstrip: [...document.querySelectorAll("#thumbnails .thumbnail__title")].map((el) => el.textContent),
      total: document.getElementById("history-count")?.textContent,
      glance: document.getElementById("glance-slide")?.textContent,
      compile: document.getElementById("compile-status")?.textContent,
    }));
    expect(state).toEqual({
      filmstrip: ["이전 장", "현재 장"],
      total: "2장",
      glance: "02/02",
      compile: "만든 슬라이드 6장",
    });

    const compile = waitForClientAction("compileTranscriptSnapshot");
    await page.click("#btn-compile-deck");
    expect(await compile).toEqual({ action: "compileTranscriptSnapshot", meetingId: 7 });
  });

  test("typed progress disables conflicts and terminal error restores controls with retry", async () => {
    harness.pushMessage({ type: "export", status: "started", action: "exportPng", jobId: "png-job-1", meetingId: 7, stage: "validate" });
    await page.waitForFunction(() => ["btn-compile-deck", "btn-export-pdf", "btn-export-png"].every((id) =>
      (document.getElementById(id) as HTMLButtonElement).disabled,
    ));
    harness.pushMessage({
      type: "export", status: "progress", action: "exportPng", jobId: "png-job-1", meetingId: 7,
      stage: "render", completed: 1, total: 2,
    });
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent?.includes("1/2"));
    harness.pushMessage({
      type: "export", status: "timeout", action: "exportPng", jobId: "png-job-1", meetingId: 7,
      stage: "render", error: "PNG export timed out",
    });
    await page.waitForFunction(() => ["btn-compile-deck", "btn-export-pdf", "btn-export-png"].every((id) =>
      !(document.getElementById(id) as HTMLButtonElement).disabled,
    ));
    await page.waitForSelector('.job-retry[data-action="exportPng"]');
    const retry = waitForClientAction("exportPng");
    await page.click('.job-retry[data-action="exportPng"]');
    expect(await retry).toEqual({ action: "exportPng", meetingId: 7 });
  });
});
