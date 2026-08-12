// F4 M2 repair — minimum-width live-stage content visibility.
//
// This is a real Chromium regression at the exact 320x667 contract viewport.
// It measures every rendered character range rather than pinning screenshot
// bytes or prose. The placeholder and generated slide must both stay wholly
// inside the 16:9 surface, while Stop and the scrollable transcript remain
// reachable and the document root stays free of overflow.
//
// Synchronization is subscribe-before-trigger with a MutationObserver and a
// bounded named timeout. There are no sleeps, polling delays, or waitForTimeout.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness, type PublicTestHarness } from "./public-test-harness.ts";

const VIEWPORT = { width: 320, height: 667, deviceScaleFactor: 1 } as const;
const FIXED_NOW = 1_710_376_860_000;
const CAPTURE = {
  type: "capture", capturing: true, mode: "mic", phase: "capturing",
  startedAt: FIXED_NOW - 125_000,
} as const;
const GENERATED_SLIDE = {
  index: 3,
  startedAt: FIXED_NOW - 60_000,
  sentenceCount: 9,
  kind: "topic",
  title: "온보딩 지표 점검과 다음 스프린트 범위 확정",
  kicker: "제품 로드맵",
  bullets: ["이탈률 12% 감소", "설치 시간 4분 → 2분 30초", "튜토리얼 4단계 축소"],
  emphasis: "결정: 온보딩 튜토리얼을 4단계로 축소한다",
} as const;
const LINES = Array.from({ length: 10 }, (_, index) => ({
  type: "line" as const,
  text: `${index + 1}번째 확정 문장입니다. 온보딩 지표와 다음 스프린트 범위를 함께 확인합니다.`,
  ts: FIXED_NOW - (10 - index) * 3_000,
  speaker: (index % 2) + 1,
}));

declare global {
  interface Window {
    __narrowAwait?: (token: string, predicate: string) => void;
    __narrowSettle?: (token: string) => Promise<void>;
  }
}

function bootstrap(fixedNow: number): void {
  const OriginalDate = Date;
  class FrozenDate extends OriginalDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixedNow);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static override now(): number { return fixedNow; }
  }
  (globalThis as unknown as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;

  window.__narrowAwait = (token: string, predicate: string): void => {
    const check = new Function(`return (${predicate});`) as () => boolean;
    let done = false;
    const settle = (): boolean => {
      if (done) return true;
      let matched = false;
      try { matched = check() === true; } catch { matched = false; }
      if (!matched) return false;
      done = true;
      void window.__narrowSettle!(token);
      return true;
    };
    if (settle()) return;
    const observer = new MutationObserver(() => {
      if (settle()) observer.disconnect();
    });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
  };
}

class NarrowStageTimeoutError extends Error {
  constructor(predicate: string) {
    super(`narrow stage timed out waiting for: ${predicate}`);
    this.name = "NarrowStageTimeoutError";
  }
}

interface Session {
  page: Page;
  act(predicate: string, trigger: () => void | Promise<void>): Promise<void>;
  close(): Promise<void>;
}

let browser: Browser;
let harness: PublicTestHarness;

async function openSession(): Promise<Session> {
  const page = await browser.newPage();
  const waiters = new Map<string, () => void>();
  await page.exposeFunction("__narrowSettle", (token: string) => waiters.get(token)?.());
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  await page.evaluateOnNewDocument(bootstrap, FIXED_NOW);
  await page.setViewport(VIEWPORT);
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.waitForClient();
  await page.evaluate(async () => { await document.fonts.ready; });

  let sequence = 0;
  return {
    page,
    async act(predicate, trigger) {
      const token = `narrow-${sequence += 1}`;
      const settled = new Promise<void>((resolve) => waiters.set(token, resolve));
      await page.evaluate((t, p) => window.__narrowAwait!(t, p), token, predicate);
      await trigger();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new NarrowStageTimeoutError(predicate)), 2_000);
      });
      try { await Promise.race([settled, deadline]); }
      finally {
        if (timer !== undefined) clearTimeout(timer);
        waiters.delete(token);
      }
    },
    close: () => page.close(),
  };
}

async function enterLive(session: Session): Promise<void> {
  await session.act(
    'document.querySelector(".app")?.dataset.shell === "live"',
    () => harness.pushMessage(CAPTURE),
  );
}

async function addTranscript(session: Session): Promise<void> {
  for (let index = 0; index < LINES.length; index += 1) {
    await session.act(
      `document.querySelectorAll("#transcript-stream .feed-line").length === ${index + 1}`,
      () => harness.pushMessage(LINES[index]),
    );
  }
}

