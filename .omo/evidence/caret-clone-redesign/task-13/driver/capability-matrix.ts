// Task-13 characterization driver: freezes the CURRENT contextual-control matrix.
//
// It measures, for every canonical capability and every shell/phase/width in the
// matrix, whether the control exists, is unique, is perceivable, is hit-testable
// at its own centre, is keyboard-focusable, and what machine reason it carries
// when disabled. Nothing here asserts: it records. The RED suite asserts.
//
// Determinism: frozen clock, ko-KR / Asia/Seoul, DPR 1, every awaited state is
// subscribed to with a MutationObserver BEFORE its trigger, bounded timeouts.
// No sleep, no polling delay, no waitForTimeout.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness, type PublicTestHarness } from "../../../../../tests/public-test-harness.ts";

const FIXED_CLOCK_EPOCH_MS = 1_710_376_860_000;
const FIXED_CAPTURE_STARTED_AT = FIXED_CLOCK_EPOCH_MS - 125_000;

const OUT = process.argv[2] ?? join(import.meta.dir, "..", "baseline");

/** Every real capability Todo 13 must re-home, by its frozen binding ID. */
const CAPABILITIES = [
  "btn-record", "btn-live-stop",
  "btn-settings", "btn-recheck", "btn-recheck-stt", "btn-settings-close",
  "select-model", "select-effort",
  "btn-attendees", "btn-attendee-add", "btn-attendee-save",
  "btn-review", "btn-review-confirm", "btn-review-retry", "btn-review-close",
  "btn-ask", "btn-ask-send", "btn-ask-close",
  "btn-compile-deck",
  "btn-export-md", "btn-export-json", "btn-export-transcript",
  "btn-export-deck", "btn-export-pdf", "btn-export-png",
  "btn-reset",
] as const;

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1244", width: 1244, height: 836 },
  { name: "1100", width: 1100, height: 800 },
  { name: "960", width: 960, height: 760 },
  { name: "900", width: 900, height: 760 },
  { name: "899", width: 899, height: 760 },
  { name: "820", width: 820, height: 900 },
  { name: "375", width: 375, height: 812 },
  { name: "320", width: 320, height: 667 },
] as const;

const CAPTURE_STARTING = { type: "capture", capturing: false, mode: "mic", phase: "starting" } as const;
const CAPTURE_LIVE = {
  type: "capture", capturing: true, mode: "mic", phase: "capturing",
  startedAt: FIXED_CAPTURE_STARTED_AT,
} as const;

declare global {
  interface Window {
    __t13Await?: (token: string, predicate: string) => void;
    __t13Settle?: (token: string) => Promise<void>;
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

  window.__t13Await = (token: string, predicate: string): void => {
    const check = new Function(`return (${predicate});`) as () => boolean;
    let done = false;
    const settle = (): boolean => {
      if (done) return true;
      let ok = false;
      try { ok = check() === true; } catch { ok = false; }
      if (!ok) return false;
      done = true;
      void window.__t13Settle!(token);
      return true;
    };
    if (settle()) return;
    const observer = new MutationObserver(() => { if (settle()) observer.disconnect(); });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
  };
}

/**
 * In-page reader. For each capability: existence, uniqueness, perceivability,
 * centre hit-test (scrolled into view first, because a dock may legitimately own
 * a scroll), keyboard focusability, disabled state + machine reason.
 */
function readMatrix(ids: readonly string[]) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const app = document.querySelector(".app") as HTMLElement | null;

  const perceivable = (el: HTMLElement): boolean => {
    if (el.hidden) return false;
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      if (node.hidden) return false;
      const s = getComputedStyle(node);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      if (node instanceof HTMLDetailsElement) { /* details itself is fine */ }
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const rows = ids.map((id) => {
    const all = document.querySelectorAll(`#${CSS.escape(id)}`);
    const el = all[0] as HTMLElement | null;
    if (!el) {
      return {
        id, count: all.length, present: false, perceivable: false, reachable: false,
        focusable: false, disabled: null, title: null, ariaLabel: null,
        box: null, offscreen: false, belowFold: false, tabIndex: null,
        ownerChain: null, closedDetailsAncestor: null,
      };
    }
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    const vis = perceivable(el);

    // The nearest CLOSED <details> ancestor, if any: a real disclosure that is
    // shut is the legitimate reason a control is not currently painted.
    let closedDetails: string | null = null;
    for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) {
      if (n instanceof HTMLDetailsElement && !n.open) { closedDetails = n.id || n.className; break; }
    }

    const chain: string[] = [];
    for (let n: HTMLElement | null = el; n && chain.length < 12; n = n.parentElement) {
      chain.push(n.id ? `#${n.id}` : n.tagName.toLowerCase() + (n.className ? `.${String(n.className).split(" ")[0]}` : ""));
    }

    const before = document.activeElement;
    let focusable = false;
    if (vis) {
      try { el.focus({ preventScroll: true }); focusable = document.activeElement === el; } catch { focusable = false; }
      if (before instanceof HTMLElement) before.focus({ preventScroll: true });
    }

    return {
      id,
      count: all.length,
      present: true,
      perceivable: vis,
      reachable: vis && (hit === el || (hit instanceof Node && el.contains(hit))),
      focusable,
      disabled: el instanceof HTMLButtonElement || el instanceof HTMLSelectElement || el instanceof HTMLInputElement
        ? el.disabled : null,
      title: el.getAttribute("title"),
      ariaLabel: el.getAttribute("aria-label"),
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      offscreen: vis && (r.right > vw + 1 || r.left < -1),
      belowFold: vis && (r.top > vh + 1 || r.bottom < -1),
      tabIndex: el.tabIndex,
      ownerChain: chain,
      closedDetailsAncestor: closedDetails,
    };
  });

  const dock = document.querySelector(".dock") as HTMLElement | null;
  const dockRect = dock?.getBoundingClientRect() ?? null;
  const more = document.getElementById("dock-more") as HTMLDetailsElement | null;

  return {
    shell: app?.dataset.shell ?? null,
    capturePhase: app?.dataset.capturePhase ?? null,
    detailTab: app?.dataset.detailTab ?? null,
    viewport: { w: vw, h: vh },
    dock: dockRect
      ? {
        x: Math.round(dockRect.x), y: Math.round(dockRect.y),
        w: Math.round(dockRect.width), h: Math.round(dockRect.height),
        heightShareOfViewport: Number((dockRect.height / vh).toFixed(3)),
        scrollY: dock!.scrollHeight - dock!.clientHeight,
        columns: dock ? getComputedStyle(dock).gridTemplateColumns : null,
      }
      : null,
    dockMoreOpen: more?.open ?? null,
    dockMoreSetColumns: (() => {
      const set = document.querySelector(".dock__more-set") as HTMLElement | null;
      return set ? getComputedStyle(set).gridTemplateColumns : null;
    })(),
    rootOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    rows,
  };
}

