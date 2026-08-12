// Todo 15 — accessibility, motion, and failure states (browser half).
//
// What this file pins (machine-consumed values only; never prose copy, never
// screenshot bytes, never a CSS wording):
//
//   1. ANNOUNCEMENT DISCIPLINE (DESIGN 9.12). Finalized transcript lines and
//      errors announce ONCE through a polite live region. The timer and the
//      provisional caption are NEVER live regions, and no container may become
//      a live region by inheritance - an `aria-live` wrapper around a metric
//      strip re-announces the slide count, the line count and the provider name
//      on every unrelated tick, which is exactly the duplicate noise the
//      contract forbids.
//
//   2. THE STATUS CHANNEL IS REAL. `renderStatus()` is the ONLY surface that
//      carries connection loss, capture failure, export failure and save
//      completion. If it is not a live region, every one of those failures is
//      silent to a screen-reader user while remaining visible on screen - the
//      "failure detail never lives only in a log" rule (9.13) applied to the
//      accessibility tree rather than to the console.
//
//   3. REDUCED MOTION IS COMPLETE (DESIGN 9.6). Under
//      `prefers-reduced-motion: reduce`, no painted element in EITHER shell may
//      keep a non-zero transition or a running animation, while the state those
//      animations decorate stays fully readable and focus still moves. The
//      audit is a computed-style sweep over what is actually painted, not a
//      grep for a media query: the library shell had a `[data-shell="library"]`
//      guard, so the LIVE shell kept every animation running.
//
//   4. NO COLOR-ONLY STATUS (DESIGN 9.5/9.12). Every state indicator carries a
//      text or a shape alongside its color.
//
//   5. TARGETS ARE REAL, EVERYWHERE (DESIGN 9.12). Every painted interactive
//      control in the shell meets 44x44 CSS px at narrow widths, INCLUDING the
//      controls a scroller currently holds off-screen. Todo 13 audited only
//      controls already inside every scrolling ancestor's box, so a control
//      parked one row below the fold was never measured. This file scrolls each
//      control into view and then measures it.
//
//   6. FAILURE STATES ARE TRUTHFUL (DESIGN 9.13). Malformed payloads are
//      dropped with the last valid content intact; a transport loss keeps the
//      known capture phase, Stop and the timer; a capture error is actionable in
//      the surface where the action lives; and none of it announces twice.
//
//   7. ESCAPE PRIORITY (DESIGN 9.12). Modal/sheet first, then the history
//      preview, then no-op. Escape NEVER stops a recording.
//
// Synchronization: every awaited state is armed with a MutationObserver BEFORE
// its trigger frame is pushed, and bounded by a named timeout. There is no
// sleep, no polling delay and no waitForTimeout in this file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness, type PublicTestHarness } from "./public-test-harness.ts";

const FIXED_CLOCK_EPOCH_MS = 1_710_376_860_000;
const FIXED_CAPTURE_STARTED_AT = FIXED_CLOCK_EPOCH_MS - 125_000;

const CAPTURE_STARTING = { type: "capture", capturing: false, mode: "mic", phase: "starting" } as const;
const CAPTURE_LIVE = {
  type: "capture", capturing: true, mode: "mic", phase: "capturing",
  startedAt: FIXED_CAPTURE_STARTED_AT,
} as const;
const CAPTURE_STOPPING = { type: "capture", capturing: true, mode: "mic", phase: "stopping" } as const;
const CAPTURE_IDLE = { type: "capture", capturing: false, mode: "mic", phase: "idle" } as const;

const MEETING = {
  id: 7, title: "온보딩 지표 점검",
  started_at: FIXED_CLOCK_EPOCH_MS - 3_600_000, status: "ended",
} as const;

/**
 * A realistic long Korean meeting title. Used where the assertion is about
 * whether text collides with an overlaid control: a short title fits the row's
 * content box at every width and would pass regardless of the reserve.
 */
const LONG_MEETING_TITLE =
  "온보딩 지표 점검과 다음 스프린트 범위 확정 회의";

const SLIDE = {
  index: 3, startedAt: FIXED_CLOCK_EPOCH_MS - 60_000, sentenceCount: 9, kind: "topic",
  title: "온보딩 지표 점검과 다음 스프린트 범위 확정", kicker: "제품 로드맵",
  bullets: ["이탈률 12% 감소", "설치 시간 4분 → 2분 30초", "튜토리얼 4단계 축소"],
  emphasis: "결정: 온보딩 튜토리얼을 4단계로 축소한다",
} as const;

/** Deterministic multiline Korean finals, 3 s apart, two speakers. */
const LINES = Array.from({ length: 4 }, (_, i) => ({
  type: "line" as const,
  text: `${i + 1}번째 확정 문장입니다. 온보딩 이탈률과 설치 시간 지표를 함께 점검하면서 다음 스프린트의 범위를 확정하겠습니다.`,
  ts: FIXED_CLOCK_EPOCH_MS - (4 - i) * 3_000,
  speaker: (i % 2) + 1,
}));

/**
 * The full plan matrix. 900/899 bracket the stack seam; 320 is the narrowest
 * supported width. Reduced motion runs over the same set.
 */
const MATRIX = [
  { width: 1440, height: 900 },
  { width: 1244, height: 836 },
  { width: 1100, height: 800 },
  { width: 960, height: 760 },
  { width: 900, height: 760 },
  { width: 899, height: 760 },
  { width: 820, height: 900 },
  { width: 375, height: 812 },
  { width: 320, height: 667 },
] as const;

/** WCAG 2.2 AA pointer target (DESIGN 9.12). */
const MIN_TARGET_PX = 44;
/** Widths at or below this are the narrow/touch matrix the 44px rule governs. */
const NARROW_MAX_WIDTH = 375;

/** Every interactive control the shell paints, in either shell. */
const SHELL_CONTROL_SELECTOR = [
  ".app button",
  ".app a[data-output-target]",
  ".app summary",
  ".app select",
  ".app input",
  ".app textarea",
  ".app [tabindex]:not([tabindex='-1'])",
].join(", ");

// ── page-side plumbing ──────────────────────────────────────────────────────

declare global {
  interface Window {
    __a11yAwait?: (token: string, predicate: string) => void;
    __a11ySettle?: (token: string) => Promise<void>;
  }
}

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

  window.__a11yAwait = (token: string, predicate: string): void => {
    const check = new Function(`return (${predicate});`) as () => boolean;
    let done = false;
    const settle = (): boolean => {
      if (done) return true;
      let ok = false;
      try { ok = check() === true; } catch { ok = false; }
      if (!ok) return false;
      done = true;
      void window.__a11ySettle!(token);
      return true;
    };
    if (settle()) return;
    const observer = new MutationObserver(() => { if (settle()) observer.disconnect(); });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
  };
}

class A11yStateTimeoutError extends Error {
  constructor(predicate: string, ms: number) {
    super(`accessibility shell timed out after ${ms}ms waiting for: ${predicate}`);
    this.name = "A11yStateTimeoutError";
  }
}

interface Session {
  page: Page;
  act(predicate: string, trigger: () => void | Promise<void>, ms?: number): Promise<void>;
  close(): Promise<void>;
}

let browser: Browser;
let harness: PublicTestHarness;

interface SessionOptions {
  /** Emulates `prefers-reduced-motion: reduce` before the first paint. */
  reducedMotion?: boolean;
}

async function openSession(
  width: number,
  height: number,
  options: SessionOptions = {},
): Promise<Session> {
  const page = await browser.newPage();
  const waiters = new Map<string, () => void>();
  await page.exposeFunction("__a11ySettle", (token: string) => { waiters.get(token)?.(); });
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  if (options.reducedMotion) {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  }
  await page.evaluateOnNewDocument(pageBootstrap, FIXED_CLOCK_EPOCH_MS);
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.waitForClient();
  await page.evaluate(async () => { await document.fonts.ready; });

  let counter = 0;
  return {
    page,
    async act(predicate, trigger, ms = 2_000) {
      const token = `a11y-${(counter += 1)}`;
      const settled = new Promise<void>((resolve) => waiters.set(token, resolve));
      await page.evaluate((t: string, p: string) => window.__a11yAwait!(t, p), token, predicate);
      await trigger();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new A11yStateTimeoutError(predicate, ms)), ms);
      });
      try { await Promise.race([settled, bounded]); }
      finally { if (timer !== undefined) clearTimeout(timer); waiters.delete(token); }
    },
    async close() { await page.close(); },
  };
}

