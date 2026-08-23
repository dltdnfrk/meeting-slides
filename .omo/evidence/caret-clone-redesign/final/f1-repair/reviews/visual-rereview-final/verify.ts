// Independent final visual re-review driver — task st_019ff41f.
//
// Read-only with respect to product sources: it serves `public/` as-is through
// the existing test harness and only writes screenshots + geometry under this
// review directory.
//
// Purpose: the visual repair (st_019ff400) captured its V1/V3 receipts against
// `public/caret-operator.css` @ 4d0c317f..., but the Stop-target repair
// (st_019ff411) edited the SAME file afterwards (disk is now 5c2ef5f7...).
// No prior artifact exercises V1's long-caption case against the CURRENT file,
// and no artifact measures the Stop target and the long caption together.
// This driver re-measures everything against what actually ships now.
//
// Determinism: clock frozen before any app script runs, locale/timezone pinned,
// fonts awaited, every awaited state armed with a MutationObserver BEFORE its
// trigger frame. No sleeps, no polling, no waitForTimeout.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { createPublicTestHarness } from "../../../../../../../tests/public-test-harness.ts";

const OUT = import.meta.dir;
const SHOTS = join(OUT, "screenshots");
await mkdir(SHOTS, { recursive: true });

const NOW = 1_710_376_860_000;

// Long mixed Korean/English provisional caption: the content-length condition
// FAIL-V1 requires. Deliberately longer than the repair's own fixture so a fix
// tuned to that exact string cannot pass by coincidence.
const LONG_CAPTION =
  "온보딩 이탈률과 설치 시간 지표를 함께 점검하면서 다음 스프린트의 범위를 확정하겠습니다. " +
  "금요일 배포는 민수가 담당합니다. QA 마감은 수요일 18시입니다. beta channel opens Thursday " +
  "and the release notes are owned by Minsu, with the rollback window kept at thirty minutes, " +
  "그리고 다음 주 월요일에 온보딩 튜토리얼 4단계 축소안을 다시 검토하기로 했습니다.";

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

const LIVE_VIEWPORTS = [
  { name: "live-900x760", width: 900, height: 760 },
  { name: "live-960x760", width: 960, height: 760 },
  { name: "live-1244x836", width: 1244, height: 836 },
  { name: "live-1440x900", width: 1440, height: 900 },
];

const LIBRARY_VIEWPORTS = [
  { name: "library-320x667", width: 320, height: 667 },
  { name: "library-375x812", width: 375, height: 812 },
];

const harness = createPublicTestHarness();
const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"],
});

