// Todo 11 manual QA driver: drives the REAL library shell in Chromium across the
// plan's six canonical viewports, in the happy path and in bad/reconnect states,
// and records screenshots, geometry and the accessibility projection.
//
// Deterministic: frozen clock, ko-KR / Asia/Seoul, DPR 1, every off-origin
// request refused, and every awaited state subscribed to before its trigger.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "../../../../../tests/public-test-harness.ts";

const outDir = import.meta.dir;
const shotDir = join(outDir, "screenshots");
const FIXED = 1_710_376_860_000;

const VIEWPORTS = [
  { name: "1440x900-reference", width: 1440, height: 900 },
  { name: "1244x836-library", width: 1244, height: 836 },
  { name: "1100x800-seam", width: 1100, height: 800 },
  { name: "960x760-live", width: 960, height: 760 },
  { name: "820x900-stacked", width: 820, height: 900 },
  { name: "375x812-narrow", width: 375, height: 812 },
  { name: "320x667-compact", width: 320, height: 667 },
];

const MEETINGS = {
  type: "meetings",
  items: [
    { id: 101, title: "제품 로드맵 정렬", started_at: FIXED - 86_400_000, status: "ended" },
    { id: 102, title: "고객 온보딩 리뷰", started_at: FIXED - 172_800_000, status: "ended" },
    { id: 103, title: "분기 회고", started_at: FIXED - 259_200_000, status: "ended" },
  ],
};

const TRANSCRIPT = Array.from({ length: 15 }, (_, i) => ({
  text: [
    "이번 분기 로드맵을 먼저 정렬하고 시작하겠습니다.",
    "온보딩 이탈률이 지난달보다 12퍼센트 줄었습니다.",
    "설치 시간은 평균 4분에서 2분 30초로 짧아졌습니다.",
    "튜토리얼 단계가 여전히 많다는 피드백이 반복됩니다.",
    "그래서 네 단계로 줄이는 방안을 제안합니다.",
    "지원팀 문의 중 절반이 3단계에서 발생했습니다.",
    "그 구간의 문구를 다시 쓰는 것이 우선입니다.",
    "디자인 리소스는 이번 주에 확보할 수 있습니다.",
    "그러면 다음 스프린트에 바로 반영 가능합니다.",
    "지표는 주간 대시보드로 계속 확인하겠습니다.",
    "고객사 두 곳에서 베타 참여 의사를 밝혔습니다.",
    "베타 범위는 온보딩 흐름으로만 한정합니다.",
    "각 팀 리드가 금요일까지 범위를 확정합니다.",
    "리뷰 결과는 회의록으로 공유하겠습니다.",
    "추가 논의는 다음 정기 회의에서 이어가겠습니다.",
  ][i]!,
  ts: FIXED - (15 - i) * 3_000,
  speaker: (i % 2) + 1,
}));

const MEETING_101 = {
  type: "meeting",
  meetingId: 101,
  title: "제품 로드맵 정렬",
  transcript: TRANSCRIPT,
  current: {
    index: 2, startedAt: FIXED - 120_000, sentenceCount: 8, kind: "topic",
    title: "온보딩 지표 점검", kicker: "제품 로드맵",
    bullets: ["이탈률 12% 감소", "설치 시간 단축", "가이드 재작성"],
    emphasis: "결정: 온보딩 튜토리얼을 4단계로 축소",
  },
  history: [{
    index: 1, startedAt: FIXED - 240_000, sentenceCount: 6, kind: "cover",
    title: "2분기 로드맵 정렬", kicker: "제품 로드맵", bullets: ["범위 합의", "위험 공유"],
  }],
  compiled: null,
};

function bootstrap(now: number): void {
  const OriginalDate = Date;
  class FrozenDate extends OriginalDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static override now(): number { return now; }
  }
  (globalThis as unknown as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;
  (window as unknown as { __await?: unknown }).__await = (token: string, predicate: string) => {
    const test = new Function(`return (${predicate});`) as () => boolean;
    let done = false;
    const settle = (): boolean => {
      if (done) return true;
      let ok = false;
      try { ok = test() === true; } catch { ok = false; }
      if (!ok) return false;
      done = true;
      void (window as unknown as { __settle: (t: string) => void }).__settle(token);
      return true;
    };
    if (settle()) return;
    const observer = new MutationObserver(() => { if (settle()) observer.disconnect(); });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  };
}

