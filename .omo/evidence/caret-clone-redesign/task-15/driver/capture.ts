// Todo 15 QA capture driver.
//
// Walks the full plan matrix in normal AND reduced motion across the canonical
// states, and records for each cell:
//   * a same-size PNG screenshot,
//   * the Chromium accessibility tree (names/roles the AT actually receives),
//   * a machine geometry/motion/contrast record.
//
// This is EVIDENCE, not a test: it asserts nothing and never gates. The
// contracts are enforced by tests/public-caret-accessibility.test.ts; these
// captures exist so a human (and the visual-qa pass) can inspect the painted
// result for defects the assertions do not name.
//
// Determinism: frozen clock, ko-KR, Asia/Seoul, deviceScaleFactor 1, fixed
// fixture data, local harness only. Every awaited state is armed with a
// MutationObserver BEFORE its trigger; nothing sleeps or polls.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness, type PublicTestHarness } from "../../../../../tests/public-test-harness.ts";

const OUT = join(import.meta.dir, "..", "green", "qa");

const FIXED_CLOCK_EPOCH_MS = 1_710_376_860_000;
const FIXED_CAPTURE_STARTED_AT = FIXED_CLOCK_EPOCH_MS - 125_000;

const CAPTURE_STARTING = { type: "capture", capturing: false, mode: "mic", phase: "starting" } as const;
const CAPTURE_LIVE = {
  type: "capture", capturing: true, mode: "mic", phase: "capturing",
  startedAt: FIXED_CAPTURE_STARTED_AT,
} as const;

const MEETING = {
  id: 7, title: "온보딩 지표 점검",
  started_at: FIXED_CLOCK_EPOCH_MS - 3_600_000, status: "ended",
} as const;

const SLIDE = {
  index: 3, startedAt: FIXED_CLOCK_EPOCH_MS - 60_000, sentenceCount: 9, kind: "topic",
  title: "온보딩 지표 점검과 다음 스프린트 범위 확정", kicker: "제품 로드맵",
  bullets: ["이탈률 12% 감소", "설치 시간 4분 → 2분 30초", "튜토리얼 4단계 축소"],
  emphasis: "결정: 온보딩 튜토리얼을 4단계로 축소한다",
} as const;

const LINES = Array.from({ length: 4 }, (_, i) => ({
  type: "line" as const,
  text: `${i + 1}번째 확정 문장입니다. 온보딩 이탈률과 설치 시간 지표를 함께 점검하면서 다음 스프린트의 범위를 확정하겠습니다.`,
  ts: FIXED_CLOCK_EPOCH_MS - (4 - i) * 3_000,
  speaker: (i % 2) + 1,
}));

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1244x836", width: 1244, height: 836 },
  { name: "1100x800", width: 1100, height: 800 },
  { name: "960x760", width: 960, height: 760 },
  { name: "900x760", width: 900, height: 760 },
  { name: "899x760", width: 899, height: 760 },
  { name: "820x900", width: 820, height: 900 },
  { name: "375x812", width: 375, height: 812 },
  { name: "320x667", width: 320, height: 667 },
] as const;

/** The canonical states from DESIGN 9.13 this capture walks. */
type StateName =
  | "library" | "live" | "loading" | "empty" | "error" | "reconnect" | "compile";

const STATES: readonly StateName[] = [
  "library", "live", "loading", "empty", "error", "reconnect", "compile",
];

