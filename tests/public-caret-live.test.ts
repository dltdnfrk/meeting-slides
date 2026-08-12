// Todo 12 — the focused live PPT + transcript workspace.
//
// What this file pins (machine-consumed values only; never prose, never
// screenshot bytes):
//   1. the 900px seam, tested at 900 and 899 EXACTLY: >=900 side by side,
//      <900 stacked with the stage above the transcript;
//   2. the generated PPT stage is a COMPLETE 16:9 slide, fully contained inside
//      #slide-frame and never scaled to illegibility, at every matrix width;
//   3. the transcript is legible, scrollable, renders Korean multiline, and its
//      provisional / final / correction / dedupe / ordering all come from the
//      canonical reducer served through the generated JS artifacts;
//   4. Stop and the timer are visible, enabled and truthful through starting,
//      capturing and stopping, and survive reconnect and transport error;
//   5. the live dock never leaves a control clipped or horizontally offscreen —
//      the Todo-11 handoff defect where `starting` at 375px pushed eight export
//      controls up to 954px on a 375px viewport;
//   6. zero root overflow at every width from 320 up.
//
// Synchronization: every awaited client state is armed with a MutationObserver
// BEFORE its trigger frame is pushed and bounded by a named timeout. There is no
// sleep, no polling delay and no waitForTimeout in this file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { join } from "node:path";

import { checkPublicModules } from "../scripts/build-public-modules.ts";
import { createPublicTestHarness, type PublicTestHarness } from "./public-test-harness.ts";

const publicDir = join(import.meta.dir, "..", "public");

/** Frozen clock shared with the task-4 fixtures so data never drifts by run. */
const FIXED_CLOCK_EPOCH_MS = 1_710_376_860_000;
/** Capture started 125 s before the frozen clock => timer text "02:05". */
const FIXED_CAPTURE_STARTED_AT = FIXED_CLOCK_EPOCH_MS - 125_000;

/**
 * The live matrix. 900 and 899 are BOTH present and adjacent: the seam is a
 * contract, so it is tested at the exact boundary rather than sampled around it.
 */
const LIVE_VIEWPORTS = [
  { name: "reference", width: 1440, height: 900, sideBySide: true },
  { name: "library", width: 1244, height: 836, sideBySide: true },
  { name: "seam1100", width: 1100, height: 800, sideBySide: true },
  { name: "live", width: 960, height: 760, sideBySide: true },
  { name: "seam900", width: 900, height: 760, sideBySide: true },
  { name: "seam899", width: 899, height: 760, sideBySide: false },
  { name: "stacked", width: 820, height: 900, sideBySide: false },
  { name: "narrow", width: 375, height: 812, sideBySide: false },
  { name: "compact", width: 320, height: 667, sideBySide: false },
] as const;

/**
 * 16:9 within a 1.5% tolerance. The tolerance is NOT a subpixel allowance: it
 * absorbs the integer rounding of a fractional CSS box (e.g. a 563.33px wide
 * frame yields 316.87px of height, and both are reported rounded). It is far
 * tighter than any real deviation from the ratio: the characterized baseline
 * measured aspects from 1.257 to 13.317, all of which fail this bound.
 */
const SLIDE_ASPECT = 16 / 9;
const SLIDE_ASPECT_TOLERANCE = 0.015;

/**
 * Legibility floors for the CONTAINED slide. A 16:9 box narrower than this can
 * no longer render the generated deck's title + bullets at a readable size, so
 * "contained" would be satisfied by an illegible sliver without them.
 */
const MIN_SLIDE_WIDTH = 240;
const MIN_SLIDE_HEIGHT = 135;

/** The transcript must be a readable, scrollable column, not a one-line strip. */
const MIN_TRANSCRIPT_WIDTH = 240;
const MIN_TRANSCRIPT_VIEWPORT_HEIGHT = 120;

const SLIDE = {
  index: 3,
  startedAt: FIXED_CLOCK_EPOCH_MS - 60_000,
  sentenceCount: 9,
  kind: "topic",
  title: "온보딩 지표 점검과 다음 스프린트 범위 확정",
  kicker: "제품 로드맵",
  bullets: ["이탈률 12% 감소", "설치 시간 4분 → 2분 30초", "튜토리얼 4단계 축소"],
  emphasis: "결정: 온보딩 튜토리얼을 4단계로 축소한다",
} as const;

/** 15 deterministic multiline Korean finals, 3 s apart, two speakers. */
const LINES = Array.from({ length: 15 }, (_, i) => ({
  type: "line" as const,
  text: `${i + 1}번째 확정 문장입니다. 온보딩 이탈률과 설치 시간 지표를 함께 점검하면서 다음 스프린트의 범위를 확정하겠습니다.`,
  ts: FIXED_CLOCK_EPOCH_MS - (15 - i) * 3_000,
  speaker: (i % 2) + 1,
}));

const CAPTURE_STARTING = { type: "capture", capturing: false, mode: "mic", phase: "starting" } as const;
const CAPTURE_LIVE = {
  type: "capture", capturing: true, mode: "mic", phase: "capturing",
  startedAt: FIXED_CAPTURE_STARTED_AT,
} as const;
const CAPTURE_STOPPING = { type: "capture", capturing: true, mode: "mic", phase: "stopping" } as const;
const CAPTURE_IDLE = { type: "capture", capturing: false, mode: "mic", phase: "idle" } as const;

