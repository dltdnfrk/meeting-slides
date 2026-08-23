import { writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { createPublicTestHarness } from "../../../../../../tests/public-test-harness.ts";

const out = import.meta.dir;
const now = 1_710_376_860_000;
const viewports = [
  { name: "320x667", width: 320, height: 667 },
  { name: "375x812", width: 375, height: 812 },
  { name: "820x900", width: 820, height: 900 },
] as const;
const slide = {
  index: 3, startedAt: now - 60_000, sentenceCount: 9, kind: "topic",
  title: "온보딩 지표 점검과 다음 스프린트 범위 확정",
  kicker: "제품 로드맵",
  bullets: ["이탈률 12% 감소", "설치 시간 4분 → 2분 30초", "튜토리얼 4단계 축소"],
  emphasis: "결정: 온보딩 튜토리얼을 4단계로 축소한다",
};
const lines = Array.from({ length: 10 }, (_, index) => ({
  type: "line", text: `${index + 1}번째 확정 문장입니다. 온보딩 지표와 다음 스프린트 범위를 함께 확인합니다.`,
  ts: now - (10 - index) * 3_000, speaker: (index % 2) + 1,
}));

function bootstrap(fixedNow: number) {
  const OriginalDate = Date;
  class FrozenDate extends OriginalDate {
    constructor(...args: unknown[]) { args.length === 0 ? super(fixedNow) : super(...(args as ConstructorParameters<typeof Date>)); }
    static override now() { return fixedNow; }
  }
  (globalThis as unknown as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;
}

function geometry() {
  const box = (selector: string) => {
    const element = document.querySelector(selector)!;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
  };
  const slideElement = document.getElementById("current-slide")!;
  const slideRect = slideElement.getBoundingClientRect();
  const textElements = [...slideElement.querySelectorAll<HTMLElement>(
    ".placeholder__title, .placeholder__sub, .slide__kicker, .slide__index, .slide__title, .slide__bullets li, .slide__emphasis",
  )].filter((element) => getComputedStyle(element).display !== "none");
  const partialCharacters: Array<{ className: string; index: number }> = [];
  const occludedCharacters: Array<{ className: string; index: number }> = [];
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
        range.setStart(node, index); range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        if (rect.left < slideRect.left - 1 || rect.top < slideRect.top - 1
          || rect.right > slideRect.right + 1 || rect.bottom > slideRect.bottom + 1) {
          partialCharacters.push({ className: element.className, index });
        }
        const samples = [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1];
        if (samples.some((y) => {
          const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
          return hit !== element && !element.contains(hit);
        })) {
          occludedCharacters.push({ className: element.className, index });
        }
      }
    }
  }
  const stop = document.getElementById("btn-live-stop") as HTMLButtonElement;
  const transcriptBody = document.getElementById("transcript-body")!;
  return {
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
    frame: box("#slide-frame"), slide: box("#current-slide"), stop: box("#btn-live-stop"),
    transcript: box("#transcript-pane"), transcriptBody: box("#transcript-body"),
    aspect: slideRect.width / slideRect.height,
    slideOverflow: { x: slideElement.scrollWidth - slideElement.clientWidth, y: slideElement.scrollHeight - slideElement.clientHeight },
    rootOverflow: { x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight },
    characterCount, partialCharacters, occludedCharacters,
    textFontSizes: textElements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    stopVisibleEnabled: !stop.hidden && !stop.disabled && box("#btn-live-stop").bottom <= innerHeight + 1,
    transcriptScrollable: transcriptBody.scrollHeight > transcriptBody.clientHeight,
    transcriptOverflowY: getComputedStyle(transcriptBody).overflowY,
  };
}

const harness = createPublicTestHarness();
const browser = await puppeteer.launch({ args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"] });
const report: Record<string, unknown> = { generatedAt: new Date(now).toISOString(), results: {} };
try {
  for (const viewport of viewports) {
    const page = await browser.newPage();
    await page.emulateTimezone("Asia/Seoul");
    await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
    await page.evaluateOnNewDocument(bootstrap, now);
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
    await page.goto(harness.origin, { waitUntil: "load" });
    await harness.waitForClient();
    await page.evaluate(async () => { await document.fonts.ready; });

    const awaitMutation = async (predicate: string, trigger: () => void) => {
      const waiting = page.evaluate((expression) => new Promise<void>((resolve, reject) => {
        const check = new Function(`return (${expression});`) as () => boolean;
        const deadline = setTimeout(() => { observer.disconnect(); reject(new Error(`timeout: ${expression}`)); }, 2_000);
        const settle = () => { if (check()) { clearTimeout(deadline); observer.disconnect(); resolve(); } };
        const observer = new MutationObserver(settle);
        observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
        settle();
      }), predicate);
      trigger();
      await waiting;
    };

    await awaitMutation('document.querySelector(".app")?.dataset.shell === "live"', () => harness.pushMessage({
      type: "capture", capturing: true, mode: "mic", phase: "capturing", startedAt: now - 125_000,
    }));
    for (let index = 0; index < lines.length; index += 1) {
      await awaitMutation(`document.querySelectorAll("#transcript-stream .feed-line").length === ${index + 1}`,
        () => harness.pushMessage(lines[index]));
    }
    const placeholderGeometry = await page.evaluate(geometry);
    await page.screenshot({ path: join(out, `${viewport.name}-placeholder.png`) });

    await awaitMutation('document.querySelector("#current-slide .slide__title") !== null',
      () => harness.pushMessage({ type: "slide", current: slide, history: [] }));
    const generatedGeometry = await page.evaluate(geometry);
    await page.screenshot({ path: join(out, `${viewport.name}-generated.png`) });

    for (const [state, result] of [["placeholder", placeholderGeometry], ["generated", generatedGeometry]] as const) {
      const failures = [
        Math.abs(result.aspect - 16 / 9) > 0.02 ? "aspect" : "",
        result.slideOverflow.x > 1 || result.slideOverflow.y > 1 ? "slide-overflow" : "",
        result.rootOverflow.x > 0 || result.rootOverflow.y > 0 ? "root-overflow" : "",
        result.partialCharacters.length > 0 ? "partial-glyph" : "",
        result.occludedCharacters.length > 0 ? "occluded-glyph" : "",
        !result.stopVisibleEnabled ? "stop-unreachable" : "",
        !result.transcriptScrollable || !["auto", "scroll"].includes(result.transcriptOverflowY)
          ? "transcript-unreachable" : "",
      ].filter(Boolean);
      if (failures.length > 0) throw new Error(`${viewport.name} ${state}: ${failures.join(", ")}`);
    }

    (report.results as Record<string, unknown>)[viewport.name] = {
      placeholder: placeholderGeometry, generated: generatedGeometry,
    };
    await page.close();
  }
  report.result = "PASS";
} catch (error) {
  report.result = "FAIL";
  report.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  writeFileSync(join(out, "geometry.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  harness.stop();
}
console.log("NARROW STAGE EVIDENCE PASS");
