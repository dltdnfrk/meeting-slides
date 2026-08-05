import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { compileDeckToDisk, renderCompiledOutline } from "../src/deck-compile-action.ts";
import { prepareExportDeck } from "../src/deck-export.ts";
import type { BlockDetector, DeckPlanner } from "../src/llm.ts";
import { MeetingSession, type ServerMessage } from "../src/session.ts";
import { MeetingStore } from "../src/store.ts";
import { createPublicTestHarness } from "./public-test-harness.ts";

const projectDirectory = join(import.meta.dir, "..");
const temporaryDirectories: string[] = [];
const harness = createPublicTestHarness();

function broadcast(message: ServerMessage): void {
  harness.pushMessage(message);
}

function waitForSessionMessage(
  listeners: Set<(message: ServerMessage) => void>,
  predicate: (message: ServerMessage) => boolean,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const listener = (message: ServerMessage) => {
      if (!predicate(message)) return;
      clearTimeout(timeout);
      listeners.delete(listener);
      resolve(message);
    };
    const timeout = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error("session event timeout"));
    }, 5_000);
    listeners.add(listener);
  });
}

async function waitForCard(page: Page, title: string): Promise<void> {
  await page.evaluate((expectedTitle) => {
    const root = document.getElementById("current-slide")!;
    const matches = () => root.querySelector(".slide__title")?.textContent === expectedTitle;
    (globalThis as unknown as { __cardRendered: Promise<void> }).__cardRendered = new Promise((resolve, reject) => {
      if (matches()) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`card render timeout: ${expectedTitle}`));
      }, 5_000);
      const observer = new MutationObserver(() => {
        if (!matches()) return;
        clearTimeout(timeout);
        observer.disconnect();
        resolve();
      });
      observer.observe(root, { childList: true, subtree: true });
    });
  }, title);
}

function publishedOutline(meetingId: number) {
  return {
    meetingId,
    title: "하이브리드 출시 덱",
    style: "clear-editorial",
    slides: [
      { kind: "cover" as const, title: "하이브리드 출시 덱", subtitle: "전체 회의 정리" },
      { kind: "section" as const, title: "배포 범위", kicker: "01", bullets: ["베타 고객부터 시작"] },
      { kind: "summary" as const, title: "핵심 요약", bullets: ["금요일 베타 배포"], emphasis: "일정 고정" },
      { kind: "decision" as const, title: "결정", decision: "금요일에 배포한다", rationale: ["QA 완료"] },
      { kind: "actions" as const, title: "후속 작업", actions: [{ text: "릴리스 노트 작성", owner: "민지", due: "목요일" }] },
      { kind: "closing" as const, title: "마무리", bullets: ["월요일 지표 확인"] },
    ],
  };
}

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith(harness.origin)) void request.continue();
    else void request.abort();
  });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

afterAll(async () => {
  await browser?.close();
  harness.stop();
});

