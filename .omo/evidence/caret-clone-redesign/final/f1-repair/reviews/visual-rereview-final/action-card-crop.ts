// Focused V3 crop: the action-card HEAD (title + description + command row) at
// 320 and 375, captured with the head anchored so the sticky bottom bar cannot
// overlay it. Screenshots only; no product source is touched.
import { join } from "node:path";
import puppeteer from "puppeteer";
import { createPublicTestHarness } from "../../../../../../../tests/public-test-harness.ts";

const SHOTS = join(import.meta.dir, "screenshots");
const NOW = 1_710_376_860_000;
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

const harness = createPublicTestHarness();
const browser = await puppeteer.launch({ args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"] });

for (const v of [{ w: 320, h: 667 }, { w: 375, h: 812 }]) {
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
  await page.setViewport({ width: v.w, height: v.h, deviceScaleFactor: 2 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.waitForClient();
  await page.evaluate(() => document.fonts.ready);
  let n = 0;
  const act = async (predicate: string, trigger: () => void | Promise<void>) => {
    const t = `ac${++n}`;
    const signal = new Promise<void>((r) => waiters.set(t, r));
    await page.evaluate((a, b) => (globalThis as any).__arm(a, b), t, predicate);
    await trigger();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([signal, new Promise<never>((_, rj) => {
        timer = setTimeout(() => rj(new Error(`crop timeout: ${predicate}`)), 8_000);
      })]);
    } finally { if (timer) clearTimeout(timer); waiters.delete(t); }
  };

  await act('document.querySelectorAll("#session-list .session-row").length === 1', () => harness.pushMessage(MEETINGS));
  await act('document.querySelector("#session-list .session-row--selected") !== null', () => page.click("#session-list .session-row"));
  await act('document.getElementById("btn-review")?.hidden === false', () => harness.pushMessage(DETAIL));

  const clip = await page.evaluate(async () => {
    const head = document.querySelector<HTMLElement>("#action-followup .action-card__head");
    if (!head) return null;
    head.scrollIntoView({ block: "start" });
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const b = head.getBoundingClientRect();
    return {
      x: Math.max(0, b.x - 12), y: Math.max(0, b.y - 12),
      width: Math.min(b.width + 24, window.innerWidth - Math.max(0, b.x - 12)),
      height: Math.min(b.height + 24, window.innerHeight - Math.max(0, b.y - 12)),
    };
  });
  if (clip) await page.screenshot({ path: join(SHOTS, `action-card-head-${v.w}.png`), clip });
  await page.close();
}

await browser.close();
harness.stop();
console.log("ok");
