// Real Chromium QA sweep for the F1 visual repair (V1/V2/V3).
//
// Captures the exact viewports named by the repair task, with the long mixed
// Korean/English provisional caption that makes V1 manifest, and records
// per-element geometry / overflow / visibility alongside each screenshot.
//
// Determinism: the clock is frozen before any application script runs, locale
// and timezone are pinned, fonts are awaited, and every awaited client state is
// armed with a MutationObserver BEFORE its trigger frame is pushed. No sleeps.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { createPublicTestHarness } from "../../../../../../tests/public-test-harness.ts";

const OUT = import.meta.dir;
const SHOTS = join(OUT, "screenshots");
await mkdir(SHOTS, { recursive: true });

const NOW = 1_710_376_860_000;

const LONG_CAPTION =
  "온보딩 이탈률과 설치 시간 지표를 함께 점검하면서 다음 스프린트의 범위를 확정하겠습니다. " +
  "금요일 배포는 민수가 담당합니다. QA 마감은 수요일 18시입니다. beta channel opens Thursday " +
  "and the release notes are owned by Minsu, with the rollback window kept at thirty minutes.";

const SLIDE = {
  index: 3, startedAt: NOW - 60_000, sentenceCount: 9, kind: "topic",
  title: "온보딩 지표 점검과 다음 스프린트 범위 확정", kicker: "제품 로드맵",
  bullets: ["이탈률 12% 감소", "설치 시간 4분 → 2분 30초"],
};

const MEETINGS = { type: "meetings", items: [{ id: 101, title: "제품 로드맵 정렬", started_at: NOW - 86_400_000, status: "ended" }] };
const DETAIL = {
  type: "meeting", meetingId: 101, title: "제품 로드맵 정렬",
  transcript: [{ text: "확정된 회의 발언입니다.", ts: NOW - 3_000, speaker: 1 }],
  current: SLIDE, history: [], compiled: null,
};

/** LIVE viewports exercise V1 (>=900 side-by-side seam). */
const LIVE_VIEWPORTS = [
  { name: "live-960x760", width: 960, height: 760 },
  { name: "live-1244x836", width: 1244, height: 836 },
  { name: "live-1440x900", width: 1440, height: 900 },
  { name: "live-900x760-seam", width: 900, height: 760 },
];

/** LIBRARY viewports exercise V2 (blank review control) and V3 (action card). */
const LIBRARY_VIEWPORTS = [
  { name: "library-375x812", width: 375, height: 812 },
  { name: "library-320x667", width: 320, height: 667 },
];

const harness = createPublicTestHarness();
const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"],
});

async function open(width: number, height: number, scale: number) {
  const page = await browser.newPage();
  const waiters = new Map<string, () => void>();
  await page.exposeFunction("__qa", (t: string) => waiters.get(t)?.());
  await page.evaluateOnNewDocument((fixed: number) => {
    const O = Date;
    class F extends O {
      constructor(...a: any[]) { a.length === 0 ? super(fixed) : super(...(a as [])); }
      static override now() { return fixed; }
    }
    (globalThis as any).Date = F;
    (globalThis as any).__arm = (t: string, e: string) => {
      const test = new Function(`return (${e})`);
      const ob = new MutationObserver(() => { if (test()) { ob.disconnect(); (globalThis as any).__qa(t); } });
      ob.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      if (test()) { ob.disconnect(); (globalThis as any).__qa(t); }
    };
  }, NOW);
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.waitForClient();
  await page.evaluate(() => document.fonts.ready);
  let n = 0;
  const act = async (predicate: string, trigger: () => void | Promise<void>) => {
    const t = `qa${++n}`;
    const signal = new Promise<void>((r) => waiters.set(t, r));
    await page.evaluate((a, b) => (globalThis as any).__arm(a, b), t, predicate);
    await trigger();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([signal, new Promise<never>((_, rj) => {
        timer = setTimeout(() => rj(new Error(`QA timeout: ${predicate}`)), 5_000);
      })]);
    } finally { if (timer) clearTimeout(timer); waiters.delete(t); }
  };
  return { page, act };
}