async function open(width: number, height: number, scale: number) {
  const page = await browser.newPage();
  const waiters = new Map<string, () => void>();
  await page.exposeFunction("__rv", (t: string) => waiters.get(t)?.());
  await page.evaluateOnNewDocument((fixed: number) => {
    const O = Date;
    class F extends O {
      constructor(...a: any[]) { a.length === 0 ? super(fixed) : super(...(a as [])); }
      static override now() { return fixed; }
    }
    (globalThis as any).Date = F;
    (globalThis as any).__arm = (t: string, e: string) => {
      const test = new Function(`return (${e})`);
      const ob = new MutationObserver(() => { if (test()) { ob.disconnect(); (globalThis as any).__rv(t); } });
      ob.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      if (test()) { ob.disconnect(); (globalThis as any).__rv(t); }
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
    const t = `rv${++n}`;
    const signal = new Promise<void>((r) => waiters.set(t, r));
    await page.evaluate((a, b) => (globalThis as any).__arm(a, b), t, predicate);
    await trigger();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([signal, new Promise<never>((_, rj) => {
        timer = setTimeout(() => rj(new Error(`re-review timeout: ${predicate}`)), 8_000);
      })]);
    } finally { if (timer) clearTimeout(timer); waiters.delete(t); }
  };
  return { page, act };
}

function readLive() {
  const box = (selector: string) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1),
      scrollW: el.scrollWidth, clientW: el.clientWidth, overflowX: el.scrollWidth - el.clientWidth,
      display: s.display, visibility: s.visibility, opacity: s.opacity,
      fontSize: s.fontSize, textOverflow: s.textOverflow, overflow: s.overflow,
      visible: s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0,
    };
  };

  const island = document.getElementById("island");
  const caption = document.getElementById("caption-text");
  const stage = island?.parentElement ?? null;
  const transcript = document.getElementById("transcript-pane");
  const ib = island?.getBoundingClientRect() ?? null;
  const sb = stage?.getBoundingClientRect() ?? null;
  const tb = transcript?.getBoundingClientRect() ?? null;

  // V1: an ellipsis must actually be rendered, not merely declared. Compare the
  // laid-out text width against the full text width in the same font.
  let captionEllipsized: boolean | null = null;
  let captionLineBoxes: number | null = null;
  if (caption) {
    const cs = getComputedStyle(caption);
    captionEllipsized = caption.scrollWidth > caption.clientWidth && cs.textOverflow === "ellipsis"
      && cs.overflow !== "visible";
    const range = document.createRange();
    range.selectNodeContents(caption);
    captionLineBoxes = range.getClientRects().length;
  }

  // Stop target: hit area, real hit-testability at its four edge midpoints, and
  // the density guard (glyph box + label font size must not have inflated).
  const stop = document.getElementById("btn-live-stop");
  let stopProbe: Record<string, unknown> | null = null;
  if (stop) {
    const r = stop.getBoundingClientRect();
    const dot = stop.querySelector<HTMLElement>(".live-topbar__dot, .live-topbar__stop-dot, span");
    const dotBox = dot?.getBoundingClientRect() ?? null;
    const points: Array<[string, number, number]> = [
      ["top", r.x + r.width / 2, r.y + 1],
      ["bottom", r.x + r.width / 2, r.bottom - 1],
      ["left", r.x + 1, r.y + r.height / 2],
      ["right", r.right - 1, r.y + r.height / 2],
    ];
    const misses = points.filter(([, x, y]) => !document.elementsFromPoint(x, y).includes(stop)).map(([n]) => n);
    const capsule = stop.closest<HTMLElement>(".live-topbar__capsule");
    const topbar = document.getElementById("live-topbar");
    const stageBox = document.getElementById("stage-pane")?.getBoundingClientRect() ?? null;
    const capBox = capsule?.getBoundingClientRect() ?? null;
    stopProbe = {
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      meets44: r.width >= 44 && r.height >= 44,
      edgeMisses: misses,
      disabled: (stop as HTMLButtonElement).disabled,
      accessibleName: stop.getAttribute("aria-label") ?? stop.textContent?.trim() ?? null,
      labelFontSize: getComputedStyle(stop).fontSize,
      dot: dotBox ? { w: +dotBox.width.toFixed(1), h: +dotBox.height.toFixed(1) } : null,
      capsule: capBox ? { w: +capBox.width.toFixed(1), h: +capBox.height.toFixed(1) } : null,
      capsuleWithinStage: capBox && stageBox
        ? capBox.x >= stageBox.x - 0.5 && capBox.right <= stageBox.right + 0.5
        : null,
      topbarOverflowX: topbar ? topbar.scrollWidth - topbar.clientWidth : null,
    };
  }

  // Blanket clipping sweep: any text-bearing node whose content overflows
  // horizontally WITHOUT an opted-in ellipsis is a partial-glyph violation.
  const clipped: Array<Record<string, unknown>> = [];
  document.querySelectorAll<HTMLElement>("button, a, h1, h2, h3, p, span, li, .island__text, .action-card__btn").forEach((el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const ovf = el.scrollWidth - el.clientWidth;
    if (ovf > 1 && !(s.textOverflow === "ellipsis" && s.overflow !== "visible")) {
      clipped.push({
        tag: el.tagName.toLowerCase(), id: el.id || null, cls: el.className || null,
        overflowX: ovf, text: (el.textContent ?? "").trim().slice(0, 48),
      });
    }
  });

  return {
    island: box("#island"),
    caption: box("#caption-text"),
    stagePane: box("#stage-pane"),
    transcriptPane: box("#transcript-pane"),
    islandWithinOwner: ib && sb ? ib.x >= sb.x - 0.5 && ib.right <= sb.right + 0.5 : null,
    islandClearsTranscript: ib && tb ? ib.right <= tb.x + 0.5 : null,
    captionEllipsized, captionLineBoxes,
    stop: stopProbe,
    coralPrimaryCount: Array.from(document.querySelectorAll<HTMLElement>("button")).filter((b) => {
      const s = getComputedStyle(b);
      if (s.display === "none" || s.visibility === "hidden") return false;
      const bg = s.backgroundColor;
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
      if (!m) return false;
      const [r, g, bl] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return r > 180 && g > 70 && g < 160 && bl > 50 && bl < 140;
    }).length,
    clippedTextNodes: clipped,
    rootOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}