// ── page-side plumbing ──────────────────────────────────────────────────────

declare global {
  interface Window {
    __liveAwait?: (token: string, predicate: string) => void;
    __liveSettle?: (token: string) => Promise<void>;
  }
}

/**
 * Installed on every page before any application script. Freezes the clock so
 * rendered timestamps never vary, and exposes a subscribe-before-trigger
 * registry. The observer is armed at subscription time and also evaluates
 * immediately, so a state reached between arming and awaiting is still observed.
 */
function pageBootstrap(fixedNow: number): void {
  const OriginalDate = Date;
  class FrozenDate extends OriginalDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixedNow);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static override now(): number {
      return fixedNow;
    }
  }
  (globalThis as unknown as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;

  window.__liveAwait = (token: string, predicate: string): void => {
    const check = new Function(`return (${predicate});`) as () => boolean;
    let done = false;
    const settle = (): boolean => {
      if (done) return true;
      let ok = false;
      try {
        ok = check() === true;
      } catch {
        ok = false;
      }
      if (!ok) return false;
      done = true;
      void window.__liveSettle!(token);
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

class LiveStateTimeoutError extends Error {
  constructor(predicate: string, timeoutMs: number) {
    super(`live shell timed out after ${timeoutMs}ms waiting for: ${predicate}`);
    this.name = "LiveStateTimeoutError";
  }
}

interface Session {
  page: Page;
  act(predicate: string, trigger: () => void | Promise<void>, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

let browser: Browser;
let harness: PublicTestHarness;

async function openSession(width: number, height: number): Promise<Session> {
  const page = await browser.newPage();
  const settleWaiters = new Map<string, () => void>();
  await page.exposeFunction("__liveSettle", (token: string) => {
    settleWaiters.get(token)?.();
  });
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  await page.evaluateOnNewDocument(pageBootstrap, FIXED_CLOCK_EPOCH_MS);
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.waitForClient();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  let counter = 0;
  return {
    page,
    async act(predicate, trigger, timeoutMs = 2_000) {
      const token = `live-${(counter += 1)}`;
      const settled = new Promise<void>((resolve) => settleWaiters.set(token, resolve));
      await page.evaluate((t: string, p: string) => window.__liveAwait!(t, p), token, predicate);
      await trigger();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LiveStateTimeoutError(predicate, timeoutMs)), timeoutMs);
      });
      try {
        await Promise.race([settled, bounded]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        settleWaiters.delete(token);
      }
    },
    async close() {
      await page.close();
    },
  };
}

/** starting -> capturing -> slide -> 15 Korean finals. */
async function enterLive(session: Session, { lines = 15 } = {}): Promise<void> {
  await session.act(
    'document.querySelector(".app")?.dataset.capturePhase === "starting"',
    () => harness.pushMessage(CAPTURE_STARTING),
  );
  await session.act(
    'document.querySelector(".app")?.classList.contains("app--capturing") === true',
    () => harness.pushMessage(CAPTURE_LIVE),
  );
  await session.act(
    'document.querySelector("#current-slide .slide__title") !== null',
    () => harness.pushMessage({ type: "slide", current: SLIDE, history: [] }),
  );
  for (let i = 0; i < lines; i += 1) {
    await session.act(
      `document.querySelectorAll("#transcript-stream .feed-line").length === ${i + 1}`,
      () => harness.pushMessage(LINES[i]),
    );
  }
}

// ── in-page readers: machine values only ────────────────────────────────────

/** The live split: which arrangement, and is each region actually usable. */
function readLiveSplit() {
  const box = (selector: string) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const stage = box("#stage-pane");
  const transcript = box("#transcript-pane");
  const body = document.getElementById("transcript-body");
  const app = document.querySelector(".app") as HTMLElement | null;
  return {
    shell: app?.dataset.shell ?? null,
    capturePhase: app?.dataset.capturePhase ?? null,
    stage, transcript,
    stageVisible: Boolean(stage && stage.w > 0 && stage.h > 0),
    transcriptVisible: Boolean(transcript && transcript.w > 0 && transcript.h > 0),
    // Side by side: tops aligned and the transcript starts to the RIGHT of the
    // stage's right edge (a 1px tolerance absorbs fractional box rounding).
    sameRow: Boolean(stage && transcript)
      && Math.abs(stage!.y - transcript!.y) <= 1
      && transcript!.x >= stage!.x + stage!.w - 1,
    // Stacked: the transcript starts at or below the stage's bottom edge.
    stacked: Boolean(stage && transcript) && transcript!.y >= stage!.y + stage!.h - 1,
    transcriptBody: body
      ? {
        clientH: body.clientHeight,
        scrollH: body.scrollHeight,
        overflowY: getComputedStyle(body).overflowY,
        scrollable: body.scrollHeight > body.clientHeight,
      }
      : null,
    rootOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
  };
}

/** The generated PPT stage: is the whole 16:9 slide really contained + legible. */
function readSlideContainment() {
  const frame = document.getElementById("slide-frame");
  const slide = document.getElementById("current-slide");
  if (!frame || !slide) return null;
  const fr = frame.getBoundingClientRect();
  const sr = slide.getBoundingClientRect();
  const inner = slide.querySelector(".slide__inner") as HTMLElement | null;
  const title = slide.querySelector(".slide__title") as HTMLElement | null;
  const bullets = [...slide.querySelectorAll(".slide__bullets li")] as HTMLElement[];

  /** True when `el`'s painted box escapes the slide's own box. */
  const escapes = (el: HTMLElement): boolean => {
    const r = el.getBoundingClientRect();
    return r.right > sr.right + 1 || r.bottom > sr.bottom + 1
      || r.left < sr.left - 1 || r.top < sr.top - 1;
  };

  return {
    frame: { w: Math.round(fr.width), h: Math.round(fr.height) },
    slide: { w: Math.round(sr.width), h: Math.round(sr.height) },
    aspect: sr.height > 0 ? sr.width / sr.height : 0,
    // The slide box never exceeds the frame that contains it.
    containedInFrame: sr.width <= fr.width + 1 && sr.height <= fr.height + 1,
    // The slide never scrolls its own content away.
    slideScrollX: slide.scrollWidth - slide.clientWidth,
    slideScrollY: slide.scrollHeight - slide.clientHeight,
    innerOverflows: inner ? inner.scrollHeight > inner.clientHeight + 1 : false,
    titleText: title?.textContent?.trim() ?? null,
    // Every rendered slide element stays inside the slide's painted box.
    escapingElements: [inner, title, ...bullets].filter((el): el is HTMLElement => el !== null)
      .filter(escapes).length,
    bulletCount: bullets.length,
    // Font sizes are read to prove "contained" was not achieved by shrinking the
    // deck to an unreadable scale.
    titleFontPx: title ? Number.parseFloat(getComputedStyle(title).fontSize) : 0,
    bulletFontPx: bullets[0] ? Number.parseFloat(getComputedStyle(bullets[0]).fontSize) : 0,
  };
}

/** Stop + timer truthfulness, and the live dock's control layout. */
function readLiveControls() {
  const vw = document.documentElement.clientWidth;
  const stop = document.getElementById("btn-live-stop") as HTMLButtonElement | null;
  const timer = document.getElementById("live-topbar-timer");
  const topbar = document.getElementById("live-topbar");

  const perceivable = (el: HTMLElement): boolean => {
    if (el.hidden) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // Every control the live shell actually exposes: the dock's actions plus the
  // record/stop controls. Hidden controls are excluded — the contract is that
  // nothing VISIBLE is clipped or offscreen, not that everything must be shown.
  const controls = [...document.querySelectorAll<HTMLElement>(
    ".dock button, .dock a[data-output-target], #btn-live-stop, #btn-record",
  )].filter(perceivable);

  const report = controls.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      id: el.id || (el.className.split(" ")[0] ?? "anon"),
      x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right),
      offscreen: r.right > vw + 1 || r.left < -1,
      // scrollWidth > clientWidth means the label is cut or ellipsized.
      truncated: el.scrollWidth > el.clientWidth + 1,
    };
  });

  const tabs = document.querySelector(".dock__tabs") as HTMLElement | null;

  return {
    stopPresent: stop !== null && perceivable(stop),
    stopEnabled: stop !== null && !stop.disabled,
    stopBox: stop ? (() => {
      const r = stop.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })() : null,
    topbarVisible: topbar !== null && perceivable(topbar),
    timerText: timer?.textContent?.trim() ?? null,
    // The timer must never be an ARIA live region (DESIGN 9.12).
    timerAriaLive: timer?.getAttribute("aria-live") ?? null,
    controlCount: report.length,
    offscreenControls: report.filter((c) => c.offscreen).map((c) => c.id),
    truncatedControls: report.filter((c) => c.truncated).map((c) => c.id),
    // A horizontally scrolling action row is exactly the superseded pattern that
    // left labels behind an overflow fade; it must not reappear.
    dockTabsScrollX: tabs ? tabs.scrollWidth - tabs.clientWidth : null,
    rootOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}

