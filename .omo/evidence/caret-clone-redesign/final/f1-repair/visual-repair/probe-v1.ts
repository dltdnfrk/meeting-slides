// Diagnostic probe: the true runtime containment and geometry of #island in the
// live shell at >=900px with a long provisional caption.
import puppeteer from "puppeteer";
import { createPublicTestHarness } from "../../../../../../tests/public-test-harness.ts";

const NOW = 1_710_376_860_000;
const CAPTION =
  "온보딩 이탈률과 설치 시간 지표를 함께 점검하면서 다음 스프린트의 범위를 확정하겠습니다. " +
  "금요일 배포는 민수가 담당합니다. QA 마감은 수요일 18시입니다. beta channel opens Thursday " +
  "and the release notes are owned by Minsu, with the rollback window kept at thirty minutes.";

const harness = createPublicTestHarness();
const browser = await puppeteer.launch({ args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"] });

for (const [w, h] of [[960, 760], [1244, 836], [1440, 900]] as const) {
  const page = await browser.newPage();
  const waiters = new Map<string, () => void>();
  await page.exposeFunction("__p", (t: string) => waiters.get(t)?.());
  await page.evaluateOnNewDocument((fixed: number) => {
    const O = Date;
    class F extends O { constructor(...a: any[]) { a.length === 0 ? super(fixed) : super(...(a as [])); } static override now() { return fixed; } }
    (globalThis as any).Date = F;
    (globalThis as any).__arm = (t: string, e: string) => {
      const test = new Function(`return (${e})`);
      const ob = new MutationObserver(() => { if (test()) { ob.disconnect(); (globalThis as any).__p(t); } });
      ob.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      if (test()) { ob.disconnect(); (globalThis as any).__p(t); }
    };
  }, NOW);
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.waitForClient();
  await page.evaluate(() => document.fonts.ready);

  let n = 0;
  const act = async (predicate: string, trigger: () => void | Promise<void>) => {
    const t = `p${++n}`;
    const signal = new Promise<void>((r) => waiters.set(t, r));
    await page.evaluate((a, b) => (globalThis as any).__arm(a, b), t, predicate);
    await trigger();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([signal, new Promise<never>((_, rj) => { timer = setTimeout(() => rj(new Error(predicate)), 3000); })]);
    } finally { if (timer) clearTimeout(timer); waiters.delete(t); }
  };

  await act('document.querySelector(".app")?.dataset.capturePhase === "starting"', () =>
    harness.pushMessage({ type: "capture", capturing: false, mode: "mic", phase: "starting" }));
  await act('document.querySelector(".app")?.classList.contains("app--capturing") === true', () =>
    harness.pushMessage({ type: "capture", capturing: true, mode: "mic", phase: "capturing", startedAt: NOW - 125000 }));
  await act('document.querySelector("#current-slide .slide__title") !== null', () =>
    harness.pushMessage({ type: "slide", current: { index: 3, startedAt: NOW - 60000, sentenceCount: 9, kind: "topic", title: "온보딩 지표 점검", kicker: "제품 로드맵", bullets: ["이탈률 12% 감소"] }, history: [] }));
  await act('document.querySelectorAll("#transcript-stream .feed-line").length === 1', () =>
    harness.pushMessage({ type: "line", text: "확정된 라이브 발언입니다.", ts: NOW - 3000, speaker: 1 }));
  await act(`document.getElementById("caption-text")?.textContent === ${JSON.stringify(CAPTION)}`, () =>
    harness.pushMessage({ type: "caption", text: CAPTION, speaker: 2 }));

  const report = await page.evaluate(() => {
    const info = (el: Element | null) => {
      if (!el) return null;
      const h = el as HTMLElement;
      const r = h.getBoundingClientRect();
      const s = getComputedStyle(h);
      return {
        id: h.id || h.className, x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        right: +r.right.toFixed(1), scrollW: h.scrollWidth, clientW: h.clientWidth, overflowX: h.scrollWidth - h.clientWidth,
        display: s.display, gridColumnStart: s.gridColumnStart, gridRowStart: s.gridRowStart,
        overflow: s.overflow, minWidth: s.minWidth, whiteSpace: s.whiteSpace, textOverflow: s.textOverflow,
        wordBreak: s.wordBreak, position: s.position, flex: s.flex,
      };
    };
    const island = document.getElementById("island");
    const chain: string[] = [];
    for (let p = island?.parentElement ?? null; p; p = p.parentElement) chain.push(p.id || p.className || p.tagName);
    return {
      parentChain: chain,
      island: info(island),
      captionText: info(document.getElementById("caption-text")),
      stage: info(document.getElementById("stage-pane")),
      slideFrame: info(document.getElementById("slide-frame")),
      transcriptPane: info(document.getElementById("transcript-pane")),
      surface: info(document.getElementById("document-surface")),
      rootOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  console.log(`\n===== ${w}x${h} =====`);
  console.log(JSON.stringify(report, null, 2));
  await page.close();
}
await browser.close();
harness.stop();