/** Every reader below returns machine values only: boxes, overflow, visibility. */
function readAll() {
  const info = (selector: string) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1),
      scrollW: el.scrollWidth, clientW: el.clientWidth, overflowX: el.scrollWidth - el.clientWidth,
      display: s.display, visibility: s.visibility, opacity: s.opacity,
      visible: s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0,
    };
  };
  const island = document.getElementById("island");
  const owner = island?.parentElement ?? null;
  const ownerBox = owner?.getBoundingClientRect() ?? null;
  const islandBox = island?.getBoundingClientRect() ?? null;

  // V2: does #btn-review paint any ink at all?
  const review = document.getElementById("btn-review");
  const reviewInk = review ? Array.from(review.querySelectorAll("*")).filter((n) => {
    const el = n as HTMLElement;
    if (el.hasAttribute("hidden")) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number.parseFloat(s.opacity) === 0) return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && (el.textContent ?? "").trim().length > 0;
  }).map((n) => ({ cls: (n as HTMLElement).className, text: ((n as HTMLElement).textContent ?? "").trim() })) : [];

  // V3: the action card head's share of width, and every command's own fit.
  const head = document.querySelector<HTMLElement>("#action-followup .action-card__head");
  const textCol = document.querySelector<HTMLElement>("#action-followup .action-card__head > div:first-child");
  const cmds = document.querySelector<HTMLElement>("#action-followup .action-card__actions");
  const title = document.querySelector<HTMLElement>("#action-followup .action-card__title");
  let headShare = null as null | Record<string, unknown>;
  if (head && textCol && cmds && title) {
    const hb = head.getBoundingClientRect(), tb = textCol.getBoundingClientRect(), cb = cmds.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(title);
    headShare = {
      headW: +hb.width.toFixed(1), textW: +tb.width.toFixed(1), commandsW: +cb.width.toFixed(1),
      textShare: +(tb.width / hb.width).toFixed(4),
      sameRow: Math.abs(tb.y - cb.y) <= 1,
      titleLineBoxes: range.getClientRects().length,
    };
  }

  return {
    shell: (document.querySelector(".app") as HTMLElement)?.dataset.shell ?? null,
    capturePhase: (document.querySelector(".app") as HTMLElement)?.dataset.capturePhase ?? null,
    rootOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,

    // V1
    island: info("#island"),
    islandOwnerId: owner?.id ?? null,
    islandOwner: owner ? info(`#${owner.id}`) : null,
    islandWithinOwner: Boolean(islandBox && ownerBox)
      && islandBox!.x >= ownerBox!.x - 1
      && islandBox!.right <= ownerBox!.right + 1,
    captionText: info("#caption-text"),
    captionContent: (document.getElementById("caption-text")?.textContent ?? "").slice(0, 60),
    stagePane: info("#stage-pane"),
    transcriptPane: info("#transcript-pane"),

    // V2
    review: info("#btn-review"),
    reviewHidden: review ? (review as HTMLElement).hidden : null,
    reviewAccessibleName: review?.getAttribute("aria-label") ?? null,
    reviewIcon: info("#btn-review .review-btn__icon"),
    reviewVisibleInk: reviewInk,

    // V3
    actionCard: info("#action-followup"),
    actionHead: headShare,
    actionCommands: Array.from(document.querySelectorAll<HTMLElement>(".action-card__btn")).map((b) => {
      const r = b.getBoundingClientRect();
      return {
        id: b.id, w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1),
        overflowX: b.scrollWidth - b.clientWidth,
        label: (b.textContent ?? "").trim(),
        visible: r.width > 0 && r.height > 0,
      };
    }),

    // A blanket CJK/latin clipping sweep: any text-bearing node whose own box
    // cannot contain its content AND which does not opt into an ellipsis.
    clippedTextNodes: Array.from(document.querySelectorAll<HTMLElement>(
      "button, a, h1, h2, h3, p, span, li, .action-card__btn, .review-btn, .attendee-btn",
    )).filter((el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (el.scrollWidth - el.clientWidth <= 1) return false;
      return s.textOverflow !== "ellipsis";
    }).map((el) => ({
      tag: el.tagName, id: el.id, cls: el.className,
      overflowX: el.scrollWidth - el.clientWidth,
      text: (el.textContent ?? "").trim().slice(0, 50),
    })),
  };
}

const results: Record<string, unknown> = {};

for (const v of LIVE_VIEWPORTS) {
  const { page, act } = await open(v.width, v.height, 2);
  await act('document.querySelector(".app")?.dataset.capturePhase === "starting"', () =>
    harness.pushMessage({ type: "capture", capturing: false, mode: "mic", phase: "starting" }));
  await act('document.querySelector(".app")?.classList.contains("app--capturing") === true', () =>
    harness.pushMessage({ type: "capture", capturing: true, mode: "mic", phase: "capturing", startedAt: NOW - 125_000 }));
  await act('document.querySelector("#current-slide .slide__title") !== null', () =>
    harness.pushMessage({ type: "slide", current: SLIDE, history: [] }));
  for (let i = 0; i < 6; i += 1) {
    await act(`document.querySelectorAll("#transcript-stream .feed-line").length === ${i + 1}`, () =>
      harness.pushMessage({ type: "line", text: `${i + 1}번째 확정 문장입니다. 다음 스프린트 범위를 확정합니다.`, ts: NOW - (6 - i) * 3_000, speaker: (i % 2) + 1 }));
  }
  await act(`document.getElementById("caption-text")?.textContent === ${JSON.stringify(LONG_CAPTION)}`, () =>
    harness.pushMessage({ type: "caption", text: LONG_CAPTION, speaker: 2 }));

  results[v.name] = await page.evaluate(readAll);
  await page.screenshot({ path: join(SHOTS, `${v.name}.png`) });
  await page.close();
}

for (const v of LIBRARY_VIEWPORTS) {
  const { page, act } = await open(v.width, v.height, 2);
  await act('document.querySelectorAll("#session-list .session-row").length === 1', () => harness.pushMessage(MEETINGS));
  await act('document.querySelector("#session-list .session-row--selected") !== null', () =>
    page.click("#session-list .session-row"));
  await act('document.getElementById("btn-review")?.hidden === false', () => harness.pushMessage(DETAIL));

  results[v.name] = await page.evaluate(readAll);
  await page.screenshot({ path: join(SHOTS, `${v.name}-full.png`), fullPage: true });
  await page.screenshot({ path: join(SHOTS, `${v.name}-topbar.png`), clip: { x: 0, y: 0, width: v.width, height: 64 } });

  // A focused crop of the action card, scrolled into view via the browser's own
  // next paint rather than a timer.
  const cardBox = await page.evaluate(async () => {
    const card = document.getElementById("action-followup");
    if (!card) return null;
    card.scrollIntoView({ block: "center" });
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const b = card.getBoundingClientRect();
    return { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: b.width + 16, height: b.height + 16 };
  });
  if (cardBox) await page.screenshot({ path: join(SHOTS, `${v.name}-action-card.png`), clip: cardBox });
  await page.close();
}

await writeFile(join(OUT, "geometry.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
await browser.close();
harness.stop();