function readLibrary() {
  const box = (selector: string) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      right: +r.right.toFixed(1),
      overflowX: el.scrollWidth - el.clientWidth,
      display: s.display, visibility: s.visibility, opacity: s.opacity, fontSize: s.fontSize,
      visible: s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0,
    };
  };

  // V2: does #btn-review paint any ink, and does it keep exactly one a11y name?
  const review = document.getElementById("btn-review") as HTMLButtonElement | null;
  let reviewProbe: Record<string, unknown> | null = null;
  if (review) {
    const r = review.getBoundingClientRect();
    const inked = Array.from(review.querySelectorAll<HTMLElement>("*")).filter((n) => {
      const s = getComputedStyle(n);
      const nb = n.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0
        && nb.width > 0 && nb.height > 0 && (n.textContent ?? "").trim().length > 0;
    }).map((n) => ({
      cls: n.className, text: (n.textContent ?? "").trim(),
      w: +n.getBoundingClientRect().width.toFixed(1), h: +n.getBoundingClientRect().height.toFixed(1),
      ariaHidden: n.getAttribute("aria-hidden"),
    }));
    const icon = review.querySelector<HTMLElement>(".review-btn__icon");
    const iconBox = icon?.getBoundingClientRect() ?? null;
    const points: Array<[string, number, number]> = [
      ["top", r.x + r.width / 2, r.y + 1],
      ["bottom", r.x + r.width / 2, r.bottom - 1],
      ["left", r.x + 1, r.y + r.height / 2],
      ["right", r.right - 1, r.y + r.height / 2],
    ];
    reviewProbe = {
      hidden: review.hidden,
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      meets44: r.width >= 44 && r.height >= 44,
      edgeMisses: points.filter(([, x, y]) => !document.elementsFromPoint(x, y).includes(review)).map(([n]) => n),
      ariaLabel: review.getAttribute("aria-label"),
      inkNodes: inked,
      inkCount: inked.length,
      iconVisible: icon ? getComputedStyle(icon).display !== "none" && !!iconBox && iconBox.width > 0 : false,
      iconBox: iconBox ? { w: +iconBox.width.toFixed(1), h: +iconBox.height.toFixed(1) } : null,
      iconAriaHidden: icon?.getAttribute("aria-hidden") ?? null,
      labelDisplay: review.querySelector<HTMLElement>(".review-btn__label")
        ? getComputedStyle(review.querySelector<HTMLElement>(".review-btn__label")!).display : null,
    };
  }

  // V3: text column share of the action-card head, plus per-command geometry.
  const head = document.querySelector<HTMLElement>("#action-followup .action-card__head");
  let actionProbe: Record<string, unknown> | null = null;
  if (head) {
    const hb = head.getBoundingClientRect();
    const textCol = head.firstElementChild as HTMLElement | null;
    const actions = head.querySelector<HTMLElement>(".action-card__actions");
    const tcb = textCol?.getBoundingClientRect() ?? null;
    const ab = actions?.getBoundingClientRect() ?? null;
    const lineBoxes = (el: HTMLElement | null) => {
      if (!el) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getClientRects().length;
    };
    const title = head.querySelector<HTMLElement>(".action-card__title");
    const sub = head.querySelector<HTMLElement>(".action-card__sub");
    actionProbe = {
      headW: +hb.width.toFixed(1),
      textColW: tcb ? +tcb.width.toFixed(1) : null,
      textShare: tcb ? +(tcb.width / hb.width).toFixed(4) : null,
      commandsOnOwnRow: tcb && ab ? ab.y >= tcb.bottom - 0.5 : null,
      titleText: title?.textContent?.trim() ?? null,
      titleLineBoxes: lineBoxes(title),
      titleOverflowX: title ? title.scrollWidth - title.clientWidth : null,
      subText: sub?.textContent?.trim() ?? null,
      subLineBoxes: lineBoxes(sub),
      subOverflowX: sub ? sub.scrollWidth - sub.clientWidth : null,
      commands: Array.from(head.querySelectorAll<HTMLElement>(".action-card__btn")).map((b) => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return {
          id: b.id, text: (b.textContent ?? "").trim(),
          w: +r.width.toFixed(1), h: +r.height.toFixed(1),
          meets44: r.width >= 44 && r.height >= 44,
          overflowX: b.scrollWidth - b.clientWidth,
          opacity: cs.opacity, disabled: (b as HTMLButtonElement).disabled,
          lineBoxes: lineBoxes(b),
        };
      }),
    };
  }

  const clipped: Array<Record<string, unknown>> = [];
  document.querySelectorAll<HTMLElement>("button, a, h1, h2, h3, p, span, li, .action-card__btn").forEach((el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const ovf = el.scrollWidth - el.clientWidth;
    if (ovf > 1 && !(s.textOverflow === "ellipsis" && s.overflow !== "visible")) {
      clipped.push({
        tag: el.tagName.toLowerCase(), id: el.id || null, cls: el.className || null,
        overflowX: ovf, text: (el.textContent ?? "").trim().slice(0, 48),
      });
    }
  });

  // Every painted control at the narrow floor must clear the 44px pointer floor.
  const narrowTargetFailures = Array.from(document.querySelectorAll<HTMLElement>("button, a[href], [role='button']"))
    .filter((el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
    })
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.id || null, cls: el.className || null, w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    });

  return {
    topbarReview: box("#btn-review"),
    topbarAttendees: box("#btn-attendees"),
    review: reviewProbe,
    action: actionProbe,
    clippedTextNodes: clipped,
    narrowTargetFailures,
    rootOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
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

  results[v.name] = await page.evaluate(readLive);
  await page.screenshot({ path: join(SHOTS, `${v.name}.png`) });

  // Focused crops: the caption seam and the Stop capsule, both at real density.
  const captionClip = await page.evaluate(() => {
    const el = document.getElementById("island");
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: 0, y: Math.max(0, b.y - 10), width: window.innerWidth, height: Math.min(b.height + 20, window.innerHeight) };
  });
  if (captionClip) await page.screenshot({ path: join(SHOTS, `${v.name}-caption.png`), clip: captionClip });
  const stopClip = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".live-topbar__capsule") ?? document.getElementById("btn-live-stop");
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.max(0, b.x - 24), y: Math.max(0, b.y - 16), width: b.width + 48, height: b.height + 32 };
  });
  if (stopClip) await page.screenshot({ path: join(SHOTS, `${v.name}-stop.png`), clip: stopClip });
  await page.close();
}

for (const v of LIBRARY_VIEWPORTS) {
  const { page, act } = await open(v.width, v.height, 2);
  await act('document.querySelectorAll("#session-list .session-row").length === 1', () => harness.pushMessage(MEETINGS));
  await act('document.querySelector("#session-list .session-row--selected") !== null', () =>
    page.click("#session-list .session-row"));
  await act('document.getElementById("btn-review")?.hidden === false', () => harness.pushMessage(DETAIL));

  results[v.name] = await page.evaluate(readLibrary);
  await page.screenshot({ path: join(SHOTS, `${v.name}-full.png`), fullPage: true });
  await page.screenshot({ path: join(SHOTS, `${v.name}-topbar.png`), clip: { x: 0, y: 0, width: v.width, height: 72 } });

  const reviewClip = await page.evaluate(() => {
    const el = document.getElementById("btn-review");
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.max(0, b.x - 10), y: Math.max(0, b.y - 10), width: b.width + 20, height: b.height + 20 };
  });
  if (reviewClip) await page.screenshot({ path: join(SHOTS, `${v.name}-review-control.png`), clip: reviewClip });

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
