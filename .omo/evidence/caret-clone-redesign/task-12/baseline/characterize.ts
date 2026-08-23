// Todo 12 characterization: what does the CURRENT live workspace actually do?
//
// No assertions here. This driver only records measured geometry for the live
// shell across the plan's matrix, including the Todo-11 GREEN baseline widths,
// so the focused RED that follows is written against reality, not memory.
//
// Determinism: frozen clock, ko-KR / Asia/Seoul, DPR 1, off-origin requests
// refused, every awaited state subscribed to before its trigger, no sleeps.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "../../../../../tests/public-test-harness.ts";

const OUT = import.meta.dir;
const FIXED_CLOCK_EPOCH_MS = 1_710_376_860_000;

const VIEWPORTS = [
  { name: "reference", width: 1440, height: 900 },
  { name: "library", width: 1244, height: 836 },
  { name: "seam1100", width: 1100, height: 800 },
  { name: "live", width: 960, height: 760 },
  { name: "seam900", width: 900, height: 760 },
  { name: "seam899", width: 899, height: 760 },
  { name: "stacked", width: 820, height: 900 },
  { name: "narrow", width: 375, height: 812 },
  { name: "compact", width: 320, height: 667 },
] as const;

const SLIDE = {
  index: 3,
  startedAt: FIXED_CLOCK_EPOCH_MS - 60_000,
  sentenceCount: 9,
  kind: "topic",
  title: "온보딩 지표 점검과 다음 스프린트 범위 확정",
  kicker: "제품 로드맵",
  bullets: ["이탈률 12% 감소", "설치 시간 4분 → 2분 30초", "튜토리얼 4단계 축소"],
  emphasis: "결정: 온보딩 튜토리얼을 4단계로 축소한다",
};

const LINES = Array.from({ length: 15 }, (_, i) => ({
  type: "line" as const,
  text: `${i + 1}번째 확정 문장입니다. 온보딩 이탈률과 설치 시간 지표를 함께 점검하면서 다음 스프린트의 범위를 확정하겠습니다.`,
  ts: FIXED_CLOCK_EPOCH_MS - (15 - i) * 3_000,
  speaker: (i % 2) + 1,
}));

function pageBootstrap(fixedNow: number): void {
  const OriginalDate = Date;
  class FrozenDate extends OriginalDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixedNow);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static override now(): number { return fixedNow; }
  }
  (globalThis as unknown as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;
}

/** Arms a DOM predicate BEFORE the trigger, resolves through an exposed hook. */
function armBootstrap(): void {
  (window as unknown as { __armed?: Map<string, () => void> }).__armed = new Map();
  (window as unknown as { __arm: (t: string, fn: string) => void }).__arm = (token, fnSource) => {
    const predicate = new Function(`return (${fnSource})`)() as () => boolean;
    let done = false;
    const settle = (): boolean => {
      if (done || !predicate()) return false;
      done = true;
      void (window as unknown as { __settle: (t: string) => Promise<void> }).__settle(token);
      return true;
    };
    if (settle()) return;
    const observer = new MutationObserver(() => { if (settle()) observer.disconnect(); });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
  };
}

async function main(): Promise<void> {
  const harness = createPublicTestHarness();
  const browser: Browser = await puppeteer.launch({
    args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"],
  });
  const page: Page = await browser.newPage();
  const settleWaiters = new Map<string, () => void>();
  let tokenId = 0;

  await page.exposeFunction("__settle", (token: string) => { settleWaiters.get(token)?.(); });
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  await page.evaluateOnNewDocument(pageBootstrap, FIXED_CLOCK_EPOCH_MS);
  await page.evaluateOnNewDocument(armBootstrap);
  await page.setRequestInterception(true);
  const blocked: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith(harness.origin) || url.startsWith("data:") || url === "about:blank") {
      void request.continue();
      return;
    }
    blocked.push(url);
    if (request.resourceType() === "stylesheet") {
      void request.respond({ status: 200, contentType: "text/css", body: ":root{}" });
      return;
    }
    void request.abort();
  });

  /** Subscribe-before-trigger. `predicate` is a source string evaluated in-page. */
  async function step(predicate: string, trigger: () => void | Promise<void>): Promise<void> {
    const token = `t${(tokenId += 1)}`;
    const settled = new Promise<void>((resolve) => settleWaiters.set(token, resolve));
    await page.evaluate((t: string, p: string) =>
      (window as unknown as { __arm: (t: string, p: string) => void }).__arm(t, p), token, predicate);
    await trigger();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<never>((_r, reject) => {
      timer = setTimeout(() => reject(new Error(`characterize: timeout waiting for ${predicate}`)), 4_000);
    });
    try { await Promise.race([settled, bounded]); }
    finally { if (timer) clearTimeout(timer); settleWaiters.delete(token); }
  }

  const report: Record<string, unknown> = { fixedClock: FIXED_CLOCK_EPOCH_MS, viewports: {} };

  for (const vp of VIEWPORTS) {
    await page.setViewport({ ...vp, deviceScaleFactor: 1 });
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
    await page.goto(harness.origin, { waitUntil: "load" });
    await harness.waitForClient();
    await page.evaluate(async () => { await document.fonts.ready; });

    // starting -> capturing -> slide -> 15 lines -> caption
    await step(
      `() => document.querySelector(".app")?.dataset.capturePhase === "starting"`,
      () => harness.pushMessage({ type: "capture", capturing: false, mode: "mic", phase: "starting" }),
    );
    const startingGeom = await page.evaluate(readGeometry);

    await step(
      `() => document.querySelector(".app")?.classList.contains("app--capturing") === true`,
      () => harness.pushMessage({
        type: "capture", capturing: true, mode: "mic", phase: "capturing",
        startedAt: FIXED_CLOCK_EPOCH_MS - 125_000,
      }),
    );
    await step(
      `() => document.querySelector("#current-slide .slide__title") !== null`,
      () => harness.pushMessage({ type: "slide", current: SLIDE, history: [] }),
    );
    for (const [i, line] of LINES.entries()) {
      await step(
        `() => document.querySelectorAll("#transcript-stream .feed-line").length === ${i + 1}`,
        () => harness.pushMessage(line),
      );
    }
    await step(
      `() => (document.getElementById("caption-text")?.textContent ?? "").includes("잠정")`,
      () => harness.pushMessage({
        type: "caption", text: "잠정 자막이 여기에 흐릅니다", ts: FIXED_CLOCK_EPOCH_MS, speaker: 2,
      }),
    );
    const liveGeom = await page.evaluate(readGeometry);

    await step(
      `() => document.querySelector(".app")?.dataset.capturePhase === "stopping"`,
      () => harness.pushMessage({ type: "capture", capturing: true, mode: "mic", phase: "stopping" }),
    );
    const stoppingGeom = await page.evaluate(readGeometry);

    (report.viewports as Record<string, unknown>)[vp.name] = {
      viewport: vp, starting: startingGeom, capturing: liveGeom, stopping: stoppingGeom,
    };
    await page.screenshot({ path: join(OUT, `live-${vp.name}-capturing.png`) as `${string}.png` });
  }

  (report as { blockedRequests: string[] }).blockedRequests = blocked;
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "baseline-geometry.json"), `${JSON.stringify(report, null, 2)}\n`);

  await browser.close();
  harness.stop();
  console.log("characterization written");
}

