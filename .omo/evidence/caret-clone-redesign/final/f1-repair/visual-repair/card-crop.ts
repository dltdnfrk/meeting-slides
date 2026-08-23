// Element-level capture of the action card at 320 and 375, so the repaired
// title/description/command layout can be inspected without a viewport crop.
import { join } from "node:path";
import puppeteer from "puppeteer";
import { createPublicTestHarness } from "../../../../../../tests/public-test-harness.ts";

const SHOTS = join(import.meta.dir, "screenshots");
const NOW = 1_710_376_860_000;
const MEETINGS = { type: "meetings", items: [{ id: 101, title: "제품 로드맵 정렬", started_at: NOW - 86_400_000, status: "ended" }] };
const DETAIL = {
  type: "meeting", meetingId: 101, title: "제품 로드맵 정렬",
  transcript: [{ text: "확정된 회의 발언입니다.", ts: NOW - 3_000, speaker: 1 }],
  current: { index: 3, startedAt: NOW - 60_000, sentenceCount: 9, kind: "topic", title: "온보딩 지표 점검", kicker: "제품 로드맵", bullets: ["이탈률 12% 감소"] },
  history: [], compiled: null,
};

const harness = createPublicTestHarness();
const browser = await puppeteer.launch({ args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"] });

for (const [w, h] of [[320, 667], [375, 812]] as const) {
  const page = await browser.newPage();
  const waiters = new Map<string, () => void>();
  await page.exposeFunction("__qa", (t: string) => waiters.get(t)?.());
  await page.evaluateOnNewDocument((fixed: number) => {
    const O = Date;
    class F extends O { constructor(...a: any[]) { a.length === 0 ? super(fixed) : super(...(a as [])); } static override now() { return fixed; } }
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
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 3 });
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
      await Promise.race([signal, new Promise<never>((_, rj) => { timer = setTimeout(() => rj(new Error(predicate)), 5_000); })]);
    } finally { if (timer) clearTimeout(timer); waiters.delete(t); }
  };

  await act('document.querySelectorAll("#session-list .session-row").length === 1', () => harness.pushMessage(MEETINGS));
  await act('document.querySelector("#session-list .session-row--selected") !== null', () => page.click("#session-list .session-row"));
  await act('document.getElementById("btn-review")?.hidden === false', () => harness.pushMessage(DETAIL));

  // Scroll the card fully into view first: puppeteer's element screenshot
  // clips at the viewport, so a card partly below the fold captures neighbours.
  await page.evaluate(async () => {
    document.getElementById("action-followup")?.scrollIntoView({ block: "start" });
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
  const card = await page.$("#action-followup");
  await card!.screenshot({ path: join(SHOTS, `action-card-${w}.png`) });

  const review = await page.$("#btn-review");
  await review!.screenshot({ path: join(SHOTS, `review-control-${w}.png`) });

  await page.close();
}
await browser.close();
harness.stop();
console.log("ok");