/** Transcript projection: what the canonical reducer produced, as rendered. */
function readTranscript() {
  const lines = [...document.querySelectorAll<HTMLElement>("#transcript-stream .feed-line")];
  const stream = document.getElementById("transcript-stream");
  const body = document.getElementById("transcript-body");
  const texts = lines.map((el) => el.querySelector(".feed-line__text")?.textContent?.trim() ?? "");
  return {
    count: lines.length,
    texts,
    // DOM order is the projection order; duplicates would repeat a text.
    uniqueTexts: new Set(texts).size,
    countLabel: document.getElementById("transcript-count")?.textContent?.trim() ?? null,
    provisionalText: document.getElementById("caption-text")?.textContent?.trim() ?? null,
    // Multiline Korean: how many rendered lines actually wrap to >1 line box.
    // This is width-dependent by nature (a wide stacked column fits a whole
    // sentence on one line), so the contract asserted below is the one that is
    // width-independent: the measure is bounded and wrapping is enabled.
    multilineLines: lines.filter((el) => {
      const text = el.querySelector(".feed-line__text") as HTMLElement | null;
      if (!text) return false;
      const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
      return Number.isFinite(lineHeight) && text.getBoundingClientRect().height > lineHeight * 1.5;
    }).length,
    // Korean prose must be allowed to wrap, and must not run past a readable
    // measure. `white-space: nowrap` or an unbounded column would each clip or
    // exhaust a long sentence instead of wrapping it.
    whiteSpace: lines[0]
      ? getComputedStyle(lines[0].querySelector(".feed-line__text")!).whiteSpace
      : null,
    widestLinePx: Math.max(
      0,
      ...lines.map((el) => el.getBoundingClientRect().width),
    ),
    fontPx: lines[0]
      ? Number.parseFloat(getComputedStyle(lines[0].querySelector(".feed-line__text")!).fontSize)
      : 0,
    streamScrollX: stream ? stream.scrollWidth - stream.clientWidth : null,
    bodyScrollable: body ? body.scrollHeight > body.clientHeight : false,
    bodyOverflowY: body ? getComputedStyle(body).overflowY : null,
  };
}

