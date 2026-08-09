import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
});

afterAll(async () => {
  await browser?.close();
  harness.stop();
});

describe("TIRO 기반 오퍼레이터 표면", () => {
  test("중앙 슬라이드 계약과 필수 DOM ID를 한 번씩만 보존한다", async () => {
    const contract = await page.evaluate(() => {
      const ids = ["current-slide", "stage-pane", "session-list", "transcript-stream"];
      const stage = document.getElementById("stage-pane");
      const slide = document.getElementById("current-slide");
      return {
        counts: ids.map((id) => document.querySelectorAll(`#${id}`).length),
        slideInsideStage: Boolean(stage && slide && stage.contains(slide)),
        slideRootsOutsideStage: [...document.querySelectorAll("#current-slide")]
          .filter((node) => !stage?.contains(node)).length,
      };
    });

    expect(contract).toEqual({
      counts: [1, 1, 1, 1],
      slideInsideStage: true,
      slideRootsOutsideStage: 0,
    });
  });

  test("플로팅 도크가 녹음·파형·타이머와 3-way 출력을 품는다", async () => {
    const dock = await page.evaluate(() => {
      const root = document.querySelector(".dock");
      return {
        recordInside: Boolean(root?.querySelector("#btn-record")),
        waveformBars: root?.querySelectorAll(".record-waveform__bar").length ?? 0,
        timerInside: Boolean(root?.querySelector("#capture-timer")),
        outputLabels: [...(root?.querySelectorAll(".output-switcher__item") ?? [])]
          .map((node) => node.querySelector(".output-switcher__label")?.textContent?.trim()
            ?? node.textContent?.trim()),
      };
    });

    expect(dock.recordInside).toBe(true);
    expect(dock.waveformBars).toBe(5);
    expect(dock.timerInside).toBe(true);
    expect(dock.outputLabels).toEqual(["슬라이드", "전체 전사", "회의 결과"]);
  });

  test("번역과 전사 편집은 서버 계약 사유를 노출한 채 비활성화된다", async () => {
    const state = await page.evaluate(() => {
      const translation = document.getElementById("translation-toggle");
      const speaker = document.getElementById("transcript-speaker-edit");
      const segment = document.getElementById("transcript-segment-edit");
      return {
        spokenLanguage: Boolean(document.getElementById("spoken-language")),
        writtenLanguage: Boolean(document.getElementById("written-language")),
        translation: translation instanceof HTMLButtonElement
          ? { disabled: translation.disabled, reason: translation.title }
          : null,
        speaker: speaker instanceof HTMLButtonElement
          ? { disabled: speaker.disabled, reason: speaker.title }
          : null,
        segment: segment instanceof HTMLButtonElement
          ? { disabled: segment.disabled, reason: segment.title }
          : null,
      };
    });

    expect(state).toEqual({
      spokenLanguage: true,
      writtenLanguage: true,
      translation: { disabled: true, reason: "번역 모델 연결이 필요합니다" },
      speaker: { disabled: true, reason: "서버 편집 계약이 필요합니다" },
      segment: { disabled: true, reason: "서버 편집 계약이 필요합니다" },
    });
  });

  test("capture 메시지가 녹음 버튼을 파형 상태로 전환한다", async () => {
    await page.evaluate(() => {
      const app = document.querySelector(".app");
      (globalThis as typeof globalThis & { __captureRendered: Promise<void> }).__captureRendered =
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error("capture state did not render"));
          }, 5_000);
          const observer = new MutationObserver(() => {
            if (!app?.classList.contains("app--capturing")) return;
            clearTimeout(timer);
            observer.disconnect();
            resolve();
          });
          if (app) observer.observe(app, { attributes: true, attributeFilter: ["class"] });
        });
    });
    harness.pushMessage({ type: "capture", capturing: true, mode: "mic" });
    await page.evaluate(() =>
      (globalThis as typeof globalThis & { __captureRendered: Promise<void> }).__captureRendered,
    );

    const active = await page.evaluate(() => {
      const waveform = document.querySelector(".record-waveform");
      const button = document.getElementById("btn-record");
      return {
        appCapturing: document.querySelector(".app")?.classList.contains("app--capturing"),
        waveformVisible: waveform instanceof HTMLElement
          && getComputedStyle(waveform).display !== "none",
        label: button?.textContent?.replace(/\s+/g, " ").trim(),
        pressed: button?.getAttribute("aria-pressed"),
      };
    });

    expect(active.appCapturing).toBe(true);
    expect(active.waveformVisible).toBe(true);
    expect(active.label).toContain("녹음 중지");
    expect(active.pressed).toBe("true");
  });

  test("3-way 출력에서 전체 전사를 선택하면 패널로 이동하고 현재 상태를 갱신한다", async () => {
    await page.setViewport({ width: 768, height: 800 });
    await page.click('.output-switcher__item[data-output-target="transcript-pane"]');

    const selection = await page.evaluate(() => ({
      current: document.querySelector('.output-switcher__item[aria-current="page"]')
        ?.getAttribute("data-output-target"),
      focused: document.activeElement?.id,
    }));

    expect(selection).toEqual({ current: "transcript-pane", focused: "transcript-pane" });
  });

  test("1280·768·375에서 셸이 가로로 넘치지 않는다", async () => {
    const results: Array<{
      readonly width: number;
      readonly overflow: number;
      readonly slideFrameOverflow: number;
    }> = [];
    for (const width of [1280, 768, 375]) {
      await page.setViewport({ width, height: width === 375 ? 812 : 800 });
      const metrics = await page.evaluate(() => {
        const slide = document.getElementById("current-slide")?.getBoundingClientRect();
        const frame = document.getElementById("slide-frame")?.getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          slideFrameOverflow: Math.max(0, Math.round((slide?.bottom ?? 0) - (frame?.bottom ?? 0))),
        };
      });
      results.push({ width, ...metrics });
    }

    expect(results).toEqual([
      { width: 1280, overflow: 0, slideFrameOverflow: 0 },
      { width: 768, overflow: 0, slideFrameOverflow: 0 },
      { width: 375, overflow: 0, slideFrameOverflow: 0 },
    ]);
  });

  test("비활성 사유와 모바일 전사 본문이 잘리지 않는다", async () => {
    await page.setViewport({ width: 1280, height: 800 });
    const reasonClipping = await page.evaluate(() => {
      const reason = document.querySelector(".capability-reason")?.getBoundingClientRect();
      const pane = document.getElementById("transcript-pane")?.getBoundingClientRect();
      return Math.max(0, Math.round((reason?.right ?? 0) - (pane?.right ?? 0)));
    });

    await page.setViewport({ width: 375, height: 812 });
    const mobile = await page.evaluate(() => {
      const body = document.getElementById("transcript-body");
      const empty = document.getElementById("transcript-empty");
      const dock = document.querySelector(".dock")?.getBoundingClientRect();
      const lastDockChild = document.querySelector(".dock")?.lastElementChild?.getBoundingClientRect();
      const capabilityReason = document.querySelector(".capability-reason");
      const outputReason = document.querySelector(".output-switcher__reason");
      const bodyRect = body?.getBoundingClientRect();
      const emptyRect = empty?.getBoundingClientRect();
      return {
        transcriptPlaceholderClipping: Math.max(
          0,
          Math.round((bodyRect?.top ?? 0) - (emptyRect?.top ?? 0)),
          Math.round((emptyRect?.bottom ?? 0) - (bodyRect?.bottom ?? 0)),
        ),
        dockOverflow: Math.max(0, Math.round((lastDockChild?.bottom ?? 0) - (dock?.bottom ?? 0))),
        capabilityReasonVisible: capabilityReason instanceof HTMLElement
          && getComputedStyle(capabilityReason).display !== "none",
        outputReason: outputReason?.textContent?.trim() ?? "",
      };
    });

    expect(reasonClipping).toBe(0);
    expect(mobile.transcriptPlaceholderClipping).toBe(0);
    expect(mobile.dockOverflow).toBe(0);
    expect(mobile.capabilityReasonVisible).toBe(true);
    expect(mobile.outputReason).toBe("결과 없음");
  });
});