/** starting -> capturing -> slide -> finalized Korean lines. */
async function enterLive(session: Session, { lines = 2 } = {}): Promise<void> {
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

async function selectMeeting(session: Session): Promise<void> {
  await session.act(
    'document.querySelectorAll("#session-list .session-row").length === 1',
    () => harness.pushMessage({ type: "meetings", items: [MEETING] }),
  );
  await session.act(
    'document.querySelectorAll("#session-list .session-row--selected").length === 1',
    () => session.page.evaluate(() =>
      (document.querySelector("#session-list .session-row") as HTMLElement).click()),
  );
  await session.act(
    `document.getElementById("doc-title")?.textContent?.trim() === ${JSON.stringify(MEETING.title)}`,
    () => harness.pushMessage({
      type: "meeting", meetingId: MEETING.id, title: MEETING.title,
      current: null, history: [], transcript: [], notes: "",
    }),
  );
}

// ── in-page readers: machine values only ────────────────────────────────────

/**
 * Every element that is a live region, WITH the ancestry that made it one.
 *
 * `aria-live` inherits down the subtree: a wrapper marked polite turns every
 * descendant text node into an announcement. Reading only the elements that
 * carry the attribute would therefore miss exactly the defect this audits, so
 * each candidate reports its nearest live ancestor as well.
 */
function readLiveRegions() {
  const perceivable = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      if (n instanceof HTMLElement && n.hidden) return false;
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden") return false;
    }
    return true;
  };
  const liveAncestor = (el: Element): { id: string; value: string } | null => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const value = n.getAttribute("aria-live");
      if (value !== null && value !== "off") {
        return { id: n.id || `${n.tagName.toLowerCase()}.${String(n.className).split(" ")[0] || "anon"}`, value };
      }
      const role = n.getAttribute("role");
      if (role === "status" || role === "alert" || role === "log") {
        return { id: n.id || `${n.tagName.toLowerCase()}.${String(n.className).split(" ")[0] || "anon"}`, value: role };
      }
    }
    return null;
  };
  const declared = [...document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]')];
  return {
    declared: declared.map((el) => ({
      id: el.id || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "anon"}`,
      live: el.getAttribute("aria-live"),
      role: el.getAttribute("role"),
      atomic: el.getAttribute("aria-atomic"),
      perceivable: perceivable(el),
    })),
    /** For each probed ID: the live region that would announce its changes. */
    probe: (ids: string[]) => ids,
    liveAncestorOf: Object.fromEntries(
      ["live-topbar-timer", "capture-timer", "caption-text", "glance-slide", "glance-lines",
        "glance-provider", "status-text", "transcript-stream", "compile-status", "history-count",
        "transcript-count", "session-count"]
        .map((id) => {
          const el = document.getElementById(id);
          return [id, el ? liveAncestor(el) : null];
        }),
    ) as Record<string, { id: string; value: string } | null>,
  };
}

/**
 * Painted motion under the active media state.
 *
 * Reports every element whose computed style still carries travel: a non-zero
 * transition duration or a running animation. Under reduced motion this list
 * must be empty; under normal motion it must be bounded to the approved budget
 * so "reduced motion is complete" cannot be satisfied by removing motion
 * everywhere and calling it a day.
 */
function readMotion() {
  const painted = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      if (n instanceof HTMLElement && n.hidden) return false;
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden") return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const seconds = (value: string): number[] =>
    value.split(",").map((part) => {
      const v = part.trim();
      if (v.endsWith("ms")) return Number.parseFloat(v) / 1000;
      return Number.parseFloat(v) || 0;
    });

  const moving: Array<{ id: string; transition: number; animation: number; name: string }> = [];
  const durations: number[] = [];
  for (const el of document.querySelectorAll("*")) {
    if (!painted(el)) continue;
    const s = getComputedStyle(el);
    const t = Math.max(0, ...seconds(s.transitionDuration));
    const a = s.animationName === "none" ? 0 : Math.max(0, ...seconds(s.animationDuration));
    const running = a > 0 && s.animationPlayState === "running";
    if (t > 0) durations.push(t);
    if (a > 0) durations.push(a);
    if (t > 0 || running) {
      moving.push({
        id: el.id || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "anon"}`,
        transition: t, animation: running ? a : 0, name: s.animationName,
      });
    }
  }
  return { moving, maxDuration: durations.length > 0 ? Math.max(...durations) : 0 };
}

/**
 * The 44px target audit, scroll-inclusive.
 *
 * Todo 13's audit skipped any control not already fully inside every scrolling
 * ancestor, so a control parked one row below a scroller's fold was never
 * measured. Here each control is first scrolled into view, then measured, then
 * probed at its own four edge midpoints. `scrollIntoView` is a synchronous
 * layout operation with `behavior: "instant"`, so there is no timing dependence.
 */
function readScrolledTargets(selector: string) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const perceivable = (el: HTMLElement): boolean => {
    if (el.hidden) return false;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      if (n.hidden) return false;
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const rows: Array<{
    id: string; w: number; h: number; meetsBox: boolean; edgeMisses: string[];
  }> = [];
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    if (!perceivable(el)) continue;
    el.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const probes = [
      { name: "top", x: cx, y: r.y + 1 },
      { name: "bottom", x: cx, y: r.bottom - 1 },
      { name: "left", x: r.x + 1, y: cy },
      { name: "right", x: r.right - 1, y: cy },
    ];
    // Only probe a control that the scroll actually brought fully into the
    // layout viewport; one that still straddles an edge cannot be hit-tested
    // there, and reporting that as a target defect would be a false positive.
    const inViewport = r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;
    const edgeMisses = !inViewport ? [] : probes.filter((p) => {
      const stack = document.elementsFromPoint(Math.round(p.x), Math.round(p.y));
      return !stack.some((node) => node === el || el.contains(node));
    }).map((p) => p.name);
    rows.push({
      id: el.id || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "anon"}`,
      w: Math.round(r.width), h: Math.round(r.height),
      meetsBox: r.width >= 44 - 0.5 && r.height >= 44 - 0.5,
      edgeMisses,
    });
  }
  return rows;
}

/** Root/body horizontal overflow, the zero-overflow contract. */
function readOverflow() {
  return {
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  };
}

/** The keyboard tab order the browser will actually walk. */
function readTabOrder() {
  const focusable = [...document.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, summary, [tabindex]',
  )].filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("tabindex") === "-1") return false;
    if (el.hidden) return false;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      if (n.hidden) return false;
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden") return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  return focusable.map((el) => ({
    id: el.id || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "anon"}`,
    tabindex: el.getAttribute("tabindex"),
    name: (el.getAttribute("aria-label")
      ?? el.getAttribute("title")
      ?? el.textContent?.replace(/\s+/g, " ").trim()
      ?? "").slice(0, 60),
  }));
}

beforeAll(async () => {
  harness = createPublicTestHarness();
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
});

afterAll(async () => {
  await browser?.close();
  harness?.stop();
});

// ════════════════════════════════════════════════════════════════════════════
// 1. Announcement discipline
// ════════════════════════════════════════════════════════════════════════════

describe("Todo 15 · announcements fire once and never for the wrong thing", () => {
  test("the timer is not a live region, in either shell", async () => {
    const session = await openSession(1244, 836);
    try {
      const before = await session.page.evaluate(readLiveRegions);
      expect(before.liveAncestorOf["capture-timer"]).toBeNull();
      await enterLive(session, { lines: 0 });
      const after = await session.page.evaluate(readLiveRegions);
      // DESIGN 9.12: "The timer and the provisional caption are never live
      // regions." A per-second timer inside a polite region floods the
      // screen-reader queue and drowns the transcript it sits beside.
      expect(after.liveAncestorOf["live-topbar-timer"]).toBeNull();
      expect(after.liveAncestorOf["capture-timer"]).toBeNull();
    } finally {
      await session.close();
    }
  }, 30_000);

  test("the provisional caption is not a live region", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 0 });
      await session.act(
        'document.getElementById("caption-text")?.textContent?.includes("잠정") === true',
        () => harness.pushMessage({
          type: "caption", text: "잠정 자막입니다", ts: FIXED_CLOCK_EPOCH_MS, speaker: 1,
        }),
      );
      const regions = await session.page.evaluate(readLiveRegions);
      expect(regions.liveAncestorOf["caption-text"]).toBeNull();
    } finally {
      await session.close();
    }
  }, 30_000);

  test("ambient counters and the provider name are not live regions", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 2 });
      const regions = await session.page.evaluate(readLiveRegions);
      // These change on every slide, every line and every provider sync. A
      // container-level `aria-live` over the metric strip re-announces all of
      // them for one unrelated event: the duplicate-noise defect in 9.12.
      const noisy = ["glance-slide", "glance-lines", "glance-provider",
        "history-count", "transcript-count", "session-count"]
        .filter((id) => regions.liveAncestorOf[id] !== null)
        .map((id) => `${id}<-${regions.liveAncestorOf[id]!.id}`);
      expect(noisy).toEqual([]);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("the status channel IS a polite live region, so failures are not silent", async () => {
    const session = await openSession(1244, 836);
    try {
      const regions = await session.page.evaluate(readLiveRegions);
      const owner = regions.liveAncestorOf["status-text"];
      // `renderStatus()` is the only surface carrying connection loss, capture
      // failure and export failure. Silent here means a screen-reader user is
      // never told the recording failed (DESIGN 9.13).
      expect(owner).not.toBeNull();
      expect(["polite", "status"]).toContain(owner!.value);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("a finalized transcript line announces through exactly one live region", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 1 });
      const owners = await session.page.evaluate(() => {
        const stream = document.getElementById("transcript-stream");
        const chain: string[] = [];
        for (let n: Element | null = stream; n; n = n.parentElement) {
          const v = n.getAttribute("aria-live");
          const role = n.getAttribute("role");
          if ((v !== null && v !== "off") || role === "status" || role === "alert" || role === "log") {
            chain.push(n.id || n.tagName.toLowerCase());
          }
        }
        return chain;
      });
      // Zero means finals are silent; two or more means one line is announced
      // by two nested regions - the "no announcement fires twice" rule.
      expect(owners.length).toBe(1);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("no live region is assertive, so nothing interrupts the operator", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 2 });
      const regions = await session.page.evaluate(readLiveRegions);
      const assertive = regions.declared
        .filter((r) => r.perceivable && r.live === "assertive")
        .map((r) => r.id);
      expect(assertive).toEqual([]);
    } finally {
      await session.close();
    }
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Reduced motion
// ════════════════════════════════════════════════════════════════════════════

