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

/**
 * Todo 13 homes the save/export/compile set behind the one contextual
 * `<details>` (DESIGN 9.11). Opening it is idempotent, so a test may call this
 * before any dock interaction without caring about the current state.
 */
async function openDock(target: Page): Promise<void> {
  await target.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
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
    expect(await page.$eval("#document-surface", (node) => ({
      busy: node.getAttribute("aria-busy"), loading: (node as HTMLElement).dataset.loading,
    }))).toEqual({ busy: "true", loading: "true" });

        // Todo 13 homes the save/export/compile set inside the one contextual
    // disclosure (DESIGN 9.11). Puppeteer requires a visible target, so the
    // disclosure is opened first, as a user does. Assertions are unchanged.
    await openDock(page);
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
      surfaceBusy: document.getElementById("document-surface")?.getAttribute("aria-busy"),
      surfaceLoading: document.getElementById("document-surface")?.dataset.loading,
      filmstrip: [...document.querySelectorAll("#thumbnails .thumbnail__title")].map((el) => el.textContent),
      total: document.getElementById("history-count")?.textContent,
      glance: document.getElementById("glance-slide")?.textContent,
      compile: document.getElementById("compile-status")?.textContent,
    }));
    expect(state).toEqual({
      surfaceBusy: null,
      surfaceLoading: "false",
      filmstrip: ["이전 장", "현재 장"],
      total: "2장",
      glance: "02/02",
      compile: "만든 슬라이드 6장",
    });

        // Todo 13 homes the save/export/compile set inside the one contextual
    // disclosure (DESIGN 9.11). Puppeteer requires a visible target, so the
    // disclosure is opened first, as a user does. Assertions are unchanged.
    await openDock(page);
    const compile = waitForClientAction("compileSlidePlan");
    await page.click("#btn-compile-deck");
    expect(await compile).toEqual({ action: "compileSlidePlan", meetingId: 7 });
  });

  test("PDF 도구 실패를 사용자 언어로 정리하고 다른 저장 성공 시 고아 재시도를 제거한다", async () => {
    harness.pushMessage({
      type: "export", status: "error", action: "exportPdf", jobId: "pdf-job-internal", meetingId: 7,
      stage: "validate", code: "process-failed",
      error: "validate failed: (node:60217) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set. Use node --trace-warnings",
    });
    await page.waitForSelector('.job-retry[data-action="exportPdf"]');
    expect(await page.$eval("#status-text", (node) => ({
      text: node.textContent?.trim(),
      title: node.getAttribute("title"),
    }))).toEqual({
      text: "PDF 저장 실패: 파일 생성 도구를 실행하지 못했습니다. 다시 시도해 주세요",
      title: "PDF 저장 실패: 파일 생성 도구를 실행하지 못했습니다. 다시 시도해 주세요",
    });
    expect(await page.$eval("#status-text", (node) => /NO_COLOR|FORCE_COLOR|node:60217|trace-warnings/.test(node.getAttribute("title") ?? ""))).toBe(false);

    harness.pushMessage({ type: "saved", path: "exports/meeting-safe.md" });
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "회의 메모 저장 완료");
    expect(await page.$(".job-retry")).toBeNull();
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

  test("pending Ask keeps one requestId and reattaches exactly once after reconnect", async () => {
    await page.$eval("#btn-ask", (button) => (button as HTMLButtonElement).click());
    await page.type("#ask-input", "배포일은 언제인가요?");
    const firstPending = harness.nextClientMessage();
    await page.click("#btn-ask-send");
    const first = await firstPending as { action?: string; meetingId?: number; question?: string; requestId?: string };
    expect(first).toMatchObject({ action: "ask", meetingId: 7, question: "배포일은 언제인가요?" });
    expect(first.requestId).toMatch(/^ask-|^[0-9a-f-]{36}$/);

    harness.disconnectClients();
    await harness.waitForClient();
    let replay: Record<string, unknown> | null = null;
    for (let i = 0; i < 8; i++) {
      const command = await harness.nextClientMessage() as Record<string, unknown>;
      if (command.action === "ask") { replay = command; break; }
    }
    expect(replay).toEqual(first);
    expect(await page.$$eval("#ask-conversation .ask-message--user", (nodes) => nodes.length)).toBe(1);
    harness.pushMessage({ type: "ask", requestId: first.requestId, answer: "다음 주 수요일입니다.", matchedCount: 1 });
    await page.waitForFunction(() => document.querySelector("#ask-conversation")?.textContent?.includes("다음 주 수요일입니다."));
  }, 20_000);

});
