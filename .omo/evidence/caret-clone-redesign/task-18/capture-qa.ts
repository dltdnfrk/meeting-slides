import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { createPublicTestHarness } from "../../../../tests/public-test-harness.ts";

const out = import.meta.dir;
await rm(join(out, "screenshots"), { recursive: true, force: true });
await mkdir(join(out, "screenshots"), { recursive: true });
const harness = createPublicTestHarness();
const browser = await puppeteer.launch({ args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"] });
const viewports = [
  { width: 1280, height: 800 }, { width: 960, height: 760 }, { width: 820, height: 900 },
  { width: 375, height: 812 }, { width: 320, height: 667 },
];
const states = ["library-empty", "library-populated", "library-notes", "library-transcript", "live-starting", "live-capturing", "live-disconnected", "live-stopping", "live-error"];
const now = 1_710_376_860_000;
const meeting = { type: "meetings", items: [{ id: 101, title: "제품 로드맵 정렬", started_at: now - 86_400_000, status: "ended" }] };
const detail = { type: "meeting", meetingId: 101, title: "제품 로드맵 정렬", transcript: [{ text: "확정된 회의 발언입니다.", ts: now - 3_000, speaker: 1 }], current: { index: 1, startedAt: now - 60_000, sentenceCount: 6, kind: "topic", title: "온보딩 지표 점검", kicker: "제품 로드맵", bullets: ["범위 합의", "위험 공유"] }, history: [], compiled: null };
const live = { type: "capture", capturing: true, mode: "mic", phase: "capturing", startedAt: now - 125_000 };

const results: unknown[] = [];
try {
  for (const viewport of viewports) for (const state of states) {
    const page = await browser.newPage();
    const waiters = new Map<string, () => void>();
    await page.exposeFunction("__qaDone", (token: string) => waiters.get(token)?.());
    await page.evaluateOnNewDocument((fixed: number) => {
      const OriginalDate = Date;
      class FrozenDate extends OriginalDate {
        constructor(...args: any[]) { args.length === 0 ? super(fixed) : super(...args); }
        static override now() { return fixed; }
      }
      (globalThis as any).Date = FrozenDate;
      (globalThis as any).__qaArm = (token: string, expression: string) => {
        const test = new Function(`return (${expression})`);
        const observer = new MutationObserver(() => {
          if (!test()) return;
          observer.disconnect();
          (globalThis as any).__qaDone(token);
        });
        observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
        if (test()) { observer.disconnect(); (globalThis as any).__qaDone(token); }
      };
    }, now);
    await page.emulateTimezone("Asia/Seoul");
    await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    await page.goto(harness.origin, { waitUntil: "load" });
    await harness.waitForClient();
    await page.evaluate(() => document.fonts.ready);
    let sequence = 0;
    const act = async (predicate: string, trigger: () => void | Promise<void>) => {
      const token = `qa-${++sequence}`;
      const signal = new Promise<void>((resolve) => waiters.set(token, resolve));
      await page.evaluate((t, p) => (globalThis as any).__qaArm(t, p), token, predicate);
      await trigger();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([signal, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`QA timeout: ${predicate}`)), 3000); })]);
      } finally { if (timer) clearTimeout(timer); waiters.delete(token); }
    };
    if (state === "library-empty") {
      await act('document.querySelectorAll("#session-list .session-row").length === 0', () => harness.pushMessage({ type: "meetings", items: [] }));
    } else if (state.startsWith("library-")) {
      await act('document.querySelectorAll("#session-list .session-row").length === 1', () => harness.pushMessage(meeting));
      await act('document.querySelector("#session-list .session-row--selected") !== null', () => page.click("#session-list .session-row"));
      await act('document.querySelector("#current-slide .slide__title") !== null', () => harness.pushMessage(detail));
      if (state === "library-notes") await act('document.querySelector(".app").dataset.detailTab === "notes"', () => page.click("#detail-tab-notes"));
      if (state === "library-transcript") await act('document.querySelector(".app").dataset.detailTab === "transcript"', () => page.click("#detail-tab-transcript"));
    } else {
      await act('document.querySelector(".app").dataset.capturePhase === "starting"', () => harness.pushMessage({ type: "capture", capturing: false, mode: "mic", phase: "starting" }));
      if (state !== "live-starting") await act('document.querySelector(".app").dataset.capturePhase === "capturing"', () => harness.pushMessage(live));
      if (["live-capturing", "live-disconnected", "live-stopping"].includes(state)) {
        await act('document.querySelector("#current-slide .slide__title") !== null', () => harness.pushMessage({ type: "slide", current: detail.current, history: [] }));
        await act('document.querySelectorAll("#transcript-stream .feed-line").length === 1', () => harness.pushMessage({ type: "line", text: "확정된 라이브 발언입니다.", ts: now - 3_000, speaker: 1 }));
      }
      if (state === "live-disconnected") await act('document.documentElement.dataset.connection === "disconnected"', () => harness.disconnectClients());
      if (state === "live-stopping") await act('document.querySelector(".app").dataset.capturePhase === "stopping"', () => harness.pushMessage({ type: "capture", capturing: true, mode: "mic", phase: "stopping", startedAt: now - 125_000 }));
      if (state === "live-error") await page.evaluate(() => {
        const app = document.querySelector(".app") as HTMLElement;
        app.dataset.capturePhase = "error";
        app.dataset.uiState = "capture-error";
        app.dataset.shell = "live";
        const status = document.getElementById("status-text")!;
        status.textContent = "녹음을 시작하지 못했습니다: 입력 장치를 열 수 없습니다";
      });
    }
    const metrics = await page.evaluate(() => {
      const visible = (node: Element) => { const s = getComputedStyle(node); const r = node.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0; };
      const controls = [...document.querySelectorAll("button,a,summary,input,textarea,select,[tabindex]")]
        .filter((node) => !node.hasAttribute("disabled") && node.getAttribute("tabindex") !== "-1")
        .filter(visible) as HTMLElement[];
      const boxes = controls.map((node) => { const r = node.getBoundingClientRect(); return { id: node.id || node.className, width: r.width, height: r.height }; });
      const status = document.getElementById("status-text")!;
      const statusStyle = getComputedStyle(status);
      return {
        shell: (document.querySelector(".app") as HTMLElement).dataset.shell,
        phase: (document.querySelector(".app") as HTMLElement).dataset.capturePhase,
        detail: (document.querySelector(".app") as HTMLElement).dataset.detailTab,
        connection: document.documentElement.dataset.connection,
        rootOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        duplicateIds: [...document.querySelectorAll("[id]")].map(n => n.id).filter((id, i, ids) => ids.indexOf(id) !== i),
        minTarget: boxes.reduce((min, b) => Math.min(min, b.width, b.height), Infinity),
        narrowTargetFailures: innerWidth <= 375 ? boxes.filter(b => b.width < 44 || b.height < 44) : [],
        status: { text: status.textContent, display: statusStyle.display, color: statusStyle.color, role: status.getAttribute("role") },
        activeRemovedReferences: [...document.styleSheets].map(s => new URL(s.href ?? location.href).pathname).filter(p => /workspace-shell|operational-liquid|caret-shell|caret-foundation|transcript-overlay/.test(p)),
        stopVisible: document.getElementById("btn-live-stop") ? visible(document.getElementById("btn-live-stop")!) : false,
        transcriptLines: document.querySelectorAll("#transcript-stream .feed-line").length,
      };
    });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => ({
      id: (document.activeElement as HTMLElement)?.id,
      outline: getComputedStyle(document.activeElement!).outlineStyle,
      width: getComputedStyle(document.activeElement!).outlineWidth,
      shadow: getComputedStyle(document.activeElement!).boxShadow,
    }));
    const ax = await page.accessibility.snapshot({ interestingOnly: false });
    const name = `${viewport.width}x${viewport.height}-${state}`;
    await page.screenshot({ path: join(out, "screenshots", `${name}.png`) });
    await writeFile(join(out, "screenshots", `${name}.ax.json`), JSON.stringify(ax, null, 2));
    await writeFile(join(out, "screenshots", `${name}.styles.json`), JSON.stringify({ metrics, focused }, null, 2));
    results.push({ viewport, state, metrics, focused });
    await page.close();
  }
} finally {
  await browser.close();
  harness.stop();
}
await writeFile(join(out, "browser-qa-summary.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ captures: results.length, screenshots: results.length, ax: results.length, styles: results.length }));