declare global {
  interface Window {
    __qaAwait?: (token: string, predicate: string) => void;
    __qaSettle?: (token: string) => Promise<void>;
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

  window.__qaAwait = (token: string, predicate: string): void => {
    const check = new Function(`return (${predicate});`) as () => boolean;
    let done = false;
    const settle = (): boolean => {
      if (done) return true;
      let ok = false;
      try { ok = check() === true; } catch { ok = false; }
      if (!ok) return false;
      done = true;
      void window.__qaSettle!(token);
      return true;
    };
    if (settle()) return;
    const observer = new MutationObserver(() => { if (settle()) observer.disconnect(); });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
  };
}

let browser: Browser;
let harness: PublicTestHarness;

interface Session {
  page: Page;
  act(predicate: string, trigger: () => void | Promise<void>, ms?: number): Promise<void>;
  close(): Promise<void>;
}

async function openSession(width: number, height: number, reduced: boolean): Promise<Session> {
  const page = await browser.newPage();
  const waiters = new Map<string, () => void>();
  await page.exposeFunction("__qaSettle", (token: string) => { waiters.get(token)?.(); });
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  if (reduced) {
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
    async act(predicate, trigger, ms = 5_000) {
      const token = `qa-${(counter += 1)}`;
      const settled = new Promise<void>((resolve) => waiters.set(token, resolve));
      await page.evaluate((t: string, p: string) => window.__qaAwait!(t, p), token, predicate);
      await trigger();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`QA timeout waiting for: ${predicate}`)), ms);
      });
      try { await Promise.race([settled, bounded]); }
      finally { if (timer !== undefined) clearTimeout(timer); waiters.delete(token); }
    },
    async close() { await page.close(); },
  };
}

