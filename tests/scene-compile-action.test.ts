import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ChatTransport } from "../src/llm.ts";
import { prepareExportDeck } from "../src/deck-export.ts";
import { compileSceneDeckToDisk, runSceneCompileAction } from "../src/scene-compile-action.ts";
import { MeetingStore } from "../src/store.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("semantic scene compile action", () => {
  test("publishes HTML, Scene JSON, and native PPTX from one narrative plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-scenes-"));
    temporaryDirectories.push(root);
    const store = new MeetingStore(":memory:");
    const meetingId = store.startMeeting("fake");
    store.addLine({ ts: 1, speaker: 1, text: "9월 1일 출시를 확정했습니다." });
    const transport: ChatTransport = {
      chat: async () => JSON.stringify({
        meetingId,
        title: "출시 회의",
        slides: [
          { intent: "cover", title: "출시 회의" },
          { intent: "decision", title: "출시일 확정", decision: "9월 1일에 출시한다", rationale: "QA가 완료됐다" },
        ],
      }),
    };

    const result = await compileSceneDeckToDisk(store, meetingId, transport, {
      exportsDirectory: join(root, "exports"),
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });

    expect(existsSync(result.pptxPath)).toBe(true);
    expect(existsSync(join(result.directory, "scene.json"))).toBe(true);
    expect(existsSync(join(result.directory, "slides", "slide-00.html"))).toBe(true);
    expect(readFileSync(join(result.directory, "slides", "slide-01.html"), "utf-8")).not.toMatch(/<(?:ul|li)\b/);
    expect(result.scene.slides[1]?.intent).toBe("decision");
    expect(prepareExportDeck(store, meetingId).source).toBe("scene");
    store.close();
  });

  test("success message includes the generated scene so the app can preview every slide", async () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-scenes-message-"));
    temporaryDirectories.push(root);
    const store = new MeetingStore(":memory:");
    const meetingId = store.startMeeting("fake");
    store.addLine({ ts: 1, text: "금요일 출시를 확정했습니다." });
    const transport: ChatTransport = { chat: async () => JSON.stringify({
      meetingId,
      title: "출시 결정",
      slides: [
        { intent: "cover", title: "출시 결정" },
        { intent: "decision", title: "출시일", decision: "금요일에 출시한다" },
      ],
    }) };
    const messages: unknown[] = [];

    const result = await runSceneCompileAction({
      store,
      transport,
      meetingId,
      exportsDirectory: join(root, "exports"),
      send: (message) => messages.push(message),
    });

    expect(result).not.toBeNull();
    expect(messages.at(-1)).toMatchObject({
      type: "compile",
      status: "success",
      outline: { title: "출시 결정", slideCount: 2 },
      scene: { title: "출시 결정", slides: expect.arrayContaining([
        expect.objectContaining({ intent: "cover" }),
        expect.objectContaining({ intent: "decision" }),
      ]) },
    });
    store.close();
  });

  test("invalid planner output falls back to prose scenes instead of bullet slides", async () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-scenes-fallback-"));
    temporaryDirectories.push(root);
    const store = new MeetingStore(":memory:");
    const meetingId = store.startMeeting("fake");
    store.addLine({ ts: 1, text: "고객 피드백에서 검색 속도 문제가 확인됐습니다." });
    store.addLine({ ts: 2, text: "인덱스 최적화를 다음 배포에 포함하기로 했습니다." });
    const transport: ChatTransport = { chat: async () => '{"slides":[{"bullets":["legacy"]}]}' };

    const result = await compileSceneDeckToDisk(store, meetingId, transport, {
      exportsDirectory: join(root, "exports"),
    });

    expect(result.usedFallback).toBe(true);
    expect(JSON.stringify(result.scene)).not.toContain('"bullets"');
    expect(result.scene.slides.some((slide) => slide.intent === "statement")).toBe(true);
    store.close();
  });

  test("compile uses the exact transcript snapshot captured before planning starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-scenes-snapshot-"));
    temporaryDirectories.push(root);
    const store = new MeetingStore(":memory:");
    const meetingId = store.startMeeting("fake");
    store.addLine({ ts: 1, text: "버튼을 누르기 전까지의 전사입니다." });
    const transport: ChatTransport = {
      chat: async () => {
        store.addLine({ ts: 2, text: "컴파일 시작 뒤에 들어온 늦은 전사입니다." });
        return "invalid";
      },
    };

    const result = await compileSceneDeckToDisk(store, meetingId, transport, {
      exportsDirectory: join(root, "exports"),
    });

    expect(result.usedFallback).toBe(true);
    expect(JSON.stringify(result.scene)).toContain("버튼을 누르기 전까지의 전사입니다.");
    expect(JSON.stringify(result.scene)).not.toContain("컴파일 시작 뒤에 들어온 늦은 전사입니다.");
    store.close();
  });
});

test("fallback narrative drops trailing chatter and caps slide count", async () => {
  const root = mkdtempSync(join(tmpdir(), "meeting-scenes-fallback-cap-"));
  temporaryDirectories.push(root);
  const store = new MeetingStore(":memory:");
  const meetingId = store.startMeeting("fake");
  const body = [
    "투자 검토에서는 팀 구성을 중요하게 봅니다.",
    "핵심 인력 2~3명의 지분 구조를 선호하는 분위기가 있습니다.",
    "고객사 리스트와 대기업 유지 동인을 확인합니다.",
    "장기 계약 조건을 근거로 보여줄 수 있으면 설득력이 높습니다.",
    "다음 주 실습은 기업당 5분 발표와 5분 피드백으로 진행합니다.",
  ];
  for (const [index, text] of body.entries()) store.addLine({ ts: index + 1, text });
  for (let i = 0; i < 20; i += 1) store.addLine({ ts: 100 + i, text: "감사합니다" });
  for (let i = 0; i < 10; i += 1) store.addLine({ ts: 200 + i, text: "아이고아이고아이고" });
  const transport: ChatTransport = { chat: async () => "not-json" };

  const result = await compileSceneDeckToDisk(store, meetingId, transport, {
    exportsDirectory: join(root, "exports"),
  });

  expect(result.usedFallback).toBe(true);
  expect(result.scene.slides.length).toBeLessThanOrEqual(8);
  expect(JSON.stringify(result.scene)).toContain("팀 구성");
  expect(JSON.stringify(result.scene)).not.toContain("아이고아이고");
  store.close();
});