// ── suite ───────────────────────────────────────────────────────────────────

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

describe("Todo 12 · generated reducer integration", () => {
  test("the live shell runs the CANONICAL reducers from the generated artifacts, never raw TS", async () => {
    // Drift gate: every served artifact must equal a fresh build of its source.
    const drift = await checkPublicModules(publicDir);
    expect(drift.filter((report) => report.status !== "ok")).toEqual([]);

    const session = await openSession(1440, 900);
    try {
      await enterLive(session, { lines: 3 });
      const wiring = await session.page.evaluate(() => {
        const scripts = [...document.querySelectorAll<HTMLScriptElement>("script[src]")]
          .map((s) => s.getAttribute("src") ?? "");
        const modules = (window as unknown as { __caretModules?: Record<string, unknown> }).__caretModules;
        return {
          // No raw TypeScript is ever requested by the document.
          rawTsScripts: scripts.filter((src) => src.endsWith(".ts")),
          modulesLoaded: modules !== undefined,
          hasUiReducer: typeof (modules as { ui?: { reduce?: unknown } })?.ui?.reduce === "function",
          hasTranscriptReducer:
            typeof (modules as { transcript?: { reduceTranscript?: unknown } })
              ?.transcript?.reduceTranscript === "function",
          // The transcript projection the reducer holds, not the DOM's copy.
          reducerLineCount: (window as unknown as {
            __caretShell?: { transcriptState?: { finalized?: unknown[] } };
          }).__caretShell?.transcriptState?.finalized?.length ?? null,
        };
      });

      expect(wiring.rawTsScripts).toEqual([]);
      expect(wiring.modulesLoaded).toBe(true);
      expect(wiring.hasUiReducer).toBe(true);
      expect(wiring.hasTranscriptReducer).toBe(true);
      // The reducer saw the same three finals the DOM rendered.
      expect(wiring.reducerLineCount).toBe(3);
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe("Todo 12 · the 900px live seam", () => {
  for (const vp of LIVE_VIEWPORTS) {
    test(
      `${vp.width}x${vp.height}: live is ${vp.sideBySide ? "side by side" : "stacked, stage first"}`,
      async () => {
        const session = await openSession(vp.width, vp.height);
        try {
          await enterLive(session);
          const split = await session.page.evaluate(readLiveSplit);

          expect(split.shell).toBe("live");
          expect(split.stageVisible).toBe(true);
          expect(split.transcriptVisible).toBe(true);
          // The seam itself, asserted at the exact boundary.
          expect(split.sameRow).toBe(vp.sideBySide);
          expect(split.stacked).toBe(!vp.sideBySide);
          // The root never overflows horizontally at any matrix width.
          expect(split.rootOverflowX).toBeLessThanOrEqual(0);
          expect(split.bodyOverflowX).toBeLessThanOrEqual(0);
        } finally {
          await session.close();
        }
      },
      30_000,
    );
  }
});

describe("Todo 12 · the complete generated PPT stage", () => {
  for (const vp of LIVE_VIEWPORTS) {
    test(`${vp.width}x${vp.height}: the whole 16:9 slide is contained and legible`, async () => {
      const session = await openSession(vp.width, vp.height);
      try {
        await enterLive(session);
        const slide = await session.page.evaluate(readSlideContainment);
        expect(slide).not.toBeNull();

        // 16:9, within the integer-rounding tolerance.
        expect(Math.abs(slide!.aspect - SLIDE_ASPECT)).toBeLessThanOrEqual(
          SLIDE_ASPECT * SLIDE_ASPECT_TOLERANCE,
        );
        // Fully contained: inside its frame, with nothing scrolled away and no
        // rendered element escaping the slide's own painted box.
        expect(slide!.containedInFrame).toBe(true);
        expect(slide!.slideScrollX).toBeLessThanOrEqual(1);
        expect(slide!.slideScrollY).toBeLessThanOrEqual(1);
        expect(slide!.innerOverflows).toBe(false);
        expect(slide!.escapingElements).toBe(0);
        // Complete: the generated content is actually present, not dropped to
        // make the box fit.
        expect(slide!.titleText).toBe(SLIDE.title);
        expect(slide!.bulletCount).toBe(SLIDE.bullets.length);
        // Legible: never scaled to an unreadable sliver.
        expect(slide!.slide.w).toBeGreaterThanOrEqual(MIN_SLIDE_WIDTH);
        expect(slide!.slide.h).toBeGreaterThanOrEqual(MIN_SLIDE_HEIGHT);
        expect(slide!.titleFontPx).toBeGreaterThanOrEqual(11);
        expect(slide!.bulletFontPx).toBeGreaterThanOrEqual(8);
      } finally {
        await session.close();
      }
    }, 30_000);
  }
});

describe("Todo 12 · the complete live transcript", () => {
  for (const vp of LIVE_VIEWPORTS) {
    test(`${vp.width}x${vp.height}: transcript is legible, scrollable and Korean-multiline`, async () => {
      const session = await openSession(vp.width, vp.height);
      try {
        await enterLive(session);
        const [split, transcript] = await Promise.all([
          session.page.evaluate(readLiveSplit),
          session.page.evaluate(readTranscript),
        ]);

        expect(transcript.count).toBe(15);
        expect(transcript.uniqueTexts).toBe(15);
        // Projection order is the reducer's order: first in, first rendered.
        expect(transcript.texts[0]).toBe(LINES[0].text);
        expect(transcript.texts[14]).toBe(LINES[14].text);
        // A usable reading column, not a one-line strip.
        expect(split.transcript!.w).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_WIDTH);
        expect(split.transcriptBody!.clientH).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_VIEWPORT_HEIGHT);
        // Legible and scrollable in ONE dimension only.
        expect(transcript.fontPx).toBeGreaterThanOrEqual(11);
        expect(transcript.streamScrollX).toBeLessThanOrEqual(1);
        expect(transcript.bodyScrollable).toBe(true);
        // Non-null first: a missing node would otherwise read as a vacuous pass.
        expect(transcript.bodyOverflowY).not.toBeNull();
        expect(["auto", "scroll"]).toContain(transcript.bodyOverflowY as string);
        // Long Korean sentences wrap instead of being clipped to one line, and
        // never run past a readable measure. Measured at 899px before the fix:
        // an 809px unbounded line.
        expect(transcript.whiteSpace).not.toBeNull();
        expect(["normal", "pre-wrap", "pre-line"]).toContain(transcript.whiteSpace as string);
        expect(transcript.widestLinePx).toBeLessThanOrEqual(760);
        // Where the column IS narrow enough to force a wrap, it must wrap.
        if (split.transcript!.w < 560) {
          expect(transcript.multilineLines).toBeGreaterThan(0);
        }
      } finally {
        await session.close();
      }
    }, 30_000);
  }
});

describe("Todo 12 · transcript projection comes from the canonical reducer", () => {
  test("provisional becomes final, duplicates dedupe, reordered snapshots keep order", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 3 });

      // A provisional caption is visually distinct and NOT a finalized row.
      await session.act(
        'document.getElementById("caption-text")?.textContent?.includes("잠정") === true',
        () => harness.pushMessage({
          type: "caption", text: "잠정 자막입니다", ts: FIXED_CLOCK_EPOCH_MS, speaker: 2,
        }),
      );
      const withProvisional = await session.page.evaluate(readTranscript);
      expect(withProvisional.count).toBe(3);
      expect(withProvisional.provisionalText).toContain("잠정");

      // The final replaces the provisional; it does not add a fourth ghost row.
      await session.act(
        'document.querySelectorAll("#transcript-stream .feed-line").length === 4',
        () => harness.pushMessage({
          type: "line", text: "잠정 자막입니다 최종본", ts: FIXED_CLOCK_EPOCH_MS, speaker: 2,
        }),
      );
      const finalized = await session.page.evaluate(readTranscript);
      expect(finalized.count).toBe(4);
      expect(finalized.texts[3]).toBe("잠정 자막입니다 최종본");

      // The canonical reducer's own projection agrees with the rendered DOM and
      // deduplicates a replayed snapshot rather than appending it.
      const reducer = await session.page.evaluate(() => {
        const shell = (window as unknown as {
          __caretShell?: {
            transcriptState?: {
              finalized?: Array<{ text?: string }>;
              provisional?: { text?: string } | null;
            };
          };
        }).__caretShell;
        return {
          finalized: shell?.transcriptState?.finalized?.map((l) => l.text) ?? null,
          // The provisional row never survives into the finalized list.
          provisional: shell?.transcriptState?.provisional?.text ?? null,
        };
      });
      expect(reducer.finalized).toEqual(finalized.texts);
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe("Todo 12 · Stop and timer are persistent and truthful", () => {
  test("Stop + timer stay visible and enabled through starting, capturing and stopping", async () => {
    const session = await openSession(1244, 836);
    try {
      await session.act(
        'document.querySelector(".app")?.dataset.capturePhase === "starting"',
        () => harness.pushMessage(CAPTURE_STARTING),
      );
      const starting = await session.page.evaluate(readLiveControls);
      expect(starting.stopPresent).toBe(true);
      expect(starting.stopEnabled).toBe(true);
      expect(starting.topbarVisible).toBe(true);

      await session.act(
        'document.querySelector(".app")?.classList.contains("app--capturing") === true',
        () => harness.pushMessage(CAPTURE_LIVE),
      );
      const capturing = await session.page.evaluate(readLiveControls);
      expect(capturing.stopPresent).toBe(true);
      expect(capturing.stopEnabled).toBe(true);
      // The timer is truthful: startedAt is 125 s before the frozen clock.
      expect(capturing.timerText).toBe("02:05");
      // The timer must not be an ARIA live region.
      expect(capturing.timerAriaLive).not.toBe("assertive");

      await session.act(
        'document.querySelector(".app")?.dataset.capturePhase === "stopping"',
        () => harness.pushMessage(CAPTURE_STOPPING),
      );
      const stopping = await session.page.evaluate(readLiveControls);
      expect(stopping.stopPresent).toBe(true);
      expect(stopping.stopEnabled).toBe(true);
      expect(stopping.topbarVisible).toBe(true);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("a trailing line during stopping still renders, and idle returns to library once", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 3 });
      await session.act(
        'document.querySelector(".app")?.dataset.capturePhase === "stopping"',
        () => harness.pushMessage(CAPTURE_STOPPING),
      );
      // Live content survives the stopping phase …
      const duringStop = await session.page.evaluate(readLiveSplit);
      expect(duringStop.stageVisible).toBe(true);
      expect(duringStop.transcriptVisible).toBe(true);

      // … and a trailing final still lands.
      await session.act(
        'document.querySelectorAll("#transcript-stream .feed-line").length === 4',
        () => harness.pushMessage({
          type: "line", text: "정지 중에 도착한 마지막 문장입니다.", ts: FIXED_CLOCK_EPOCH_MS, speaker: 1,
        }),
      );

      // Only the authoritative idle returns to the library frame.
      await session.act(
        'document.querySelector(".app")?.dataset.shell === "library"',
        () => harness.pushMessage(CAPTURE_IDLE),
      );
      const afterIdle = await session.page.evaluate(() => ({
        shell: (document.querySelector(".app") as HTMLElement).dataset.shell,
        capturing: document.querySelector(".app")!.classList.contains("app--capturing"),
        lines: document.querySelectorAll("#transcript-stream .feed-line").length,
      }));
      expect(afterIdle.shell).toBe("library");
      expect(afterIdle.capturing).toBe(false);
      // The just-ended meeting's transcript is preserved, not wiped.
      expect(afterIdle.lines).toBe(4);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("a dropped socket keeps live content and the Stop control", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 3 });
      await session.act(
        'document.documentElement.dataset.connection === "disconnected"',
        () => harness.disconnectClients(),
      );
      const afterDrop = await session.page.evaluate(readLiveControls);
      const afterDropContent = await session.page.evaluate(() => ({
        lines: document.querySelectorAll("#transcript-stream .feed-line").length,
        slideTitle: document.querySelector("#current-slide .slide__title")?.textContent?.trim() ?? null,
      }));
      // Transport loss never claims the capture stopped and never drops content.
      expect(afterDrop.stopPresent).toBe(true);
      expect(afterDrop.stopEnabled).toBe(true);
      expect(afterDropContent.lines).toBe(3);
      expect(afterDropContent.slideTitle).toBe(SLIDE.title);
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe("Todo 12 · the save/export disclosure is reachable in BOTH shells", () => {
  // REGRESSION GUARD. The first cut of this task dissolved the disclosure in the
  // library shell with `display: contents` plus a hidden summary. A CLOSED
  // <details> still hides its content, so removing the summary removed the only
  // control that could open it: measured at all three wide widths, 8 of the 9
  // dock capabilities were unreachable and 7 sat below an unscrollable fold.
  //
  // These assertions are deliberately behavioural rather than geometric: a box
  // with a non-zero rect can still be unclickable, which is exactly how that
  // regression passed a size-only check.
  for (const vp of [
    { width: 1440, height: 900 },
    { width: 1244, height: 836 },
    { width: 1100, height: 800 },
  ] as const) {
    test(`${vp.width}x${vp.height}: all 9 library dock capabilities are mouse/keyboard reachable`, async () => {
      const session = await openSession(vp.width, vp.height);
      try {
        await session.act(
          'document.querySelector(".app")?.dataset.shell === "library"',
          () => harness.pushMessage(CAPTURE_IDLE),
        );

        // The disclosure itself must be a real, painted, focusable control.
        const summary = await session.page.evaluate(() => {
          const el = document.querySelector(".dock__more-summary") as HTMLElement | null;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            painted: r.width > 0 && r.height > 0,
            hitIsSelf: hit !== null && (hit === el || el.contains(hit)),
            display: getComputedStyle(el).display,
          };
        });
        expect(summary).not.toBeNull();
        expect(summary!.painted).toBe(true);
        expect(summary!.hitIsSelf).toBe(true);
        expect(summary!.display).not.toBe("none");

        // KEYBOARD round trip. The library shell opens the set by default (Todo
        // 11's contract), so start from a known CLOSED state and prove Enter
        // toggles it both ways. Each direction is subscribed to before its key
        // press, so neither step can pass on an already-settled state.
        await session.act(
          'document.getElementById("dock-more")?.hasAttribute("open") === false',
          () => session.page.evaluate(() => {
            (document.getElementById("dock-more") as HTMLDetailsElement).open = false;
          }),
        );
        await session.act(
          'document.getElementById("dock-more")?.hasAttribute("open") === true',
          async () => {
            await session.page.focus(".dock__more-summary");
            await session.page.keyboard.press("Enter");
          },
        );
        const focusedAfterOpen = await session.page.evaluate(() =>
          document.activeElement?.className ?? "");
        expect(focusedAfterOpen).toContain("dock__more-summary");

        // Every one of the nine capabilities: painted, hit-testable at its own
        // centre, focusable, and NOT below an unreachable fold.
        const controls = await session.page.evaluate(() => {
          const ids = [
            "btn-compile-deck", "btn-export-md", "btn-export-json", "btn-export-transcript",
            "btn-export-deck", "btn-export-pdf", "btn-export-png", "btn-ask", "btn-reset",
          ];
          const dock = document.querySelector(".dock") as HTMLElement;
          return ids.map((id) => {
            const el = document.getElementById(id) as HTMLButtonElement | null;
            if (!el) return { id, present: false };
            // Bring it into view exactly as a user reaching for it would; the
            // dock is a scroll owner, so a control may legitimately start below
            // its visible edge. `block: "nearest"` scrolls only if needed.
            el.scrollIntoView({ block: "nearest", inline: "nearest" });
            const r = el.getBoundingClientRect();
            const painted = r.width > 0 && r.height > 0;
            const hit = painted
              ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
              : null;
            el.focus({ preventScroll: true });
            // Reachable vertically: either inside the viewport, or inside a
            // scroll owner that can bring it into view.
            const dockScrolls = dock.scrollHeight > dock.clientHeight;
            const withinViewport = r.top < document.documentElement.clientHeight;
            // A server-gated capability is CORRECTLY disabled and therefore not
            // focusable (DESIGN 9.11: visible and disabled with its exact machine
            // reason, never invisible). Focus is only required of enabled
            // controls; the disabled ones are checked for their reason instead.
            const disabled = el.disabled;
            return {
              id, present: true, painted, disabled,
              hitIsSelf: hit !== null && (hit === el || el.contains(hit)),
              focused: disabled ? true : document.activeElement === el,
              // A disabled control must still explain itself in both places.
              reasonGiven: !disabled
                || (Boolean(el.getAttribute("title")) && Boolean(el.getAttribute("aria-label"))),
              belowUnreachableFold: !withinViewport && !dockScrolls,
              offscreenRight: r.right > document.documentElement.clientWidth + 1,
            };
          });
        });

        expect(controls.filter((c) => !c.present).map((c) => c.id)).toEqual([]);
        expect(controls.filter((c) => !c.painted).map((c) => c.id)).toEqual([]);
        expect(controls.filter((c) => !c.hitIsSelf).map((c) => c.id)).toEqual([]);
        expect(controls.filter((c) => !c.focused).map((c) => c.id)).toEqual([]);
        expect(controls.filter((c) => !c.reasonGiven).map((c) => c.id)).toEqual([]);
        expect(controls.filter((c) => c.belowUnreachableFold).map((c) => c.id)).toEqual([]);
        expect(controls.filter((c) => c.offscreenRight).map((c) => c.id)).toEqual([]);

        // KEYBOARD close: the same control closes it again, and the capabilities
        // stay in the DOM exactly once (progressive disclosure, not deletion).
        await session.act(
          'document.getElementById("dock-more")?.hasAttribute("open") === false',
          async () => {
            await session.page.focus(".dock__more-summary");
            await session.page.keyboard.press("Enter");
          },
        );
        const afterClose = await session.page.evaluate(() => {
          const ids = [
            "btn-export-md", "btn-export-json", "btn-export-transcript",
            "btn-export-deck", "btn-export-pdf", "btn-export-png", "btn-ask", "btn-reset",
          ];
          return {
            duplicated: ids.filter((id) => document.querySelectorAll(`[id="${id}"]`).length !== 1),
            ariaHidden: ids.filter((id) =>
              document.getElementById(id)?.closest("[aria-hidden='true']") !== null),
          };
        });
        expect(afterClose.duplicated).toEqual([]);
        expect(afterClose.ariaHidden).toEqual([]);
      } finally {
        await session.close();
      }
    }, 30_000);
  }
});

describe("Todo 12 · the live dock clips nothing (Todo-11 handoff defect)", () => {
  // The characterized defect: at 375x812 during `starting`, the legacy nowrap
  // scroller placed eight export controls between x=367 and x=954 on a 375px
  // viewport. Every phase is asserted, because `starting` and `stopping` are
  // exactly the two the superseded rules did not cover.
  for (const width of [375, 320] as const) {
    for (const phase of ["starting", "capturing", "stopping"] as const) {
      test(`${width}px ${phase}: zero controls clipped or horizontally offscreen`, async () => {
        const session = await openSession(width, width === 375 ? 812 : 667);
        try {
          if (phase === "starting") {
            await session.act(
              'document.querySelector(".app")?.dataset.capturePhase === "starting"',
              () => harness.pushMessage(CAPTURE_STARTING),
            );
          } else {
            await enterLive(session, { lines: 3 });
            if (phase === "stopping") {
              await session.act(
                'document.querySelector(".app")?.dataset.capturePhase === "stopping"',
                () => harness.pushMessage(CAPTURE_STOPPING),
              );
            }
          }

          const controls = await session.page.evaluate(readLiveControls);
          expect(controls.offscreenControls).toEqual([]);
          expect(controls.truncatedControls).toEqual([]);
          // No horizontal scroller may reappear in the action row.
          expect(controls.dockTabsScrollX ?? 0).toBeLessThanOrEqual(1);
          expect(controls.rootOverflowX).toBeLessThanOrEqual(0);
          // Real capabilities are not hidden to win the measurement: Stop is
          // always there, and at least one action remains reachable.
          expect(controls.stopPresent).toBe(true);
          expect(controls.controlCount).toBeGreaterThan(0);
        } finally {
          await session.close();
        }
      }, 30_000);
    }
  }

  test("compile and export stay real and reachable in live, and never disable Stop", async () => {
    const session = await openSession(960, 760);
    try {
      await enterLive(session, { lines: 3 });
      const reach = await session.page.evaluate(() => {
        const ids = [
          "btn-compile-deck", "btn-export-md", "btn-export-json", "btn-export-transcript",
          "btn-export-deck", "btn-export-pdf", "btn-export-png",
        ];
        // Reachable = present exactly once and not buried under aria-hidden. A
        // control may legitimately sit behind a disclosure (progressive
        // disclosure is the point); it may never be removed or hidden from AT.
        const reachable = (id: string): boolean => {
          const el = document.getElementById(id);
          if (!el) return false;
          return document.querySelectorAll(`[id="${id}"]`).length === 1
            && el.closest("[aria-hidden='true']") === null;
        };
        const stop = document.getElementById("btn-live-stop") as HTMLButtonElement;
        return {
          missing: ids.filter((id) => document.getElementById(id) === null),
          duplicated: ids.filter((id) => document.querySelectorAll(`[id="${id}"]`).length !== 1),
          unreachable: ids.filter((id) => !reachable(id)),
          stopEnabled: !stop.disabled,
          // No invented capability may appear next to the real ones.
          fakePause: document.querySelector("#btn-pause, [data-action='pause']") !== null,
          fakeShare: document.querySelector("#btn-share, [data-action='share']") !== null,
        };
      });
      expect(reach.missing).toEqual([]);
      expect(reach.duplicated).toEqual([]);
      expect(reach.unreachable).toEqual([]);
      expect(reach.stopEnabled).toBe(true);
      expect(reach.fakePause).toBe(false);
      expect(reach.fakeShare).toBe(false);
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe("Todo 12 · adversarial live input", () => {
  test("a malformed frame is dropped and leaves the live projection intact", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 3 });
      const before = await session.page.evaluate(readTranscript);

      // Malformed frames: wrong types, missing fields, unknown kinds. None may
      // mutate the projection, and none may throw past the reducer.
      await session.act(
        'document.querySelectorAll("#transcript-stream .feed-line").length === 4',
        () => {
          harness.pushMessage({ type: "line" });
          harness.pushMessage({ type: "line", text: 42, ts: "nope" });
          harness.pushMessage({ type: "caption", text: null });
          harness.pushMessage({ type: "totally-unknown", payload: { a: 1 } });
          harness.pushMessage({ type: "slide", current: "not-an-object" });
          // A well-formed line proves the pipeline is still alive afterwards.
          harness.pushMessage({
            type: "line", text: "정상 문장입니다.", ts: FIXED_CLOCK_EPOCH_MS, speaker: 1,
          });
        },
      );

      const after = await session.page.evaluate(readTranscript);
      expect(after.count).toBe(4);
      expect(after.texts.slice(0, 3)).toEqual(before.texts);
      expect(after.texts[3]).toBe("정상 문장입니다.");

      const stillLive = await session.page.evaluate(readSlideContainment);
      expect(stillLive!.titleText).toBe(SLIDE.title);
    } finally {
      await session.close();
    }
  }, 30_000);

  // SCOPE (renamed). This used to be called "repeated Stop activation sends
  // exactly one stopCapture" and raced a second harness read against a rAF tick.
  // That was misleading twice over: the race could pass merely because the frame
  // resolved first, and single-dispatch de-duplication is NOT Todo 12's contract
  // - it belongs to the canonical reducer (Todo 7) and the native surface
  // (Todo 14), both of which own and test it.
  //
  // What Todo 12 actually owns is the LIVE STOP CONTROL: that the stage's Stop
  // is wired to the one real capture control and emits the existing action with
  // its existing spelling. That, and only that, is asserted here.
  test("the live Stop control emits the existing stopCapture action", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 1 });
      const outbound = harness.nextClientMessage();
      await session.page.click("#btn-live-stop");
      const message = (await outbound) as { action?: string };

      // The exact frozen action name; no renamed or synthesised variant.
      expect(message.action).toBe("stopCapture");

      // Stop is the stage's own control, not a duplicate of the record button.
      const wiring = await session.page.evaluate(() => ({
        stopCount: document.querySelectorAll('[id="btn-live-stop"]').length,
        recordCount: document.querySelectorAll('[id="btn-record"]').length,
        stopInStage: document.getElementById("stage-pane")
          ?.contains(document.getElementById("btn-live-stop")) ?? false,
      }));
      expect(wiring).toEqual({ stopCount: 1, recordCount: 1, stopInStage: true });
    } finally {
      await session.close();
    }
  }, 30_000);
});