const harness = createPublicTestHarness();
const browser: Browser = await puppeteer.launch({
  args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"],
});
await mkdir(shotDir, { recursive: true });

const offOrigin: string[] = [];
const report: Record<string, unknown> = {};

async function open(width: number, height: number): Promise<{ page: Page; act: (p: string, t: () => void | Promise<void>) => Promise<void> }> {
  const page = await browser.newPage();
  const waiters = new Map<string, () => void>();
  await page.exposeFunction("__settle", (token: string) => waiters.get(token)?.());
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  await page.evaluateOnNewDocument(bootstrap, FIXED);
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith(harness.origin) || url.startsWith("data:") || url === "about:blank") {
      void request.continue();
      return;
    }
    offOrigin.push(url);
    void request.abort();
  });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.waitForClient();
  await page.evaluate(async () => { await document.fonts.ready; });

  let n = 0;
  const act = async (predicate: string, trigger: () => void | Promise<void>): Promise<void> => {
    const token = `qa-${(n += 1)}`;
    const settled = new Promise<void>((resolve) => waiters.set(token, resolve));
    await page.evaluate((t: string, p: string) => (window as unknown as { __await: (t: string, p: string) => void }).__await(t, p), token, predicate);
    await trigger();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<never>((_r, reject) => {
      timer = setTimeout(() => reject(new Error(`QA timeout waiting for: ${predicate}`)), 4_000);
    });
    try { await Promise.race([settled, bounded]); } finally { if (timer) clearTimeout(timer); waiters.delete(token); }
  };
  return { page, act };
}

function probe() {
  const app = document.querySelector(".app") as HTMLElement;
  const vis = (sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el || el.hidden) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const box = (sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    state: {
      connection: document.documentElement.dataset.connection,
      shell: app?.dataset.shell,
      capturePhase: app?.dataset.capturePhase,
      detailTab: app?.dataset.detailTab,
      stageState: app?.dataset.stageState,
      uiState: app?.dataset.uiState,
    },
    visible: {
      rail: vis("#session-rail"),
      stage: vis("#stage-pane"),
      notes: vis("#notes-panel"),
      transcript: vis("#transcript-pane"),
    },
    geometry: {
      rail: box("#session-rail"),
      document: box("#document-surface"),
      stage: box("#stage-pane"),
      transcript: box("#transcript-pane"),
      dock: box(".dock"),
    },
    aria: {
      tablists: document.querySelectorAll('[role="tablist"]').length,
      tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => ({
        id: t.id,
        selected: t.getAttribute("aria-selected"),
        tabindex: t.getAttribute("tabindex"),
        controls: t.getAttribute("aria-controls"),
      })),
      visiblePanels: [...document.querySelectorAll('[role="tabpanel"]')]
        .filter((p) => !(p as HTMLElement).hidden).map((p) => p.id),
    },
    rootOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    transcriptLines: document.querySelectorAll("#transcript-stream .feed-line").length,
    duplicateIds: [...document.querySelectorAll("[id]")]
      .map((n) => n.id)
      .filter((id, i, all) => all.indexOf(id) !== i),
  };
}