/** Runs in Chromium and reports geometry only; it does not compare copy. */
function readNarrowStageGeometry() {
  const slide = document.getElementById("current-slide")!;
  const frame = document.getElementById("slide-frame")!;
  const stop = document.getElementById("btn-live-stop") as HTMLButtonElement;
  const transcript = document.getElementById("transcript-pane")!;
  const transcriptBody = document.getElementById("transcript-body")!;
  const slideRect = slide.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  const viewport = { width: innerWidth, height: innerHeight };

  const textElements = [...slide.querySelectorAll<HTMLElement>(
    ".placeholder__title, .placeholder__sub, .slide__kicker, .slide__index, " +
    ".slide__title, .slide__bullets li, .slide__emphasis",
  )].filter((element) => getComputedStyle(element).display !== "none");

  const partialCharacters: Array<{ element: string; index: number }> = [];
  const occludedCharacters: Array<{ element: string; index: number }> = [];
  let characterCount = 0;
  for (const element of textElements) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? "";
      for (let index = 0; index < text.length; index += 1) {
        if (/\s/u.test(text[index]!)) continue;
        characterCount += 1;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        if (rect.left < slideRect.left - 1 || rect.top < slideRect.top - 1
          || rect.right > slideRect.right + 1 || rect.bottom > slideRect.bottom + 1) {
          partialCharacters.push({ element: element.className, index });
        }
        const samples = [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1];
        if (samples.some((y) => {
          const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
          return hit !== element && !element.contains(hit);
        })) {
          occludedCharacters.push({ element: element.className, index });
        }
      }
    }
  }

  const box = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height };
  };
  const inViewport = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.top >= -1
      && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
  };

  return {
    viewport,
    frame: box(frame),
    slide: box(slide),
    aspect: slideRect.width / slideRect.height,
    slideContained: slideRect.left >= frameRect.left - 1 && slideRect.top >= frameRect.top - 1
      && slideRect.right <= frameRect.right + 1 && slideRect.bottom <= frameRect.bottom + 1,
    slideOverflow: {
      x: slide.scrollWidth - slide.clientWidth,
      y: slide.scrollHeight - slide.clientHeight,
    },
    characterCount,
    partialCharacters,
    occludedCharacters,
    textElementCount: textElements.length,
    textFontSizes: textElements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    rootOverflow: {
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    },
    stop: {
      visible: inViewport(stop),
      enabled: !stop.disabled,
      focusable: stop.tabIndex >= 0,
      box: box(stop),
    },
    transcript: {
      visible: inViewport(transcript),
      box: box(transcript),
      bodyHeight: transcriptBody.clientHeight,
      scrollHeight: transcriptBody.scrollHeight,
      overflowY: getComputedStyle(transcriptBody).overflowY,
    },
  };
}

beforeAll(async () => {
  harness = createPublicTestHarness();
  browser = await puppeteer.launch({
    args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"],
  });
});

afterAll(async () => {
  await browser?.close();
  harness?.stop();
});

describe("F4 M2 · exact 320x667 narrow live stage", () => {
  test("the complete placeholder stays inside the 16:9 slide without shrinking contract text", async () => {
    const session = await openSession();
    try {
      await enterLive(session);
      const geometry = await session.page.evaluate(readNarrowStageGeometry);

      expect(geometry.viewport).toEqual({ width: 320, height: 667 });
      expect(Math.abs(geometry.aspect - 16 / 9)).toBeLessThanOrEqual(0.02);
      expect(geometry.slideContained).toBe(true);
      expect(geometry.textElementCount).toBe(2);
      expect(geometry.characterCount).toBeGreaterThan(0);
      expect(geometry.partialCharacters).toEqual([]);
      expect(geometry.occludedCharacters).toEqual([]);
      expect(geometry.slideOverflow.x).toBeLessThanOrEqual(1);
      expect(geometry.slideOverflow.y).toBeLessThanOrEqual(1);
      expect(Math.min(...geometry.textFontSizes)).toBeGreaterThanOrEqual(13);
      expect(geometry.rootOverflow.x).toBeLessThanOrEqual(0);
      expect(geometry.rootOverflow.y).toBeLessThanOrEqual(0);
      expect(geometry.stop.visible).toBe(true);
      expect(geometry.stop.enabled).toBe(true);
      expect(geometry.stop.focusable).toBe(true);
      expect(geometry.transcript.visible).toBe(true);
      expect(geometry.transcript.bodyHeight).toBeGreaterThanOrEqual(120);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("a complete generated slide, transcript tail, and Stop remain reachable", async () => {
    const session = await openSession();
    try {
      await enterLive(session);
      await session.act(
        'document.querySelector("#current-slide .slide__title") !== null',
        () => harness.pushMessage({ type: "slide", current: GENERATED_SLIDE, history: [] }),
      );
      await addTranscript(session);
      const geometry = await session.page.evaluate(readNarrowStageGeometry);

      expect(geometry.textElementCount).toBeGreaterThanOrEqual(6);
      expect(geometry.characterCount).toBeGreaterThan(0);
      expect(geometry.slideContained).toBe(true);
      expect(geometry.partialCharacters).toEqual([]);
      expect(geometry.occludedCharacters).toEqual([]);
      expect(geometry.slideOverflow.x).toBeLessThanOrEqual(1);
      expect(geometry.slideOverflow.y).toBeLessThanOrEqual(1);
      expect(Math.min(...geometry.textFontSizes)).toBeGreaterThanOrEqual(8);
      expect(geometry.rootOverflow.x).toBeLessThanOrEqual(0);
      expect(geometry.rootOverflow.y).toBeLessThanOrEqual(0);
      expect(geometry.stop.visible).toBe(true);
      expect(geometry.stop.enabled).toBe(true);
      expect(geometry.transcript.visible).toBe(true);
      expect(geometry.transcript.scrollHeight).toBeGreaterThan(geometry.transcript.bodyHeight);
      expect(["auto", "scroll"]).toContain(geometry.transcript.overflowY);

      await session.page.focus("#btn-live-stop");
      expect(await session.page.evaluate(() => document.activeElement?.id)).toBe("btn-live-stop");
      await session.page.evaluate(() => {
        document.querySelector("#transcript-stream .feed-line:last-child")?.scrollIntoView({ block: "nearest" });
      });
      const tailReachable = await session.page.evaluate(() => {
        const body = document.getElementById("transcript-body")!.getBoundingClientRect();
        const tail = document.querySelector("#transcript-stream .feed-line:last-child")!.getBoundingClientRect();
        return tail.top >= body.top - 1 && tail.bottom <= body.bottom + 1;
      });
      expect(tailReachable).toBe(true);
    } finally {
      await session.close();
    }
  }, 30_000);
});