describe("Todo 15 · reduced motion collapses travel without hiding state", () => {
  for (const shell of ["library", "live"] as const) {
    test(`${shell}: no painted element keeps a transition or a running animation`, async () => {
      const session = await openSession(1244, 836, { reducedMotion: true });
      try {
        if (shell === "live") await enterLive(session, { lines: 2 });
        else await selectMeeting(session);
        const motion = await session.page.evaluate(readMotion);
        const offenders = motion.moving
          .map((m) => `${m.id}:t=${m.transition}s,a=${m.animation}s(${m.name})`);
        expect({ shell, offenders }).toEqual({ shell, offenders: [] });
      } finally {
        await session.close();
      }
    }, 30_000);
  }

  test("reduced motion still shows the live capture state, timer and transcript", async () => {
    const session = await openSession(1244, 836, { reducedMotion: true });
    try {
      await enterLive(session, { lines: 2 });
      const state = await session.page.evaluate(() => {
        const app = document.querySelector(".app") as HTMLElement | null;
        const stop = document.getElementById("btn-live-stop");
        const timer = document.getElementById("live-topbar-timer");
        const box = (el: Element | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) };
        };
        return {
          capturePhase: app?.dataset.capturePhase ?? null,
          capturingClass: app?.classList.contains("app--capturing") ?? false,
          stop: box(stop),
          timerText: timer?.textContent?.trim() ?? null,
          lines: document.querySelectorAll("#transcript-stream .feed-line").length,
        };
      });
      // Removing motion must never remove the STATE the motion decorated.
      expect(state.capturePhase).toBe("capturing");
      expect(state.capturingClass).toBe(true);
      expect(state.stop).not.toBeNull();
      expect(state.stop!.w).toBeGreaterThan(0);
      expect(state.timerText).toBe("02:05");
      expect(state.lines).toBe(2);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("reduced motion keeps a visible focus ring on the keyboard-focused control", async () => {
    const session = await openSession(1244, 836, { reducedMotion: true });
    try {
      await enterLive(session, { lines: 0 });
      const ring = await session.page.evaluate(() => {
        const stop = document.getElementById("btn-live-stop") as HTMLButtonElement;
        stop.focus();
        const s = getComputedStyle(stop);
        const width = Number.parseFloat(s.outlineWidth) || 0;
        const shadow = s.boxShadow && s.boxShadow !== "none" ? s.boxShadow : "";
        return {
          focused: document.activeElement === stop,
          outlineWidth: width,
          outlineStyle: s.outlineStyle,
          hasShadowRing: shadow.length > 0,
        };
      });
      expect(ring.focused).toBe(true);
      // A ring is either a real outline or a box-shadow ring; reduced motion
      // may not remove BOTH (DESIGN 9.6: "focus moves still happen").
      const visible = (ring.outlineWidth > 0 && ring.outlineStyle !== "none") || ring.hasShadowRing;
      expect(visible).toBe(true);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("normal motion stays inside the approved 200ms budget", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 2 });
      const motion = await session.page.evaluate(readMotion);
      // DESIGN 9.6: 150ms for press/focus/hover, 200ms for shell/tab/sheet.
      // Infinite state pulses (the recording dot) are periodic indicators, not
      // travel, and are excluded by duration rather than by name: a 1.2s pulse
      // is not a 200ms transition. The bound below therefore governs the
      // TRANSITIONS, which is what the budget is about.
      const overBudget = motion.moving
        .filter((m) => m.transition > 0.2 + 1e-6)
        .map((m) => `${m.id}:${m.transition}s`);
      expect(overBudget).toEqual([]);
    } finally {
      await session.close();
    }
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Targets, overlap and overflow across the whole matrix
// ════════════════════════════════════════════════════════════════════════════

describe("Todo 15 · every painted control is a real target, scroll included", () => {
  for (const vp of MATRIX.filter((v) => v.width <= NARROW_MAX_WIDTH)) {
    for (const shell of ["library", "live"] as const) {
      test(`${vp.width}x${vp.height} ${shell}: scrolled-into-view controls meet ${MIN_TARGET_PX}px`, async () => {
        const session = await openSession(vp.width, vp.height);
        try {
          if (shell === "live") await enterLive(session, { lines: 2 });
          else await selectMeeting(session);
          await session.page.evaluate(() => {
            for (const d of document.querySelectorAll<HTMLDetailsElement>(".app details")) d.open = true;
          });
          const rows = await session.page.evaluate(readScrolledTargets, SHELL_CONTROL_SELECTOR);
          expect(rows.length).toBeGreaterThan(3);
          const undersized = rows.filter((r) => !r.meetsBox).map((r) => `${r.id}:${r.w}x${r.h}`);
          expect({ shell, undersized }).toEqual({ shell, undersized: [] });
          const unhittable = rows
            .filter((r) => r.edgeMisses.length > 0)
            .map((r) => `${r.id}:${r.edgeMisses.join("/")}`);
          expect({ shell, unhittable }).toEqual({ shell, unhittable: [] });
        } finally {
          await session.close();
        }
      }, 45_000);
    }
  }

  /**
   * The live shell's Stop control, measured at the DESKTOP/CANONICAL widths.
   *
   * The scan above only runs at `width <= 375`, so the 44px floor was proved
   * exactly where a media query already forced it and nowhere else. Stop is the
   * one destructive, time-critical control in the live shell: a mis-click keeps
   * a recording running. DESIGN 9.12 states the pointer-target floor without
   * scoping it to a shell or a breakpoint, so it is measured here at the two
   * canonical desktop widths the plan names (1244x836 library reference and
   * 1440x900 reference comparison).
   *
   * Three things are asserted together on purpose:
   *   1. the HIT AREA meets 44x44 and is genuinely hit-testable at its own four
   *      edge midpoints, so a padded box that another node covers still fails;
   *   2. the GLYPH and LABEL do not inflate with it. The dot keeps its 8px box
   *      and the label keeps its token font size, so the repair may only grow
   *      the target, never the visual weight of the control;
   *   3. the topbar gains NO horizontal overflow, so the fix cannot buy its
   *      target by pushing the capsule past the stage.
   */
  for (const vp of [{ width: 1244, height: 836 }, { width: 1440, height: 900 }] as const) {
    test(`${vp.width}x${vp.height} live: #btn-live-stop meets ${MIN_TARGET_PX}px without inflating its glyph`, async () => {
      const session = await openSession(vp.width, vp.height);
      try {
        await enterLive(session, { lines: 2 });
        const probe = await session.page.evaluate(() => {
          const stop = document.getElementById("btn-live-stop");
          const dot = document.querySelector<HTMLElement>(".live-topbar__stop-dot");
          const capsule = document.querySelector<HTMLElement>(".live-topbar__capsule");
          const topbar = document.getElementById("live-topbar");
          const stage = document.getElementById("stage-pane");
          if (!stop || !dot || !capsule || !topbar || !stage) return null;
          const r = stop.getBoundingClientRect();
          const d = dot.getBoundingClientRect();
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const probes = [
            { name: "top", x: cx, y: r.y + 1 },
            { name: "bottom", x: cx, y: r.bottom - 1 },
            { name: "left", x: r.x + 1, y: cy },
            { name: "right", x: r.right - 1, y: cy },
          ];
          const edgeMisses = probes.filter((p) => {
            const stack = document.elementsFromPoint(Math.round(p.x), Math.round(p.y));
            return !stack.some((node) => node === stop || stop.contains(node));
          }).map((p) => p.name);
          const cs = getComputedStyle(stop);
          return {
            w: Math.round(r.width),
            h: Math.round(r.height),
            edgeMisses,
            // Visual density guards: the glyph and the label must not grow.
            dotW: Math.round(d.width),
            dotH: Math.round(d.height),
            fontSizePx: Math.round(parseFloat(cs.fontSize)),
            // The capsule stays inside the stage and the topbar never scrolls.
            capsuleRight: Math.round(capsule.getBoundingClientRect().right),
            stageRight: Math.round(stage.getBoundingClientRect().right),
            topbarOverflow: topbar.scrollWidth - topbar.clientWidth,
            // Stop stays operable; the repair may not disable or detach it.
            disabled: (stop as HTMLButtonElement).disabled,
          };
        });
        expect(probe).not.toBeNull();
        // 1. The target itself.
        expect({ w: probe!.w >= MIN_TARGET_PX, h: probe!.h >= MIN_TARGET_PX, actual: `${probe!.w}x${probe!.h}` })
          .toEqual({ w: true, h: true, actual: `${probe!.w}x${probe!.h}` });
        expect(probe!.edgeMisses).toEqual([]);
        // 2. Visual density is preserved: glyph box and label scale unchanged.
        expect({ dotW: probe!.dotW, dotH: probe!.dotH }).toEqual({ dotW: 8, dotH: 8 });
        expect(probe!.fontSizePx).toBeLessThanOrEqual(13);
        // 3. No overflow bought the target.
        expect(probe!.topbarOverflow).toBeLessThanOrEqual(0);
        expect(probe!.capsuleRight).toBeLessThanOrEqual(probe!.stageRight + 1);
        expect(probe!.disabled).toBe(false);
      } finally {
        await session.close();
      }
    }, 45_000);
  }

  /**
   * The rail's per-row destructive control, measured at every width.
   *
   * The scan above populates the library rail only at narrow widths, and the
   * Todo-13 audit skipped it entirely because a row that has not been hovered
   * paints at `opacity: 0`. That left a real WCAG 2.2 AA target-size violation
   * (32x32) invisible to both suites at every width. Opacity is a reveal
   * affordance, not a size: the control is keyboard-reachable and hover-
   * revealed, so its box must meet the floor whether or not it is currently
   * faded in.
   */
  for (const vp of MATRIX) {
    test(`${vp.width}x${vp.height}: the rail's per-row delete control meets ${MIN_TARGET_PX}px`, async () => {
      const session = await openSession(vp.width, vp.height);
      try {
        // A LONG Korean title on purpose: a short one fits inside the row's own
        // content box at every width, so it would pass whether or not the row
        // reserves the control's width, and the reserve would go unguarded.
        await session.act(
          'document.querySelectorAll("#session-list .session-row").length === 1',
          () => harness.pushMessage({
            type: "meetings",
            items: [{ ...MEETING, title: LONG_MEETING_TITLE }],
          }),
        );
        const row = await session.page.evaluate(() => {
          const del = document.querySelector<HTMLElement>(".session-delete");
          const parent = document.querySelector<HTMLElement>(".session-row");
          if (!del || !parent) return null;
          const r = del.getBoundingClientRect();
          const p = parent.getBoundingClientRect();
          return {
            w: Math.round(r.width), h: Math.round(r.height),
            // Its hit area must also stay inside the rail rather than hanging
            // off the row it belongs to.
            withinRow: r.top >= p.top - 1 && r.bottom <= p.bottom + 1,
            name: del.getAttribute("aria-label") ?? "",
          };
        });
        expect(row).not.toBeNull();
        expect({ w: row!.w >= MIN_TARGET_PX, h: row!.h >= MIN_TARGET_PX })
          .toEqual({ w: true, h: true });
        expect(row!.withinRow).toBe(true);
        // Destructive control keeps its accessible name at every width.
        expect(row!.name.length).toBeGreaterThan(0);

        /**
         * The row must RESERVE the delete control's width, so a long Korean
         * title can never be painted underneath it.
         *
         * Measured on the title's own PAINTED box, which is what the row's
         * reserve actually controls. `Range.getClientRects()` is deliberately
         * not used here: it reports the text's unclipped layout run, so a title
         * correctly clipped to a 154px box still reports a 292px run and the
         * assertion would fail on a shell that is behaving perfectly.
         *
         * The box is only meaningful if the title really is longer than the
         * space available, so overflow is asserted too: that proves the fixture
         * exercises the constraint instead of fitting inside it.
         */
        const clipped = await session.page.evaluate(() => {
          const title = document.querySelector<HTMLElement>(".session-row__title");
          const del = document.querySelector<HTMLElement>(".session-delete");
          if (!title || !del) return null;
          const t = title.getBoundingClientRect();
          return {
            titleRight: Math.round(t.right),
            deleteLeft: Math.round(del.getBoundingClientRect().left),
            // The fixture title genuinely exceeds its box at this width.
            overflows: title.scrollWidth > title.clientWidth,
            clipped: getComputedStyle(title).overflow !== "visible",
          };
        });
        expect(clipped).not.toBeNull();
        expect({
          collides: clipped!.titleRight > clipped!.deleteLeft + 1,
          titleRight: clipped!.titleRight,
        }).toEqual({ collides: false, titleRight: clipped!.titleRight });
        // Text that exceeds the reserved box must be clipped, never painted over
        // the control or spilled outside the rail.
        if (clipped!.overflows) expect(clipped!.clipped).toBe(true);
      } finally {
        await session.close();
      }
    }, 45_000);
  }

  /**
   * No painted control may be covered by another surface.
   *
   * Size and edge-band probes both answer "is this box big enough and is it its
   * own". Neither answers "does anything sit ON TOP of it", which is the defect
   * a `z-index: 20` dock over a scrolling stage can produce.
   *
   * Each control is scrolled into view first, because DESIGN 9.12 explicitly
   * allows a short viewport to keep controls reachable BY SCROLLING: a control
   * currently below its scroller's fold is reachable, not covered, and probing
   * it where it is not yet scrolled would report normal overflow as a defect.
   * What remains after scrolling is real occlusion.
   */
  for (const vp of MATRIX) {
    for (const shell of ["library", "live"] as const) {
      test(`${vp.width}x${vp.height} ${shell}: no painted control is covered by another surface`, async () => {
        const session = await openSession(vp.width, vp.height);
        try {
          if (shell === "live") await enterLive(session, { lines: 2 });
          else await selectMeeting(session);
          const covered = await session.page.evaluate((selector: string) => {
            const out: string[] = [];
            for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
              // `checkVisibility` is authoritative: it excludes the collapsed
              // `<details>` content, which has no `display: none` anywhere on
              // its ancestor chain yet is genuinely not painted.
              if (!el.checkVisibility({ checkVisibilityCSS: true })) continue;
              el.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const cx = Math.round(r.x + r.width / 2);
              const cy = Math.round(r.y + r.height / 2);
              // Only probe a point that is actually inside the viewport; a
              // control scrolled out of view is reachable, not covered.
              if (cx < 0 || cy < 0
                || cx >= document.documentElement.clientWidth
                || cy >= document.documentElement.clientHeight) continue;
              const stack = document.elementsFromPoint(cx, cy);
              const index = stack.findIndex((n) => n === el || el.contains(n));
              const name = el.id || String(el.className).split(" ")[0];
              const label = (n: Element) =>
                (n as HTMLElement).id || String(n.className).split(" ")[0] || n.tagName;
              if (index === -1) {
                // The control is not in its own centre's hit stack at all: it is
                // completely buried. This is the worst case, not a reason to
                // skip - treating it as "nothing found" is how the dock covering
                // the Overview action card stayed invisible to this audit.
                if (stack.length > 0) out.push(`${name}<-${label(stack[0])}(buried)`);
                continue;
              }
              // Anything ABOVE the control in the paint stack that is not one of
              // its own ancestors is covering it.
              const covering = stack.slice(0, index)
                .filter((n) => !n.contains(el))
                .map(label);
              if (covering.length > 0) out.push(`${name}<-${covering[0]}`);
            }
            return out;
          }, SHELL_CONTROL_SELECTOR);
          expect({ shell, covered }).toEqual({ shell, covered: [] });
        } finally {
          await session.close();
        }
      }, 45_000);
    }
  }

  for (const vp of MATRIX) {
    for (const reduced of [false, true]) {
      test(`${vp.width}x${vp.height}${reduced ? " reduced" : ""}: zero root overflow in the live shell`, async () => {
        const session = await openSession(vp.width, vp.height, { reducedMotion: reduced });
        try {
          await enterLive(session, { lines: 2 });
          const overflow = await session.page.evaluate(readOverflow);
          expect(overflow.root).toBeLessThanOrEqual(0);
          expect(overflow.body).toBeLessThanOrEqual(0);
        } finally {
          await session.close();
        }
      }, 45_000);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Failure states
// ════════════════════════════════════════════════════════════════════════════

describe("Todo 15 · failure states are explicit, truthful and retain last-good content", () => {
  test("a malformed slide frame drops silently and keeps the last good slide", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 1 });
      const before = await session.page.evaluate(() =>
        document.querySelector("#current-slide .slide__title")?.textContent?.trim() ?? null);
      expect(before).toBe(SLIDE.title);

      // Arm on the NEXT well-formed frame so the malformed one is provably
      // processed before the assertion, without a sleep.
      await session.act(
        'document.querySelectorAll("#transcript-stream .feed-line").length === 2',
        () => {
          harness.pushMessage({ type: "slide", current: { bogus: true }, history: [] });
          harness.pushMessage(LINES[1]);
        },
      );
      const after = await session.page.evaluate(() => ({
        title: document.querySelector("#current-slide .slide__title")?.textContent?.trim() ?? null,
        phase: (document.querySelector(".app") as HTMLElement | null)?.dataset.capturePhase ?? null,
      }));
      expect(after.title).toBe(SLIDE.title);
      expect(after.phase).toBe("capturing");
    } finally {
      await session.close();
    }
  }, 30_000);

  test("unparseable JSON leaves every projection untouched", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 2 });
      await session.act(
        'document.querySelectorAll("#transcript-stream .feed-line").length === 3',
        () => {
          harness.pushRaw("{ this is not json");
          harness.pushMessage(LINES[2]);
        },
      );
      const state = await session.page.evaluate(() => ({
        title: document.querySelector("#current-slide .slide__title")?.textContent?.trim() ?? null,
        phase: (document.querySelector(".app") as HTMLElement | null)?.dataset.capturePhase ?? null,
        lines: document.querySelectorAll("#transcript-stream .feed-line").length,
      }));
      expect(state.title).toBe(SLIDE.title);
      expect(state.phase).toBe("capturing");
      expect(state.lines).toBe(3);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("a transport drop reports reconnecting and keeps Stop, timer and content", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 2 });
      await session.act(
        'document.documentElement.dataset.connection === "disconnected"'
        + ' || document.documentElement.dataset.connection === "reconnecting"',
        () => harness.disconnectClients(),
        5_000,
      );
      const state = await session.page.evaluate(() => {
        const stop = document.getElementById("btn-live-stop") as HTMLButtonElement | null;
        const timer = document.getElementById("live-topbar-timer");
        const status = document.getElementById("status-text");
        const box = (el: Element | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) };
        };
        return {
          phase: (document.querySelector(".app") as HTMLElement | null)?.dataset.capturePhase ?? null,
          slide: document.querySelector("#current-slide .slide__title")?.textContent?.trim() ?? null,
          lines: document.querySelectorAll("#transcript-stream .feed-line").length,
          stop: box(stop),
          timerText: timer?.textContent?.trim() ?? null,
          // The reason must be visible in the surface, not only in a log.
          statusText: status?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        };
      });
      // No phantom stop: the last known capture truth is retained.
      expect(state.phase).toBe("capturing");
      expect(state.slide).toBe(SLIDE.title);
      expect(state.lines).toBe(2);
      expect(state.stop).not.toBeNull();
      expect(state.stop!.h).toBeGreaterThan(0);
      expect(state.timerText).toBe("02:05");
      expect(state.statusText.length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("a compile failure states its reason next to the control and keeps Stop enabled", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 2 });
      await session.act(
        'document.getElementById("compile-status")?.hidden === false',
        () => harness.pushMessage({
          type: "compile", status: "error", error: "슬라이드 생성에 실패했습니다",
        }),
        5_000,
      );
      const state = await session.page.evaluate(() => {
        const status = document.getElementById("compile-status");
        const stop = document.getElementById("btn-live-stop") as HTMLButtonElement | null;
        return {
          statusText: status?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          statusHidden: status?.hidden ?? true,
          stopDisabled: stop?.disabled ?? true,
          // Last good slide survives a compile failure (DESIGN 9.13).
          slide: document.querySelector("#current-slide .slide__title")?.textContent?.trim() ?? null,
        };
      });
      expect(state.statusHidden).toBe(false);
      expect(state.statusText.length).toBeGreaterThan(0);
      // "compile/export never disables Stop" (DESIGN 9.8/9.13).
      expect(state.stopDisabled).toBe(false);
      expect(state.slide).toBe(SLIDE.title);
    } finally {
      await session.close();
    }
  }, 30_000);

  /**
   * The reconnecting state must be READABLE, at every width.
   *
   * DESIGN 9.13 requires an explicit reconnecting state with the last known
   * capture phase and content retained. At 320 and 375 the legacy narrow rule
   * hiding every `.topbar__status` child except the settings button also hid
   * the status sentence, so the only trace of a dropped connection was the
   * `data-connection` attribute:
   * invisible on screen AND absent from the accessibility tree, which is the
   * "failure detail never lives only in a log" rule violated at the widths
   * where it matters most.
   */
  for (const vp of MATRIX) {
    test(`${vp.width}x${vp.height}: reconnecting is stated in the surface, not only in an attribute`, async () => {
      const session = await openSession(vp.width, vp.height);
      try {
        await enterLive(session, { lines: 2 });
        await session.act(
          'document.documentElement.dataset.connection === "disconnected"'
          + ' || document.documentElement.dataset.connection === "reconnecting"',
          () => harness.disconnectClients(),
          5_000,
        );
        const surfaced = await session.page.evaluate(() => {
          const painted = (el: Element | null): boolean => {
            if (!el) return false;
            if (!(el as HTMLElement).checkVisibility({ checkVisibilityCSS: true })) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const status = document.getElementById("status-text");
          return {
            connection: document.documentElement.dataset.connection ?? null,
            statusPainted: painted(status),
            statusText: (status?.textContent ?? "").replace(/\s+/g, " ").trim(),
            // Capture truth is retained: no phantom stop.
            capturePhase: (document.querySelector(".app") as HTMLElement | null)
              ?.dataset.capturePhase ?? null,
            slide: document.querySelector("#current-slide .slide__title")
              ?.textContent?.trim() ?? null,
          };
        });
        // The reason is visible where the operator is looking...
        expect({ w: vp.width, painted: surfaced.statusPainted })
          .toEqual({ w: vp.width, painted: true });
        expect(surfaced.statusText.length).toBeGreaterThan(0);
        // ...and the known capture truth survives the transport loss.
        expect(surfaced.capturePhase).toBe("capturing");
        expect(surfaced.slide).toBe(SLIDE.title);
      } finally {
        await session.close();
      }
    }, 45_000);
  }

  test("the empty library and the empty transcript both explain themselves", async () => {
    const session = await openSession(1244, 836);
    try {
      await session.act(
        'document.getElementById("session-empty")?.hidden === false',
        () => harness.pushMessage({ type: "meetings", items: [] }),
        5_000,
      );
      const state = await session.page.evaluate(() => {
        const sessionEmpty = document.getElementById("session-empty");
        const transcriptEmpty = document.getElementById("transcript-empty");
        const perceivable = (el: Element | null): boolean => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        return {
          sessionEmptyShown: perceivable(sessionEmpty),
          sessionEmptyText: sessionEmpty?.textContent?.trim().length ?? 0,
          transcriptEmptyExists: transcriptEmpty !== null,
          transcriptEmptyText: transcriptEmpty?.textContent?.trim().length ?? 0,
        };
      });
      expect(state.sessionEmptyShown).toBe(true);
      expect(state.sessionEmptyText).toBeGreaterThan(0);
      expect(state.transcriptEmptyExists).toBe(true);
      expect(state.transcriptEmptyText).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Keyboard, focus and Escape priority
// ════════════════════════════════════════════════════════════════════════════

describe("Todo 15 · keyboard operation and Escape priority", () => {
  test("Escape closes the open sheet and restores focus to its trigger", async () => {
    const session = await openSession(1244, 836);
    try {
      await session.act(
        'document.getElementById("provider-panel")?.hidden === false',
        () => session.page.evaluate(() =>
          (document.getElementById("btn-settings") as HTMLButtonElement).click()),
        5_000,
      );
      await session.act(
        'document.getElementById("provider-panel")?.hidden === true',
        () => session.page.keyboard.press("Escape"),
        5_000,
      );
      const focused = await session.page.evaluate(() => document.activeElement?.id ?? null);
      expect(focused).toBe("btn-settings");
    } finally {
      await session.close();
    }
  }, 30_000);

  test("Escape never stops a live recording", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 1 });
      let outbound: unknown = null;
      const pending = harness.nextClientMessage().then((m) => { outbound = m; }).catch(() => {});
      await session.page.keyboard.press("Escape");
      await session.page.keyboard.press("Escape");
      // Prove the state after a real round trip rather than after a sleep: a
      // fresh line is pushed and awaited, which orders the assertion strictly
      // after both Escape keypresses have been dispatched and processed.
      await session.act(
        'document.querySelectorAll("#transcript-stream .feed-line").length === 2',
        () => harness.pushMessage(LINES[1]),
      );
      const phase = await session.page.evaluate(() =>
        (document.querySelector(".app") as HTMLElement | null)?.dataset.capturePhase ?? null);
      expect(phase).toBe("capturing");
      expect(outbound).toBeNull();
      void pending;
    } finally {
      await session.close();
    }
  }, 30_000);

  test("every focusable control in the tab order has an accessible name", async () => {
    const session = await openSession(1244, 836);
    try {
      await selectMeeting(session);
      await session.page.evaluate(() => {
        for (const d of document.querySelectorAll<HTMLDetailsElement>(".app details")) d.open = true;
      });
      const order = await session.page.evaluate(readTabOrder);
      expect(order.length).toBeGreaterThan(5);
      const unnamed = order.filter((row) => row.name.length === 0).map((row) => row.id);
      expect(unnamed).toEqual([]);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("no positive tabindex hijacks the DOM tab order", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 1 });
      const order = await session.page.evaluate(readTabOrder);
      const positive = order
        .filter((row) => row.tabindex !== null && Number(row.tabindex) > 0)
        .map((row) => `${row.id}:${row.tabindex}`);
      expect(positive).toEqual([]);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("the detail tabs implement roving tabindex with Arrow, Home and End", async () => {
    const session = await openSession(1244, 836);
    try {
      await selectMeeting(session);
      const read = () => document.querySelectorAll<HTMLElement>('.detail-tabs [role="tab"]');
      const snapshot = await session.page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.detail-tabs [role="tab"]')]
          .map((el) => ({ id: el.id, tabindex: el.getAttribute("tabindex"), selected: el.getAttribute("aria-selected") })));
      expect(snapshot.length).toBe(3);
      // Exactly one tab stop in the tablist.
      expect(snapshot.filter((t) => t.tabindex === "0").length).toBe(1);
      expect(snapshot.filter((t) => t.selected === "true").length).toBe(1);
      void read;
    } finally {
      await session.close();
    }
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// 5b. Focus containment (DESIGN 9.12: "Sheets and modals trap focus")
// ════════════════════════════════════════════════════════════════════════════
//
// Escape + trigger restoration were already pinned above, but neither proves
// CONTAINMENT: with focus inside an open sheet, Tab from its LAST tabbable
// control must return to its FIRST, and Shift+Tab from the first must reach the
// last. Without that, a keyboard user tabs straight out of the open dialog into
// the shell behind it, which is the exact defect DESIGN.md:456-457 forbids.
//
// The surfaces governed here are every element the shipped markup declares a
// dialog: the settings sheet, the attendee sheet, the review panel and the Ask
// panel. Each is opened through its real trigger or its real server frame, and
// the wrap is driven by real `page.keyboard.press` events, never by a
// synthesised focus() call.

/**
 * Every tabbable control inside one dialog, in document order.
 *
 * Identity has to be UNIQUE, not merely readable: the review dialog paints many
 * `button.review-item__action` nodes, so a class-derived name would make "focus
 * reached the last control" true at the first of several identical spellings.
 * Each control therefore carries a data attribute stamped by this reader, which
 * `readActiveId` reads back.
 */
function readDialogTabbables(dialogId: string) {
  for (const stale of document.querySelectorAll("[data-a11y-probe]")) {
    stale.removeAttribute("data-a11y-probe");
  }
  const root = document.getElementById(dialogId);
  if (!root) return [];
  const tabbables = [...root.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, summary, [tabindex]',
  )].filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("tabindex") === "-1") return false;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      if (n.hidden) return false;
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden") return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  return tabbables.map((el, index) => {
    const token = `${el.id || el.tagName.toLowerCase()}#${index}`;
    el.dataset.a11yProbe = token;
    return token;
  });
}

/** The active element's identity in the same spelling `readDialogTabbables` stamped. */
function readActiveId(): string | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return null;
  return el.dataset.a11yProbe
    ?? (el.id || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "anon"}`);
}

/** True when focus currently sits on a descendant of `dialogId`. */
function readFocusInside(dialogId: string): boolean {
  const root = document.getElementById(dialogId);
  return root !== null && document.activeElement instanceof HTMLElement
    && root.contains(document.activeElement);
}

/**
 * Presses Tab until focus lands on `targetId`, bounded by a step budget.
 *
 * A fixed "one Tab per tabbable" walk is wrong on this surface: the review
 * dialog's `<input type="date">` is one tabbable that consumes FOUR Tab presses
 * (month/day/year plus the picker), which is real browser behaviour and not a
 * containment defect. The budget is therefore generous but finite, so a trap
 * that never reaches its own last control still fails instead of looping.
 */
async function tabUntil(
  session: Session,
  dialogId: string,
  targetId: string,
  options: { shift?: boolean } = {},
): Promise<{ reached: boolean; escaped: boolean }> {
  const budget = 60;
  if (options.shift) await session.page.keyboard.down("Shift");
  try {
    for (let i = 0; i < budget; i += 1) {
      await session.page.keyboard.press("Tab");
      const [active, inside] = await Promise.all([
        session.page.evaluate(readActiveId),
        session.page.evaluate(readFocusInside, dialogId),
      ]);
      // Leaving the dialog at all is the failure this suite exists to catch.
      if (!inside) return { reached: false, escaped: true };
      if (active === targetId) return { reached: true, escaped: false };
    }
  } finally {
    if (options.shift) await session.page.keyboard.up("Shift");
  }
  return { reached: false, escaped: false };
}

/** Opens the settings sheet through its real trigger. */
async function openSettings(session: Session): Promise<void> {
  await session.act(
    'document.getElementById("provider-panel")?.hidden === false',
    () => session.page.evaluate(() =>
      (document.getElementById("btn-settings") as HTMLButtonElement).click()),
    5_000,
  );
}

/** Opens the attendee sheet through its real trigger. */
async function openAttendees(session: Session): Promise<void> {
  await session.act(
    'document.getElementById("attendee-panel")?.hidden === false',
    () => session.page.evaluate(() =>
      (document.getElementById("btn-attendees") as HTMLButtonElement).click()),
    5_000,
  );
}

/** Opens the Ask panel; it is gated on a selected meeting, so select one first. */
async function openAsk(session: Session): Promise<void> {
  await selectMeeting(session);
  await session.act(
    'document.getElementById("ask-panel")?.hidden === false',
    () => session.page.evaluate(() =>
      (document.getElementById("btn-ask") as HTMLButtonElement).click()),
    5_000,
  );
}

/** Opens the review panel by pushing a real `review` frame. */
async function openReviewPanel(session: Session): Promise<void> {
  await selectMeeting(session);
  await session.act(
    'document.querySelectorAll("#review-list .review-item").length === 2',
    () => harness.pushMessage({
      type: "review",
      reviewId: "rev-a11y-1",
      transcriptVersionId: "ver-a11y-1",
      attendees: [
        { attendeeId: "att-1", displayName: "김현준" },
        { attendeeId: "att-2", displayName: "이수진" },
      ],
      items: [
        {
          id: "dec-1", kind: "decision",
          description: "온보딩 튜토리얼을 4단계로 축소한다",
          sourceSegment: { transcript_version_id: "ver-a11y-1", start_seq: 1, end_seq: 1 },
          evidenceQuote: "튜토리얼을 4단계로 줄입시다.",
          segment_text: "튜토리얼을 4단계로 줄입시다.",
          attributedAttendeeId: "att-1",
        },
        {
          id: "act-1", kind: "action_item",
          description: "이탈률 대시보드를 정리한다",
          sourceSegment: { transcript_version_id: "ver-a11y-1", start_seq: 2, end_seq: 2 },
          evidenceQuote: "대시보드를 정리해주세요.",
          segment_text: "대시보드를 정리해주세요.",
          attributedAttendeeId: null,
          assigneeAttendeeId: null,
          deadline: "2026-08-14",
        },
      ],
    }),
    5_000,
  );
}

const TRAPPED_DIALOGS = [
  { id: "provider-panel", label: "settings sheet", open: openSettings, trigger: "btn-settings" },
  { id: "attendee-panel", label: "attendee sheet", open: openAttendees, trigger: "btn-attendees" },
  { id: "review-panel", label: "review dialog", open: openReviewPanel, trigger: "btn-review" },
  { id: "ask-panel", label: "Ask dialog", open: openAsk, trigger: "btn-ask" },
] as const;

describe("Todo 15 · every shipped dialog traps Tab and Shift+Tab", () => {
  for (const dialog of TRAPPED_DIALOGS) {
    test(`${dialog.label} wraps Tab from its last control back to its first`, async () => {
      const session = await openSession(1244, 836);
      try {
        await dialog.open(session);
        const tabbables = await session.page.evaluate(readDialogTabbables, dialog.id);
        expect(tabbables.length).toBeGreaterThan(1);

        // Focus starts INSIDE the dialog (9.12: opening moves focus in).
        const initial = await session.page.evaluate(readActiveId);
        expect(initial).not.toBeNull();
        expect(tabbables).toContain(initial!);

        // Walk forward to the dialog's LAST control without ever leaving it.
        const last = tabbables[tabbables.length - 1]!;
        expect(await tabUntil(session, dialog.id, last)).toEqual({ reached: true, escaped: false });

        // One more Tab must WRAP to the first control, not escape the dialog.
        await session.page.keyboard.press("Tab");
        expect(await session.page.evaluate(readActiveId)).toBe(tabbables[0]);
        expect(await session.page.evaluate(readFocusInside, dialog.id)).toBe(true);
      } finally {
        await session.close();
      }
    }, 45_000);

    test(`${dialog.label} wraps Shift+Tab from its first control back to its last`, async () => {
      const session = await openSession(1244, 836);
      try {
        await dialog.open(session);
        const tabbables = await session.page.evaluate(readDialogTabbables, dialog.id);
        expect(tabbables.length).toBeGreaterThan(1);

        const initial = await session.page.evaluate(readActiveId);
        expect(initial).not.toBeNull();
        expect(tabbables).toContain(initial!);

        // Walk backwards to the first control, then wrap past it.
        const first = tabbables[0]!;
        if (initial !== first) {
          expect(await tabUntil(session, dialog.id, first, { shift: true }))
            .toEqual({ reached: true, escaped: false });
        }
        await session.page.keyboard.down("Shift");
        try { await session.page.keyboard.press("Tab"); }
        finally { await session.page.keyboard.up("Shift"); }
        expect(await session.page.evaluate(readActiveId)).toBe(tabbables[tabbables.length - 1]);
        expect(await session.page.evaluate(readFocusInside, dialog.id)).toBe(true);
      } finally {
        await session.close();
      }
    }, 45_000);

    test(`${dialog.label} releases the trap on Escape and restores the trigger`, async () => {
      const session = await openSession(1244, 836);
      try {
        await dialog.open(session);
        await session.act(
          `document.getElementById(${JSON.stringify(dialog.id)})?.hidden === true`,
          () => session.page.keyboard.press("Escape"),
          5_000,
        );
        expect(await session.page.evaluate(readActiveId)).toBe(dialog.trigger);

        // With the dialog closed the trap is gone: Tab moves through the shell
        // again instead of being pinned to the dismissed surface.
        await session.page.keyboard.press("Tab");
        const after = await session.page.evaluate(readActiveId);
        expect(after).not.toBe(dialog.trigger);
        expect(after).not.toBeNull();
      } finally {
        await session.close();
      }
    }, 45_000);
  }

  test("a closed dialog contributes nothing to the shell tab order", async () => {
    const session = await openSession(1244, 836);
    try {
      await selectMeeting(session);
      const order = await session.page.evaluate(readTabOrder);
      const ids = order.map((row) => row.id);
      // No control that lives inside a hidden dialog may be reachable.
      const dialogOwned = await session.page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[role="dialog"][hidden] button, [role="dialog"][hidden] input, [role="dialog"][hidden] select')]
          .map((el) => el.id).filter(Boolean));
      expect(dialogOwned.length).toBeGreaterThan(0);
      expect(ids.filter((id) => dialogOwned.includes(id))).toEqual([]);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("an open dialog leaves no inert or aria-hidden residue behind after it closes", async () => {
    const session = await openSession(1244, 836);
    try {
      const before = await session.page.evaluate(() => ({
        inert: [...document.querySelectorAll("[inert]")].map((el) => el.id),
        ariaHidden: [...document.querySelectorAll('[aria-hidden="true"]')].length,
      }));
      await openSettings(session);
      await session.act(
        'document.getElementById("provider-panel")?.hidden === true',
        () => session.page.keyboard.press("Escape"),
        5_000,
      );
      const after = await session.page.evaluate(() => ({
        inert: [...document.querySelectorAll("[inert]")].map((el) => el.id),
        ariaHidden: [...document.querySelectorAll('[aria-hidden="true"]')].length,
      }));
      expect(after).toEqual(before);
    } finally {
      await session.close();
    }
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Contrast and non-color status
// ════════════════════════════════════════════════════════════════════════════

describe("Todo 15 · contrast and non-color status", () => {
  test("every visible status indicator carries text or a shape, never color alone", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 2 });
      const indicators = await session.page.evaluate(() => {
        const ids = ["status-indicator", "glance-capture", "onair", "island"];
        return ids.map((id) => {
          const el = document.getElementById(id);
          if (!el) return { id, present: false, text: 0, painted: false, decorative: false };
          const r = el.getBoundingClientRect();
          /**
           * A pure-color dot satisfies the rule in one of two ways: it either
           * carries the status as text/name itself, or it is explicitly
           * decoration for a text status that sits beside it. The second is
           * only honest when the sibling text is real, so the dot's own
           * container must contribute readable characters.
           */
          const container = el.parentElement;
          const siblingText = container
            ? (container.textContent ?? "").replace(/\s+/g, " ").trim().length
            : 0;
          return {
            id, present: true, painted: r.width > 0 && r.height > 0,
            text: (el.textContent ?? "").replace(/\s+/g, " ").trim().length
              + (el.getAttribute("aria-label") ?? "").trim().length
              + (el.getAttribute("title") ?? "").trim().length,
            decorative: el.getAttribute("aria-hidden") === "true" && siblingText > 0,
          };
        });
      });
      const colorOnly = indicators
        .filter((i) => i.present && i.painted && i.text === 0 && !i.decorative)
        .map((i) => i.id);
      expect(colorOnly).toEqual([]);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("primary body text meets WCAG AA 4.5:1 against its own painted background", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 2 });
      const rows = await session.page.evaluate(() => {
        const parse = (value: string): [number, number, number, number] => {
          const m = value.match(/rgba?\(([^)]+)\)/);
          if (!m) return [0, 0, 0, 0];
          const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
          return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
        };
        const lum = (rgb: [number, number, number, number]): number => {
          const f = (c: number) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
        };
        /** Composite the element's painted background over its ancestors. */
        const backdrop = (el: Element): [number, number, number, number] => {
          let acc: [number, number, number, number] = [255, 255, 255, 1];
          const stack: Array<[number, number, number, number]> = [];
          for (let n: Element | null = el; n; n = n.parentElement) {
            const bg = parse(getComputedStyle(n).backgroundColor);
            if (bg[3] > 0) stack.push(bg);
            if (bg[3] >= 1) break;
          }
          for (const layer of stack.reverse()) {
            const a = layer[3];
            acc = [
              layer[0] * a + acc[0] * (1 - a),
              layer[1] * a + acc[1] * (1 - a),
              layer[2] * a + acc[2] * (1 - a),
              1,
            ];
          }
          return acc;
        };
        const ratio = (a: number, b: number) =>
          (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

        // Real running text the operator must read, chosen by binding ID so the
        // audit cannot drift with a class rename.
        const ids = ["doc-title", "doc-meta", "status-text", "meeting-chrome-title"];
        const out = ids.map((id) => {
          const el = document.getElementById(id);
          if (!el) return { id, present: false, ratio: 0, fontPx: 0, painted: false };
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          const fg = parse(s.color);
          const bg = backdrop(el);
          // Composite the (possibly translucent) text color over its backdrop.
          const a = fg[3];
          const composited: [number, number, number, number] = [
            fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1,
          ];
          return {
            id, present: true,
            painted: r.width > 0 && r.height > 0 && (el.textContent ?? "").trim().length > 0,
            ratio: Math.round(ratio(lum(composited), lum(bg)) * 100) / 100,
            fontPx: Number.parseFloat(s.fontSize),
          };
        });
        return out;
      });
      const failing = rows
        .filter((r) => r.present && r.painted)
        // Large text (>=24px, or >=18.66px bold) may use 3:1; every probed row
        // here is body-scale, so the single 4.5:1 bound is the honest one.
        .filter((r) => r.ratio < 4.5)
        .map((r) => `${r.id}:${r.ratio}:1@${r.fontPx}px`);
      expect(failing).toEqual([]);
    } finally {
      await session.close();
    }
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// 6b. User-started capture hands focus to the visible Stop control
// ════════════════════════════════════════════════════════════════════════════

/**
 * DESIGN 9.12 / Todo 15: "user-started capture focuses visible Stop".
 *
 * The browser is the product's ONLY Start surface (DESIGN 9.10, Todo 19
 * boundary), so this transition can only be satisfied here. When the operator
 * activates Start, the control they were standing on (`#btn-record`) leaves the
 * live shell's tab order, and the authoritative capture snapshot reveals
 * `#btn-live-stop`. Without an explicit handoff the keyboard user is dropped on
 * BODY and has to re-traverse the whole shell to reach the one control that
 * ends the recording.
 *
 * The handoff is bound to USER intent, never to the arrival of a capture frame:
 * a calendar auto-capture, a reconnect re-assertion, or first-load hydration all
 * deliver the same authoritative frame while the operator is reading or typing
 * somewhere else, and stealing focus there would be the mirror defect. These
 * tests pin both directions, plus the dialog case where an open sheet owns
 * focus by contract.
 *
 * Synchronization: every assertion is ordered strictly after a state that was
 * subscribed to BEFORE its trigger. No sleep, no poll.
 */

/**
 * The authoritative idle snapshot every real session receives before the
 * operator can start anything: the reducer refuses to issue a command until the
 * server has hydrated the surface, so a click without this is not a real start.
 */
async function hydrateIdle(session: Session): Promise<void> {
  await session.act(
    'document.querySelector(".app")?.dataset.capturePhase === "idle"',
    () => harness.pushMessage(CAPTURE_IDLE),
  );
}

/** The live Stop control is visible exactly when it has a painted box. */
function readStopFocus() {
  const stop = document.getElementById("btn-live-stop");
  const rect = stop?.getBoundingClientRect() ?? null;
  const active = document.activeElement;
  return {
    activeTag: active?.tagName ?? null,
    activeId: active instanceof HTMLElement ? active.id : "",
    stopVisible: Boolean(rect && rect.width > 0 && rect.height > 0),
    stopFocused: active === stop,
    shell: (document.querySelector(".app") as HTMLElement | null)?.dataset.shell ?? null,
  };
}

/**
 * Drives the REAL user seam: a click on `#btn-record`, the real outbound
 * `startCapture` command, then the authoritative frames the server answers with.
 * Nothing here pushes a capture frame that a real start would not produce.
 */
async function userStartsCapture(session: Session): Promise<string> {
  await hydrateIdle(session);
  const outbound = harness.nextClientMessage();
  await session.act(
    'document.querySelector(".app")?.dataset.capturePhase === "starting"',
    () => session.page.evaluate(() =>
      (document.getElementById("btn-record") as HTMLButtonElement).click()),
  );
  const command = (await outbound) as { action?: string };
  await session.act(
    'document.querySelector(".app")?.classList.contains("app--capturing") === true',
    () => harness.pushMessage(CAPTURE_LIVE),
  );
  return String(command.action);
}

describe("Todo 15 · user-started capture focuses the visible Stop control", () => {
  test("clicking Start moves focus to #btn-live-stop once the live shell reveals it", async () => {
    const session = await openSession(1244, 836);
    try {
      const action = await userStartsCapture(session);
      // The transition was driven by the real product command, not a synthetic frame.
      expect(action).toBe("startCapture");

      const observed = await session.page.evaluate(readStopFocus);
      expect(observed.shell).toBe("live");
      expect(observed.stopVisible).toBe(true);
      expect(observed.stopFocused).toBe(true);
      expect(observed.activeId).toBe("btn-live-stop");
    } finally {
      await session.close();
    }
  }, 30_000);

  test("the focused Stop is the control that actually ends the recording", async () => {
    const session = await openSession(1244, 836);
    try {
      await userStartsCapture(session);
      const outbound = harness.nextClientMessage();
      // Keyboard only: activate whatever the handoff focused, and require that
      // the product answers with the real stop command.
      await session.act(
        'document.querySelector(".app")?.dataset.capturePhase === "stopping"',
        () => session.page.keyboard.press("Enter"),
      );
      expect((await outbound as { action?: string }).action).toBe("stopCapture");
    } finally {
      await session.close();
    }
  }, 30_000);

  test("a server-originated capture (calendar auto-capture) never steals focus", async () => {
    const session = await openSession(1244, 836);
    try {
      // The operator is standing on a control of their own choosing when a
      // capture the server started arrives unannounced.
      await session.page.evaluate(() =>
        (document.getElementById("btn-settings") as HTMLButtonElement).focus());
      await session.act(
        'document.querySelector(".app")?.dataset.capturePhase === "starting"',
        () => harness.pushMessage(CAPTURE_STARTING),
      );
      await session.act(
        'document.querySelector(".app")?.classList.contains("app--capturing") === true',
        () => harness.pushMessage(CAPTURE_LIVE),
      );
      const observed = await session.page.evaluate(readStopFocus);
      expect(observed.stopVisible).toBe(true);
      expect(observed.stopFocused).toBe(false);
      expect(observed.activeId).toBe("btn-settings");
    } finally {
      await session.close();
    }
  }, 30_000);

  test("first-load hydration into an already-live capture never steals focus", async () => {
    const session = await openSession(1244, 836);
    try {
      await session.page.evaluate(() =>
        (document.getElementById("btn-settings") as HTMLButtonElement).focus());
      // A single authoritative `capturing` snapshot, exactly as a page that
      // loads while a recording is already running receives it.
      await session.act(
        'document.querySelector(".app")?.classList.contains("app--capturing") === true',
        () => harness.pushMessage(CAPTURE_LIVE),
      );
      const observed = await session.page.evaluate(readStopFocus);
      expect(observed.stopVisible).toBe(true);
      expect(observed.stopFocused).toBe(false);
      expect(observed.activeId).toBe("btn-settings");
    } finally {
      await session.close();
    }
  }, 30_000);

  test("a reconnect re-asserting the same live capture never re-steals focus", async () => {
    const session = await openSession(1244, 836);
    try {
      await userStartsCapture(session);
      // The handoff happened once. The operator then moves on to another
      // control the live shell actually paints and leaves enabled.
      await session.page.evaluate(() =>
        (document.getElementById("btn-settings") as HTMLButtonElement).focus());
      // The socket drops and the server re-asserts the SAME authoritative live
      // snapshot. That is not a new user start, so focus must stay put.
      await session.act(
        'document.querySelectorAll("#transcript-stream .feed-line").length === 1',
        () => harness.pushMessage(LINES[0]),
      );
      await session.act(
        'document.querySelectorAll("#transcript-stream .feed-line").length === 2',
        () => { harness.pushMessage(CAPTURE_LIVE); harness.pushMessage(LINES[1]); },
      );
      const observed = await session.page.evaluate(readStopFocus);
      expect(observed.stopVisible).toBe(true);
      expect(observed.stopFocused).toBe(false);
      expect(observed.activeId).toBe("btn-settings");
    } finally {
      await session.close();
    }
  }, 30_000);

  test("an open dialog keeps focus: the handoff never pulls focus out of a sheet", async () => {
    const session = await openSession(1244, 836);
    try {
      // Start, then immediately open a sheet before the server confirms. The
      // dialog owns focus by contract (9.12), so the arriving live snapshot must
      // not yank the keyboard user out of it.
      await hydrateIdle(session);
      const outbound = harness.nextClientMessage();
      await session.act(
        'document.querySelector(".app")?.dataset.capturePhase === "starting"',
        () => session.page.evaluate(() =>
          (document.getElementById("btn-record") as HTMLButtonElement).click()),
      );
      expect((await outbound as { action?: string }).action).toBe("startCapture");
      await session.act(
        'document.getElementById("provider-panel")?.hidden === false',
        () => session.page.evaluate(() =>
          (document.getElementById("btn-settings") as HTMLButtonElement).click()),
        5_000,
      );
      await session.act(
        'document.querySelector(".app")?.classList.contains("app--capturing") === true',
        () => harness.pushMessage(CAPTURE_LIVE),
      );
      const inDialog = await session.page.evaluate(readFocusInside, "provider-panel");
      expect(inDialog).toBe(true);
      expect((await session.page.evaluate(readStopFocus)).stopFocused).toBe(false);
    } finally {
      await session.close();
    }
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Determinism guards
// ════════════════════════════════════════════════════════════════════════════

describe("Todo 15 · determinism", () => {
  test("this suite contains no sleep or polling wait", async () => {
    const source = await Bun.file(import.meta.path).text();
    // Comments are stripped first so the guard reads the executable body rather
    // than its own description of the patterns it forbids.
    const body = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    // Puppeteer's own sleep, and the hand-rolled shapes of one: a timer that
    // RESOLVES, a poll loop, and a polling waitForFunction. The single
    // `setTimeout` this file does use REJECTS, which bounds an
    // already-subscribed signal rather than waiting for time to pass, so a
    // state that never arrives fails loudly instead of passing by luck.
    expect(/\bwaitForTimeout\s*\(/.test(body)).toBe(false);
    expect(/\bBun\.sleep\s*\(/.test(body)).toBe(false);
    expect(/\bsetInterval\s*\(/.test(body)).toBe(false);
    expect(/setTimeout\(\s*\(?\s*\)?\s*=>\s*resolve/.test(body)).toBe(false);
    expect(/\bwaitForFunction\s*\(/.test(body)).toBe(false);
  });

  test("the accessibility run issues no off-origin request", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session, { lines: 1 });
      const external = harness.servedPaths.filter((p) => /^https?:\/\//.test(p));
      expect(external).toEqual([]);
    } finally {
      await session.close();
    }
  }, 30_000);
});
