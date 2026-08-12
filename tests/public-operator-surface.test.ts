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

/**
 * Drives the shell back to the library with a real authoritative `capture` frame
 * and waits for the class the client itself toggles. No faked DOM state.
 */
async function returnToLibrary(target: Page): Promise<void> {
  await target.evaluate(() => {
    const app = document.querySelector(".app")!;
    (globalThis as unknown as { __toLibrary: Promise<void> }).__toLibrary = new Promise<void>(
      (resolve, reject) => {
        if (!app.classList.contains("app--capturing")) { resolve(); return; }
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error("library did not restore")); }, 5_000);
        const observer = new MutationObserver(() => {
          if (app.classList.contains("app--capturing")) return;
          clearTimeout(timer); observer.disconnect(); resolve();
        });
        observer.observe(app, { attributes: true, attributeFilter: ["class"] });
      },
    );
  });
  harness.pushMessage({ type: "capture", capturing: false, mode: "mic", phase: "idle" });
  await target.evaluate(() => (globalThis as unknown as { __toLibrary: Promise<void> }).__toLibrary);
}

describe("Caret 오퍼레이터 표면", () => {
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

    await page.evaluate(() => {
      const app = document.querySelector(".app");
      (globalThis as typeof globalThis & { __captureStopped: Promise<void> }).__captureStopped =
        new Promise<void>((resolve, reject) => {
          let observer: MutationObserver;
          const timer = setTimeout(() => {
            observer?.disconnect();
            reject(new Error("capture stop did not render"));
          }, 5_000);
          observer = new MutationObserver(() => {
            if (app?.classList.contains("app--capturing")) return;
            clearTimeout(timer);
            observer.disconnect();
            resolve();
          });
          if (!app?.classList.contains("app--capturing")) {
            clearTimeout(timer);
            resolve();
            return;
          }
          observer.observe(app, { attributes: true, attributeFilter: ["class"] });
        });
    });
    harness.pushMessage({ type: "capture", capturing: false, mode: "mic" });
    await page.evaluate(() =>
      (globalThis as typeof globalThis & { __captureStopped: Promise<void> }).__captureStopped,
    );
  });

  test("3-way 출력에서 전체 전사를 선택하면 패널로 이동하고 현재 상태를 갱신한다", async () => {
    await page.setViewport({ width: 768, height: 800 });
    // MIGRATED (Todo 11): state is server-authoritative now (DESIGN §9.3), so the
    // shell must be returned to the library with a real capture frame. Removing
    // `.app--capturing` by hand left the reducer in the live shell and produced a
    // combination the product itself can never reach.
    await returnToLibrary(page);
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
    // The reason text belongs to the transcript CARD, which is the measure-bound
    // reading column inside the pane. Comparing it to the pane's outer edge was
    // only equivalent while the pane was a fixed-width dock; with the document
    // surface the pane is full width and the card carries the measure.
    const reasonClipping = await page.evaluate(() => {
      const reason = document.querySelector(".capability-reason")?.getBoundingClientRect();
      const card = document.getElementById("transcript-card")?.getBoundingClientRect();
      const pane = document.getElementById("transcript-pane")?.getBoundingClientRect();
      const bound = Math.max(card?.right ?? 0, pane?.right ?? 0);
      return Math.max(0, Math.round((reason?.right ?? 0) - bound));
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

  test("caret dual shell exposes detail tabs and live compact mode", async () => {
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(harness.origin, { waitUntil: "load" });
    await page.waitForSelector("#meeting-chrome", { timeout: 5_000 });

    const shell = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll(".detail-tabs__btn")].map((node) =>
        node.textContent?.trim() ?? "",
      );
      const cssHrefs = [...document.querySelectorAll('link[rel="stylesheet"]')].map((node) =>
        (node as HTMLLinkElement).getAttribute("href") ?? "",
      );
      return {
        activeShells: document.querySelectorAll('.app[data-shell]').length,
        hasCss: cssHrefs.includes("/caret-operator.css"),
        tabs,
        detailTab: document.querySelector(".app")?.getAttribute("data-detail-tab") ?? "",
        hasFollowup: Boolean(document.getElementById("action-followup")),
      };
    });

    expect(shell.activeShells).toBe(1);
    expect(shell.hasCss).toBe(true);
    expect(shell.tabs).toEqual(["Overview", "Notes", "Transcript"]);
    expect(shell.detailTab).toBe("overview");
    expect(shell.hasFollowup).toBe(true);

    await page.click("#detail-tab-notes");
    await page.waitForFunction(
      () => document.querySelector(".app")?.getAttribute("data-detail-tab") === "notes",
      { timeout: 3_000 },
    );

    // ADDITIVE UPDATE (Todo 12). This step used to add `.app--capturing` by hand.
    // That class is the legacy compatibility signal, not the authoritative shell:
    // setting it alone leaves `data-shell="library"`, so the live geometry never
    // applies and the assertions below measured the library layout while claiming
    // to measure live. Todo 12's live rules key on the authoritative
    // `data-shell="live"`, so the shell is now entered the way the product enters
    // it - through a real capture frame - and the same assertions hold.
    await page.evaluate(() => {
      (globalThis as unknown as { __live: Promise<void> }).__live = new Promise<void>((resolve, reject) => {
        const app = document.querySelector(".app") as HTMLElement;
        const done = () => app.dataset.shell === "live" && app.classList.contains("app--capturing");
        if (done()) { resolve(); return; }
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error("live shell timeout")); }, 3_000);
        const observer = new MutationObserver(() => {
          if (!done()) return;
          clearTimeout(timer); observer.disconnect(); resolve();
        });
        observer.observe(app, { attributes: true, attributeFilter: ["class", "data-shell"] });
      });
    });
    harness.pushMessage({ type: "capture", capturing: true, mode: "mic", phase: "capturing" });
    await page.evaluate(() => (globalThis as unknown as { __live: Promise<void> }).__live);

    const live = await page.evaluate(() => {
      const topbar = document.getElementById("live-topbar");
      const stop = document.getElementById("btn-live-stop");
      const style = topbar ? getComputedStyle(topbar) : null;
      const rail = document.querySelector(".session-rail") as HTMLElement | null;
      const stage = document.querySelector(".stage-pane") as HTMLElement | null;
      const transcript = document.querySelector(".transcript-pane") as HTMLElement | null;
      const sr = stage?.getBoundingClientRect();
      const tr = transcript?.getBoundingClientRect();
      return {
        capturing: document.querySelector(".app")?.classList.contains("app--capturing") ?? false,
        stopPresent: Boolean(stop),
        topbarDisplay: style?.display ?? "none",
        railDisplay: rail ? getComputedStyle(rail).display : "missing",
        docHeadDisplay: getComputedStyle(document.querySelector(".doc-head") as HTMLElement).display,
        stageW: sr?.width ?? 0,
        transcriptW: tr?.width ?? 0,
        sideBySide: Boolean(sr && tr && Math.abs(sr.top - tr.top) < 48),
        slideInStage: Boolean(
          stage && document.getElementById("current-slide") && stage.contains(document.getElementById("current-slide")),
        ),
      };
    });
    expect(live.capturing).toBe(true);
    expect(live.stopPresent).toBe(true);
    expect(live.topbarDisplay).not.toBe("none");
    expect(live.railDisplay).toBe("none");
    expect(live.docHeadDisplay).toBe("none");
    expect(live.stageW).toBeGreaterThan(200);
    expect(live.transcriptW).toBeGreaterThan(200);
    expect(live.sideBySide).toBe(true);
    expect(live.slideInStage).toBe(true);

    // ADDITIVE UPDATE (Todo 12): leave live the way the product leaves it too -
    // on the authoritative idle frame - so `data-shell` returns to `library`.
    await page.evaluate(() => {
      (globalThis as unknown as { __idle: Promise<void> }).__idle = new Promise<void>((resolve, reject) => {
        const app = document.querySelector(".app") as HTMLElement;
        const done = () => app.dataset.shell === "library" && !app.classList.contains("app--capturing");
        if (done()) { resolve(); return; }
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error("idle shell timeout")); }, 3_000);
        const observer = new MutationObserver(() => {
          if (!done()) return;
          clearTimeout(timer); observer.disconnect(); resolve();
        });
        observer.observe(app, { attributes: true, attributeFilter: ["class", "data-shell"] });
      });
    });
    harness.pushMessage({ type: "capture", capturing: false, mode: "mic", phase: "idle" });
    await page.evaluate(() => (globalThis as unknown as { __idle: Promise<void> }).__idle);
    await page.evaluate(() => {
      document.querySelector(".app")?.setAttribute("data-detail-tab", "overview");
    });
    const restored = await page.evaluate(() => {
      const topbar = document.getElementById("live-topbar");
      const rail = document.getElementById("session-rail");
      return {
        topbarDisplay: topbar ? getComputedStyle(topbar).display : "missing",
        railDisplay: rail ? getComputedStyle(rail).display : "missing",
        docHeadDisplay: getComputedStyle(document.querySelector(".doc-head") as HTMLElement).display,
      };
    });
    expect(restored.topbarDisplay).toBe("none");
    expect(restored.railDisplay).not.toBe("none");
    expect(restored.docHeadDisplay).not.toBe("none");
  });
});
