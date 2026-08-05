import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileDeckToDisk,
  renderCompiledOutline,
  runCompileDeckAction,
} from "../src/deck-compile-action.ts";
import type { DeckPlanner } from "../src/llm.ts";
import type { CompileUpdate } from "../src/session.ts";
import { MeetingStore } from "../src/store.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryExports(): string {
  const directory = mkdtempSync(join(tmpdir(), "meeting-slides-compile-action-"));
  temporaryDirectories.push(directory);
  return join(directory, "exports");
}

function fixture(): { store: MeetingStore; meetingId: number; planner: DeckPlanner } {
  const store = new MeetingStore(":memory:");
  const meetingId = store.startMeeting("fake");
  store.addLine({ ts: 1000, speaker: 1, text: "금요일에 베타를 배포합니다." });
  store.addSlide({ idx: 1, title: "출시", bullets: ["금요일 베타"], startedAt: 900 });
  const planner: DeckPlanner = {
    planDeck: async () => ({
      meetingId,
      title: "출시 준비",
      style: "clear-editorial",
      slides: [
        { kind: "cover", title: "출시 준비", subtitle: "최종 점검" },
        { kind: "section", title: "배포 범위", kicker: "01", bullets: ["베타 고객"] },
        { kind: "summary", title: "요약", bullets: ["금요일 배포"], emphasis: "일정 고정" },
        { kind: "decision", title: "결정", decision: "금요일에 배포한다", rationale: ["QA 완료"] },
        { kind: "actions", title: "할 일", actions: [{ text: "릴리스 노트", owner: "민지" }] },
        { kind: "closing", title: "마무리", bullets: ["월요일 점검"] },
      ],
    }),
  };
  return { store, meetingId, planner };
}

const fixedNow = () => new Date("2026-08-02T12:34:56.000Z");

describe("compiled deck disk action", () => {
  test("fake planner output is persisted with content-derived visuals and no copied image bundle", async () => {
    const { store, meetingId, planner } = fixture();
    const exportsDirectory = temporaryExports();

    const result = await compileDeckToDisk(store, meetingId, planner, { exportsDirectory, now: fixedNow });
    const slidesDirectory = join(result.directory, "slides");
    const htmlFiles = readdirSync(slidesDirectory).filter((file) => file.endsWith(".html")).sort();

    expect(htmlFiles).toEqual([
      "slide-00.html", "slide-01.html", "slide-02.html",
      "slide-03.html", "slide-04.html", "slide-05.html",
    ]);
    expect(store.deckOutline(meetingId)?.outline).toEqual(result.outline);
    expect(store.deckOutline(meetingId)?.publishedAt).not.toBeNull();
    expect(readFileSync(join(slidesDirectory, "slide-02.html"), "utf-8")).toContain('class="slide-page is-summary"');
    expect(readFileSync(join(slidesDirectory, "slide-03.html"), "utf-8")).toContain("금요일에 배포한다");
    expect(readFileSync(join(slidesDirectory, "slide-04.html"), "utf-8")).toContain("릴리스 노트");
    const coverHtml = readFileSync(join(slidesDirectory, "slide-00.html"), "utf-8");
    const topicHtml = readFileSync(join(slidesDirectory, "slide-01.html"), "utf-8");
    expect(coverHtml).toContain('href="./theme.css"');
    expect(coverHtml).toContain('<svg class="cover-visual"');
    expect(topicHtml).toContain('<svg class="topic-map"');
    expect(existsSync(join(slidesDirectory, "theme.css"))).toBe(true);
    expect(existsSync(join(slidesDirectory, "assets"))).toBe(false);
    expect(readdirSync(exportsDirectory).some((name) => name.startsWith("."))).toBe(false);
    store.close();
  });

  test("WebSocket action reports started then success with outline metadata", async () => {
    const { store, meetingId, planner } = fixture();
    const messages: CompileUpdate[] = [];

    const result = await runCompileDeckAction({
      store,
      planner,
      meetingId,
      exportsDirectory: temporaryExports(),
      now: fixedNow,
      send: (message) => messages.push(message),
    });

    expect(result).not.toBeNull();
    expect(messages[0]).toMatchObject({ type: "compile", status: "started", jobId: expect.stringMatching(/^compile-/) });
    expect(messages.filter((message) => message.status === "progress")).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "planning" }),
      expect.objectContaining({ stage: "render", completed: 6, total: 6 }),
      expect.objectContaining({ stage: "publish" }),
    ]));
    const terminal = messages.at(-1);
    expect(terminal).toMatchObject({
      type: "compile",
      status: "success",
      jobId: messages[0]?.jobId,
      meetingId,
      outline: { title: "출시 준비", style: "clear-editorial", slideCount: 6, usedFallback: false, plannerError: null },
    });
    store.close();
  });

  test("invalid outlines are rejected before rendering", () => {
    expect(() => renderCompiledOutline({
      meetingId: 1,
      title: "잘못된 덱",
      style: "clear-editorial",
      slides: [{ kind: "model-html", title: "unsafe", html: "<h1>bad</h1>" }],
    })).toThrow(/outline\.slides\[0\]\.kind/);
  });

  test("unknown meeting IDs return a clean terminal error without planner calls or files", async () => {
    const store = new MeetingStore(":memory:");
    const exportsDirectory = temporaryExports();
    let plannerCalls = 0;
    const messages: CompileUpdate[] = [];
    const planner: DeckPlanner = {
      planDeck: async () => {
        plannerCalls += 1;
        return {};
      },
    };

    const result = await runCompileDeckAction({
      store,
      planner,
      meetingId: 999,
      exportsDirectory,
      send: (message) => messages.push(message),
    });

    expect(result).toBeNull();
    expect(plannerCalls).toBe(0);
    expect(messages.map((message) => message.status)).toEqual(["started", "error"]);
    expect(messages[0]?.jobId).toMatch(/^compile-/);
    expect(messages[1]?.jobId).toBe(messages[0]?.jobId);
    expect(messages[1]?.error).toContain("Meeting 999 was not found");
    expect(existsSync(exportsDirectory)).toBe(false);
    store.close();
  });
});