async function enterLive(session: Session, lines = 2): Promise<void> {
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

async function reach(session: Session, state: StateName): Promise<void> {
  switch (state) {
    case "loading":
      // Booting/hydrating: the shell as served, before any server frame.
      return;
    case "empty":
      await session.act(
        'document.getElementById("session-empty")?.hidden === false',
        () => harness.pushMessage({ type: "meetings", items: [] }),
      );
      return;
    case "library":
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
      return;
    case "live":
      await enterLive(session);
      return;
    case "error":
      await enterLive(session);
      await session.act(
        'document.getElementById("status-text")?.textContent?.includes("오류") === true'
        + ' || document.getElementById("status-text")?.textContent?.includes("실패") === true',
        () => harness.pushMessage({ type: "status", text: "음성 인식 오류: 마이크 입력을 읽지 못했습니다" }),
      );
      return;
    case "reconnect":
      await enterLive(session);
      await session.act(
        'document.documentElement.dataset.connection === "disconnected"'
        + ' || document.documentElement.dataset.connection === "reconnecting"',
        () => harness.disconnectClients(),
      );
      return;
    case "compile":
      await enterLive(session);
      await session.act(
        'document.getElementById("compile-status")?.hidden === false',
        () => harness.pushMessage({
          type: "compile", status: "error", error: "슬라이드 생성에 실패했습니다",
        }),
      );
      return;
  }
}

/** Machine record: motion, live regions, targets, overlap, overflow, contrast. */
function readRecord() {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  /**
   * Is this element actually painted?
   *
   * `checkVisibility` is authoritative and is what makes this honest for the
   * closed `<details>` disclosure: the collapsed export set has NO `display:
   * none` anywhere on its ancestor chain and still reports a full
   * `getBoundingClientRect`, so an ancestor-walk alone counted eight hidden
   * export buttons as painted and reported them overlapping the Overview action
   * card. `checkVisibility` returns false for exactly that case (verified
   * against `#btn-export-pdf` inside a closed `.dock__more`), and the
   * ancestor-walk stays as the fallback for engines without it.
   */
  const painted = (el: Element): boolean => {
    const check = (el as Element & {
      checkVisibility?: (o?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean;
    }).checkVisibility;
    if (typeof check === "function") {
      if (!check.call(el, { checkVisibilityCSS: true })) return false;
    }
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

  // ── motion ──
  const moving: Array<{ id: string; transition: number; animation: number; name: string }> = [];
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (!painted(el)) continue;
    const s = getComputedStyle(el);
    const t = Math.max(0, ...seconds(s.transitionDuration));
    const a = s.animationName === "none" ? 0 : Math.max(0, ...seconds(s.animationDuration));
    const running = a > 0 && s.animationPlayState === "running";
    if (t > 0 || running) {
      moving.push({
        id: el.id || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "anon"}`,
        transition: t, animation: running ? a : 0, name: s.animationName,
      });
    }
  }

  // ── live regions ──
  const liveRegions = Array.from(document.querySelectorAll(
    '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]',
  )).map((el) => ({
    id: el.id || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "anon"}`,
    live: el.getAttribute("aria-live"),
    role: el.getAttribute("role"),
    atomic: el.getAttribute("aria-atomic"),
    painted: painted(el),
  }));

  // ── interactive targets, scrolled into view, plus pairwise overlap ──
  const selector = [
    ".app button", ".app a[data-output-target]", ".app summary",
    ".app select", ".app input", ".app textarea",
    ".app [tabindex]:not([tabindex='-1'])",
  ].join(", ");
  const controls: Array<{
    id: string; x: number; y: number; w: number; h: number; meets44: boolean;
    node: HTMLElement;
  }> = [];
  // Measured in ONE pass with no scrolling between reads.
  //
  // Scrolling each control into view before measuring it made every rect refer
  // to a DIFFERENT scroll position, so two controls that never share a pixel
  // reported a large phantom overlap (verified: at 320x667 `#btn-ask` sits at
  // y=675 and the disclosure summary at y=727 - 8px apart - yet a per-control
  // scroll reported them 29px overlapped). Sizes are scroll-invariant, so the
  // single pass costs nothing and makes the overlap figure real.
  //
  // The consequence is that OVERLAP here compares boxes at one shared scroll
  // position. Two controls in different scroll containers can report an overlap
  // that a user never experiences, because reaching the lower one scrolls it
  // away from the other - DESIGN 9.12 explicitly allows scrolling to keep
  // controls reachable. Real occlusion is asserted separately, and correctly,
  // by the scroll-then-hit-test audit in
  // tests/public-caret-accessibility.test.ts; the figure below is a layout
  // observation for inspection, not an acceptance gate.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    if (!painted(el)) continue;
    const r = el.getBoundingClientRect();
    controls.push({
      id: el.id || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "anon"}`,
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      meets44: r.width >= 43.5 && r.height >= 43.5,
      node: el,
    });
  }
  // Overlap between two controls means one is sitting on top of the other's
  // hit area, which is a real defect even when both are large enough. Nested
  // controls are excluded: a control inside another's box is a containment
  // relationship, not a collision.
  /** The nearest scrolling ancestor, or null for the document itself. */
  const scroller = (el: HTMLElement): Element | null => {
    for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) || /(auto|scroll)/.test(s.overflowX)) return n;
    }
    return null;
  };

  const overlaps: string[] = [];
  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      const a = controls[i];
      const b = controls[j];
      if (a.node.contains(b.node) || b.node.contains(a.node)) continue;
      // The rail's delete affordance is deliberately overlaid on its own row:
      // one `<li>`, a full-width row button and a destructive control pinned
      // inside its reserved end padding. That is the intended composition, and
      // the row reserves `--cf-target-min` of inline padding so the two never
      // compete for a pixel of the title.
      if (
        (a.id === "button.session-row" && b.id === "button.session-delete")
        || (a.id === "button.session-delete" && b.id === "button.session-row")
      ) continue;
      // Two controls in DIFFERENT scroll containers are not really overlapping:
      // reaching the lower one scrolls it clear of the other. Comparing them at
      // one shared scroll position is what made the Overview action card look
      // buried under the dock, which a scroll-then-hit-test proved it is not.
      if (scroller(a.node) !== scroller(b.node)) continue;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 1 && oy > 1) overlaps.push(`${a.id}~${b.id}:${ox}x${oy}`);
    }
  }

  // ── contrast on real running text ──
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
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const contrast = ["doc-title", "doc-meta", "status-text", "meeting-chrome-title",
    "live-topbar-timer", "caption-text", "transcript-count"]
    .map((id) => {
      const el = document.getElementById(id);
      if (!el || !painted(el)) return { id, present: false, ratio: 0, fontPx: 0 };
      const s = getComputedStyle(el);
      const fg = parse(s.color);
      const bg = backdrop(el);
      const a = fg[3];
      const composited: [number, number, number, number] = [
        fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1,
      ];
      return {
        id, present: true,
        ratio: Math.round(ratio(lum(composited), lum(bg)) * 100) / 100,
        fontPx: Number.parseFloat(s.fontSize),
      };
    });

  const app = document.querySelector(".app") as HTMLElement | null;
  return {
    state: {
      connection: document.documentElement.dataset.connection ?? null,
      capturePhase: app?.dataset.capturePhase ?? null,
      shell: app?.dataset.shell ?? null,
      detailTab: app?.dataset.detailTab ?? null,
      stageState: app?.dataset.stageState ?? null,
      capturingClass: app?.classList.contains("app--capturing") ?? false,
    },
    overflow: {
      root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    },
    moving,
    liveRegions,
    controls: controls.map(({ node: _node, ...rest }) => rest),
    undersized: controls.filter((c) => !c.meets44).map((c) => `${c.id}:${c.w}x${c.h}`),
    overlaps,
    contrast,
    viewport: { w: vw, h: vh },
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  harness = createPublicTestHarness();
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });

  const index: Array<Record<string, unknown>> = [];
  const defects: string[] = [];

  try {
    for (const vp of VIEWPORTS) {
      for (const reduced of [false, true]) {
        for (const state of STATES) {
          const tag = `${vp.name}-${state}${reduced ? "-reduced" : ""}`;
          const session = await openSession(vp.width, vp.height, reduced);
          try {
            await reach(session, state);
            const record = await session.page.evaluate(readRecord);
            const ax = await session.page.accessibility.snapshot({ interestingOnly: true });
            await session.page.screenshot({ path: join(OUT, `${tag}.png`) });
            writeFileSync(join(OUT, `${tag}.ax.json`), JSON.stringify(ax, null, 2));
            writeFileSync(join(OUT, `${tag}.json`), JSON.stringify(record, null, 2));

            // Observable acceptance checks, recorded rather than thrown so the
            // full matrix always completes and every defect is visible at once.
            if (record.overflow.root > 0) defects.push(`${tag}: root overflow ${record.overflow.root}px`);
            if (record.overflow.body > 0) defects.push(`${tag}: body overflow ${record.overflow.body}px`);
            if (reduced && record.moving.length > 0) {
              defects.push(`${tag}: ${record.moving.length} moving under reduced motion`);
            }
            if (!reduced) {
              const over = record.moving.filter((m) => m.transition > 0.2 + 1e-6);
              if (over.length > 0) defects.push(`${tag}: over-budget transition ${over.map((m) => `${m.id}:${m.transition}s`).join(",")}`);
            }
            if (vp.width <= 375 && record.undersized.length > 0) {
              defects.push(`${tag}: undersized ${record.undersized.join(",")}`);
            }
            if (record.overlaps.length > 0) {
              defects.push(`${tag}: overlap ${record.overlaps.join(",")}`);
            }
            const lowContrast = record.contrast
              .filter((c) => c.present && c.ratio < 4.5)
              .map((c) => `${c.id}:${c.ratio}`);
            if (lowContrast.length > 0) defects.push(`${tag}: contrast ${lowContrast.join(",")}`);

            index.push({
              tag, viewport: vp.name, state, reducedMotion: reduced,
              connection: record.state.connection,
              capturePhase: record.state.capturePhase,
              shell: record.state.shell,
              rootOverflow: record.overflow.root,
              movingCount: record.moving.length,
              liveRegionCount: record.liveRegions.filter((r) => r.painted).length,
              controlCount: record.controls.length,
              undersizedCount: record.undersized.length,
              overlapCount: record.overlaps.length,
            });
            process.stdout.write(`${tag}\n`);
          } finally {
            await session.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
    harness.stop();
  }

  writeFileSync(join(OUT, "index.json"), JSON.stringify({
    generatedFor: "caret-clone-redesign Todo 15",
    fixedClockEpochMs: FIXED_CLOCK_EPOCH_MS,
    locale: "ko-KR", timezone: "Asia/Seoul", deviceScaleFactor: 1,
    cells: index.length,
    defects,
    index,
  }, null, 2));

  process.stdout.write(`\ncells=${index.length} defects=${defects.length}\n`);
  for (const d of defects) process.stdout.write(`DEFECT ${d}\n`);
}

await main();