/** In-page: machine geometry only. */
function readGeometry() {
  const box = (sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, visible: r.width > 0 && r.height > 0,
    };
  };
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const app = document.querySelector(".app") as HTMLElement | null;
  const stage = box("#stage-pane");
  const transcript = box("#transcript-pane");
  const slide = box("#current-slide");
  const frame = box("#slide-frame");

  const controls = [...document.querySelectorAll<HTMLElement>(
    ".dock button, .dock a, #btn-live-stop, #btn-record",
  )].filter((el) => el.offsetParent !== null || el === document.activeElement);

  const controlReport = controls.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      id: el.id || el.className.split(" ")[0],
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      offscreenRight: r.right > vw + 1,
      offscreenLeft: r.left < -1,
      offscreenBottom: r.bottom > vh + 1,
      truncated: el.scrollWidth > el.clientWidth + 1,
      hidden: r.width === 0 || r.height === 0,
    };
  });

  const dockEl = document.querySelector(".dock") as HTMLElement | null;
  const tabsEl = document.querySelector(".dock__tabs") as HTMLElement | null;

  return {
    capturePhase: app?.dataset.capturePhase ?? null,
    shell: app?.dataset.shell ?? null,
    appCapturing: app?.classList.contains("app--capturing") ?? false,
    stage, transcript, slide, frame,
    dock: box(".dock"),
    dockTabs: box(".dock__tabs"),
    dockScrollX: dockEl ? dockEl.scrollWidth - dockEl.clientWidth : null,
    dockTabsScrollX: tabsEl ? tabsEl.scrollWidth - tabsEl.clientWidth : null,
    dockTabsOverflowX: tabsEl ? getComputedStyle(tabsEl).overflowX : null,
    dockTabsFlexWrap: tabsEl ? getComputedStyle(tabsEl).flexWrap : null,
    liveTopbar: box("#live-topbar"),
    stopBtn: box("#btn-live-stop"),
    timerText: document.getElementById("live-topbar-timer")?.textContent ?? null,
    transcriptStream: box("#transcript-stream"),
    transcriptLines: document.querySelectorAll("#transcript-stream .feed-line").length,
    transcriptBodyScrollH: (() => {
      const b = document.getElementById("transcript-body");
      return b ? { scrollH: b.scrollHeight, clientH: b.clientHeight, overflowY: getComputedStyle(b).overflowY } : null;
    })(),
    sameRow: Boolean(stage && transcript) && Math.abs(stage!.y - transcript!.y) <= 1,
    stacked: Boolean(stage && transcript) && transcript!.y >= stage!.y + stage!.h - 1,
    slideAspect: slide && slide.h > 0 ? Number((slide.w / slide.h).toFixed(3)) : null,
    slideClipped: Boolean(slide && frame)
      && (slide!.w > frame!.w + 1 || slide!.h > frame!.h + 1),
    rootOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
    controls: controlReport,
    controlsOffscreen: controlReport.filter((c) => c.offscreenRight || c.offscreenLeft).length,
    controlsTruncated: controlReport.filter((c) => c.truncated).length,
    viewport: { vw, vh },
  };
}

await main();