// ── happy path across the six widths ────────────────────────────────────────
for (const vp of VIEWPORTS) {
  const { page, act } = await open(vp.width, vp.height);
  try {
    await act('document.querySelector(".app")?.dataset.capturePhase === "idle"',
      () => harness.pushMessage({ type: "capture", capturing: false, mode: "mic", phase: "idle" }));
    await act('document.querySelectorAll("#session-list .session-row").length === 3',
      () => harness.pushMessage(MEETINGS));

    await page.screenshot({ path: join(shotDir, `${vp.name}-01-library-empty-selection.png`) });

    await act('document.querySelectorAll("#session-list .session-row--selected").length === 1',
      () => page.click('#session-list .session-row[data-meeting-id="101"]'));
    await act('document.querySelectorAll("#transcript-stream .feed-line").length === 15',
      () => harness.pushMessage(MEETING_101));

    const overview = await page.evaluate(probe);
    await page.screenshot({ path: join(shotDir, `${vp.name}-02-overview.png`) });

    await act('document.querySelector(".app")?.dataset.detailTab === "notes"',
      () => page.click("#detail-tab-notes"));
    await page.focus("#notes-input");
    await page.keyboard.type("결정: 튜토리얼 4단계 축소. 담당 김현준, 금요일까지.");
    const notes = await page.evaluate(probe);
    await page.screenshot({ path: join(shotDir, `${vp.name}-03-notes.png`) });

    await act('document.querySelector(".app")?.dataset.detailTab === "transcript"',
      () => page.click("#detail-tab-transcript"));
    const transcript = await page.evaluate(probe);
    await page.screenshot({ path: join(shotDir, `${vp.name}-04-transcript.png`) });

    // keyboard round trip: End -> Home via the roving tablist
    await page.focus("#detail-tab-transcript");
    await act('document.querySelector(".app")?.dataset.detailTab === "overview"',
      () => page.keyboard.press("Home"));
    const afterHome = await page.evaluate(probe);

    report[vp.name] = { overview, notes, transcript, afterHome };
  } finally {
    await page.close();
  }
}

// ── bad / reconnect states at the library reference width ───────────────────
{
  const { page, act } = await open(1244, 836);
  try {
    await act('document.querySelector(".app")?.dataset.capturePhase === "idle"',
      () => harness.pushMessage({ type: "capture", capturing: false, mode: "mic", phase: "idle" }));

    // empty library
    await act('document.getElementById("session-empty")?.hasAttribute("hidden") === false',
      () => harness.pushMessage({ type: "meetings", items: [] }));
    const empty = await page.evaluate(probe);
    await page.screenshot({ path: join(shotDir, "state-01-empty-library.png") });

    await act('document.querySelectorAll("#session-list .session-row").length === 3',
      () => harness.pushMessage(MEETINGS));
    await act('document.querySelectorAll("#session-list .session-row--selected").length === 1',
      () => page.click('#session-list .session-row[data-meeting-id="101"]'));
    await act('document.querySelectorAll("#transcript-stream .feed-line").length === 15',
      () => harness.pushMessage(MEETING_101));

    // malformed frames must be dropped without disturbing the shell
    harness.pushMessage({ type: "meeting", meetingId: "nope", transcript: null });
    harness.pushMessage({ type: "transcript", entries: "bad", reason: "snapshot" });
    harness.pushMessage({ garbage: true });
    await act('document.querySelectorAll("#session-list .session-row").length === 3',
      () => harness.pushMessage(MEETINGS));
    const afterMalformed = await page.evaluate(probe);
    await page.screenshot({ path: join(shotDir, "state-02-after-malformed.png") });

    // reconnect: transport drops, content is retained
    await act('["reconnecting","disconnected"].includes(document.documentElement.dataset.connection ?? "")',
      () => harness.disconnectClients());
    const reconnecting = await page.evaluate(probe);
    await page.screenshot({ path: join(shotDir, "state-03-reconnecting.png") });

    report["states"] = { empty, afterMalformed, reconnecting };
  } finally {
    await page.close();
  }
}

report["offOriginRequests"] = offOrigin;
await writeFile(join(outDir, "qa-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log("off-origin requests:", offOrigin.length);
for (const [key, value] of Object.entries(report)) {
  if (key === "offOriginRequests") continue;
  const v = value as Record<string, { rootOverflow?: number; aria?: { visiblePanels: string[] } }>;
  const first = Object.values(v)[0];
  console.log(key, "overflow:", first?.rootOverflow, "panels:", JSON.stringify(first?.aria?.visiblePanels));
}

await browser.close();
harness.stop();