describe("Hybrid live -> compile -> export hermetic path", () => {
  test("renders a detected MeetingCard, persists and publishes kinded registry slides, then prefers compiled export", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meeting-slides-hybrid-e2e-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "meetings.db");
    const store = new MeetingStore(databasePath);
    const meetingId = store.startMeeting("fake-hermetic");
    const detector: BlockDetector = {
      detectBlock: async () => ({
        shouldAdvance: false,
        title: "출시 일정 확정",
        kicker: "라이브 감지",
        bullets: ["베타는 금요일", "QA는 목요일까지"],
        emphasis: "결정: 금요일 베타 배포",
      }),
    };
    const listeners = new Set<(message: ServerMessage) => void>([broadcast]);
    const session = new MeetingSession(detector, 1, 12, listeners, {
      onLine: (line) => store.addLine(line),
      onSlide: (slide) => store.upsertSlide({
        idx: slide.index,
        title: slide.title,
        bullets: slide.bullets,
        startedAt: slide.startedAt,
      }),
    });

    await waitForCard(page, "출시 일정 확정");
    const detectionFinished = waitForSessionMessage(
      listeners,
      (message) => message.type === "detect" && !message.detecting,
    );
    session.onChunk({ text: "금요일에 베타를 배포하고 목요일까지 QA를 끝냅니다.", ts: 1_700_000_000_000, speaker: 1 });
    await Promise.all([
      detectionFinished,
      page.evaluate(() => (globalThis as unknown as { __cardRendered: Promise<void> }).__cardRendered),
    ]);

    const liveCard = await page.evaluate(() => {
      const root = document.getElementById("current-slide")!;
      return {
        kicker: root.querySelector(".slide__kicker")?.textContent,
        title: root.querySelector(".slide__title")?.textContent,
        bullets: [...root.querySelectorAll(".slide__bullets li")].map((item) => item.textContent),
        emphasis: root.querySelector(".slide__emphasis")?.textContent,
      };
    });
    expect(liveCard).toEqual({
      kicker: "라이브 감지",
      title: "출시 일정 확정",
      bullets: ["베타는 금요일", "QA는 목요일까지"],
      emphasis: "핵심결정: 금요일 베타 배포",
    });
    expect(store.lines(meetingId).map((line) => line.text)).toEqual([
      "금요일에 베타를 배포하고 목요일까지 QA를 끝냅니다.",
    ]);
    expect(store.slides(meetingId)).toHaveLength(1);

    const legacy = prepareExportDeck(store, meetingId);
    expect(legacy.source).toBe("legacy");
    expect(legacy.indexHtml).toContain("출시 일정 확정");

    const planner: DeckPlanner = { planDeck: async () => publishedOutline(meetingId) };
    const result = await compileDeckToDisk(store, meetingId, planner, {
      exportsDirectory: join(directory, "exports"),
      projectDirectory,
      now: () => new Date("2026-08-02T12:34:56.000Z"),
    });
    const slidesDirectory = join(result.directory, "slides");
    expect(result.usedFallback).toBe(false);
    expect(readdirSync(slidesDirectory).filter((name) => name.endsWith(".html")).sort()).toEqual([
      "slide-00.html", "slide-01.html", "slide-02.html",
      "slide-03.html", "slide-04.html", "slide-05.html",
    ]);
    const kindMarkers = ["cover", "topic", "summary", "decision", "actions", "closing"];
    for (const [index, marker] of kindMarkers.entries()) {
      expect(readFileSync(join(slidesDirectory, `slide-${String(index).padStart(2, "0")}.html`), "utf-8"))
        .toContain(`class=\"slide-page is-${marker}`);
    }
    expect(existsSync(join(slidesDirectory, "theme.css"))).toBe(true);

    const compiled = prepareExportDeck(store, meetingId);
    expect(compiled.source).toBe("compiled");
    expect(compiled.files).toHaveLength(6);
    expect(compiled.indexHtml).toContain('data-kind="decision"');
    expect(compiled.indexHtml).not.toContain("출시 일정 확정");
    const persisted = store.deckOutline(meetingId);
    expect(persisted?.publishedAt).not.toBeNull();
    expect(persisted?.outline.slides.map((slide) => slide.kind)).toEqual([
      "cover", "section", "summary", "decision", "actions", "closing",
    ]);
    session.reset();
    store.close();

    const reopened = new MeetingStore(databasePath);
    expect(reopened.deckOutline(meetingId)?.outline).toEqual(persisted?.outline);
    reopened.close();
  });

  test("rejects invalid planner output without a fake deck and blocks export while compiling", async () => {
    expect(() => renderCompiledOutline({
      meetingId: 1,
      title: "invalid",
      style: "clear-editorial",
      slides: [{ kind: "model-html", title: "unsafe", html: "<h1>bad</h1>" }],
    })).toThrow(/outline\.slides\[0\]\.kind/);

    const directory = mkdtempSync(join(tmpdir(), "meeting-slides-hybrid-failure-"));
    temporaryDirectories.push(directory);
    const store = new MeetingStore(join(directory, "meetings.db"));
    const meetingId = store.startMeeting("fake-hermetic");
    store.addLine({ ts: 1_700_000_000_000, text: "안전한 요약만 덱에 포함합니다." });
    store.addSlide({ idx: 1, title: "안전한 라이브 카드", bullets: ["모델 HTML 금지"], startedAt: 1_699_999_999_000 });
    let plannerCalls = 0;
    const planner: DeckPlanner = {
      planDeck: async () => {
        plannerCalls += 1;
        return plannerCalls === 1
          ? { ...publishedOutline(meetingId), slides: [{ kind: "model-html", title: "unsafe", html: "<h1>bad</h1>" }] }
          : { ...publishedOutline(meetingId), title: "<script>bad()</script>" };
      },
    };

    const exportsDirectory = join(directory, "exports");
    let plannerError = "";
    try {
      await compileDeckToDisk(store, meetingId, planner, {
        exportsDirectory,
        projectDirectory,
      });
    } catch (error) {
      plannerError = error instanceof Error ? error.message : String(error);
    }
    expect(plannerCalls).toBe(2);
    expect(plannerError).toContain("kind must be cover");
    expect(plannerError).toContain("must not contain HTML");
    expect(store.deckOutline(meetingId)).toBeNull();
    expect(prepareExportDeck(store, meetingId).source).toBe("legacy");

    const exportDirectoryCount = existsSync(exportsDirectory)
      ? readdirSync(exportsDirectory).length
      : 0;
    broadcast({
      type: "export",
      status: "error",
      action: "exportDeck",
      code: "compile-busy",
      error: "Deck compile is in progress; export was not started",
    });
    await page.waitForFunction(
      () => document.getElementById("status-text")?.textContent === "슬라이드를 만드는 중에는 다른 파일을 저장할 수 없습니다",
      { timeout: 5_000 },
    );
    expect(existsSync(exportsDirectory) ? readdirSync(exportsDirectory).length : 0)
      .toBe(exportDirectoryCount);
    store.close();
  });
});