class T13Timeout extends Error {
  constructor(predicate: string, ms: number) {
    super(`task-13 driver timed out after ${ms}ms waiting for: ${predicate}`);
    this.name = "T13Timeout";
  }
}

interface Session {
  page: Page;
  act(predicate: string, trigger: () => void | Promise<void>, ms?: number): Promise<void>;
  close(): Promise<void>;
}

let browser: Browser;
let harness: PublicTestHarness;

async function openSession(width: number, height: number): Promise<Session> {
  const page = await browser.newPage();
  const waiters = new Map<string, () => void>();
  await page.exposeFunction("__t13Settle", (token: string) => { waiters.get(token)?.(); });
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  await page.evaluateOnNewDocument(pageBootstrap, FIXED_CLOCK_EPOCH_MS);
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.waitForClient();
  await page.evaluate(async () => { await document.fonts.ready; });

  let counter = 0;
  return {
    page,
    async act(predicate, trigger, ms = 2_000) {
      const token = `t13-${(counter += 1)}`;
      const settled = new Promise<void>((resolve) => waiters.set(token, resolve));
      await page.evaluate((t: string, p: string) => window.__t13Await!(t, p), token, predicate);
      await trigger();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new T13Timeout(predicate, ms)), ms);
      });
      try { await Promise.race([settled, bounded]); }
      finally { if (timer !== undefined) clearTimeout(timer); waiters.delete(token); }
    },
    async close() { await page.close(); },
  };
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await mkdir(join(OUT, "shots"), { recursive: true });
  harness = createPublicTestHarness();
  browser = await puppeteer.launch({
    args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"],
  });

  const report: Record<string, unknown> = {};
  try {
    for (const vp of VIEWPORTS) {
      // ── library idle ──
      {
        const s = await openSession(vp.width, vp.height);
        report[`library-${vp.name}`] = await s.page.evaluate(readMatrix, CAPABILITIES);
        await s.page.screenshot({ path: join(OUT, "shots", `library-${vp.name}.png`) });
        await s.close();
      }
      // ── starting ──
      {
        const s = await openSession(vp.width, vp.height);
        await s.act('document.querySelector(".app")?.dataset.capturePhase === "starting"',
          () => harness.pushMessage(CAPTURE_STARTING));
        report[`starting-${vp.name}`] = await s.page.evaluate(readMatrix, CAPABILITIES);
        await s.page.screenshot({ path: join(OUT, "shots", `starting-${vp.name}.png`) });
        await s.close();
      }
      // ── capturing ──
      {
        const s = await openSession(vp.width, vp.height);
        await s.act('document.querySelector(".app")?.dataset.capturePhase === "starting"',
          () => harness.pushMessage(CAPTURE_STARTING));
        await s.act('document.querySelector(".app")?.classList.contains("app--capturing") === true',
          () => harness.pushMessage(CAPTURE_LIVE));
        report[`capturing-${vp.name}`] = await s.page.evaluate(readMatrix, CAPABILITIES);
        await s.page.screenshot({ path: join(OUT, "shots", `capturing-${vp.name}.png`) });
        await s.close();
      }
    }

    // ── the Todo-12 residual: does a user's disclosure choice survive
    //    starting -> capturing inside ONE live shell? ──
    {
      const s = await openSession(1244, 836);
      await s.act('document.querySelector(".app")?.dataset.capturePhase === "starting"',
        () => harness.pushMessage(CAPTURE_STARTING));
      const openedByUser = await s.page.evaluate(() => {
        const d = document.getElementById("dock-more") as HTMLDetailsElement | null;
        if (!d) return null;
        (d.querySelector("summary") as HTMLElement | null)?.click();
        return d.open;
      });
      await s.act('document.querySelector(".app")?.classList.contains("app--capturing") === true',
        () => harness.pushMessage(CAPTURE_LIVE));
      const afterTransition = await s.page.evaluate(() => {
        const d = document.getElementById("dock-more") as HTMLDetailsElement | null;
        return d ? d.open : null;
      });
      report["disclosure-persistence"] = { openedByUser, afterTransition };
      await s.close();
    }
  } finally {
    await browser.close();
    harness.stop();
  }

  await writeFile(join(OUT, "matrix.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`wrote ${join(OUT, "matrix.json")}`);
}

await main();
