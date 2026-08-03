import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileDeckOutline,
  validatePlannedOutline,
} from "../src/deck-compiler.ts";
import type { DeckPlanner, DeckPlannerInput, DeckPlannerRepair } from "../src/llm.ts";
import type { DeckOutline } from "../src/slide-spec.ts";
import { MeetingStore } from "../src/store.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureOutline(meetingId: number): DeckOutline {
  return {
    meetingId,
    title: "출시 준비 회의",
    style: "clear-editorial",
    slides: [
      { kind: "cover", title: "출시 준비 회의", subtitle: "최종 점검" },
      { kind: "summary", title: "핵심 요약", bullets: ["금요일 베타 배포"] },
      { kind: "decision", title: "결정", decision: "금요일에 배포한다" },
      { kind: "actions", title: "할 일", actions: [{ text: "릴리스 노트 작성", owner: "민지" }] },
      { kind: "closing", title: "마무리", bullets: ["다음 점검은 월요일"] },
    ],
  };
}

function populatedStore(): { store: MeetingStore; meetingId: number } {
  const store = new MeetingStore(":memory:");
  const meetingId = store.startMeeting("fake");
  store.addLine({ ts: 1000, speaker: 1, text: "금요일에 베타를 배포합니다." });
  store.addLine({ ts: 2000, speaker: 2, text: "민지가 릴리스 노트를 작성합니다." });
  store.addSlide({ idx: 1, title: "출시 일정", bullets: ["금요일 베타"], startedAt: 900 });
  return { store, meetingId };
}

describe("deck outline planner", () => {
  test("passes the full transcript and live anchors to a hermetic fake planner", async () => {
    const { store, meetingId } = populatedStore();
    const calls: Array<{ input: DeckPlannerInput; repair?: DeckPlannerRepair }> = [];
    const planner: DeckPlanner = {
      planDeck: async (input, repair) => {
        calls.push({ input, repair });
        return JSON.stringify(fixtureOutline(meetingId));
      },
    };

    const result = await compileDeckOutline(store, meetingId, planner);
    expect(result.usedFallback).toBe(false);
    expect(result.plannerError).toBeNull();
    expect(result.outline.slides.map((slide) => slide.kind)).toEqual([
      "cover", "summary", "decision", "actions", "closing",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.transcript.map((line) => line.text)).toEqual([
      "금요일에 베타를 배포합니다.",
      "민지가 릴리스 노트를 작성합니다.",
    ]);
    expect(calls[0]!.input.liveSlideAnchors[0]?.title).toBe("출시 일정");
    expect(store.deckOutline(meetingId)?.outline).toEqual(result.outline);
    store.close();
  });

  test("retries once with the validation error and accepts a repaired outline", async () => {
    const { store, meetingId } = populatedStore();
    const repairs: Array<DeckPlannerRepair | undefined> = [];
    const planner: DeckPlanner = {
      planDeck: async (_input, repair) => {
        repairs.push(repair);
        return repair === undefined ? { meetingId, html: "<h1>bad</h1>" } : fixtureOutline(meetingId);
      },
    };

    const result = await compileDeckOutline(store, meetingId, planner);
    expect(result.usedFallback).toBe(false);
    expect(repairs).toHaveLength(2);
    expect(repairs[0]).toBeUndefined();
    expect(repairs[1]?.validationError).toContain("not allowed");
    expect(store.deckOutline(meetingId)?.plannerError).toBeNull();
    store.close();
  });

  test("two invalid responses fail without persisting a fake deck", async () => {
    const { store, meetingId } = populatedStore();
    let calls = 0;
    const planner: DeckPlanner = {
      planDeck: async () => {
        calls += 1;
        return "not json";
      },
    };

    let failure = "";
    try {
      await compileDeckOutline(store, meetingId, planner);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toMatch(/attempt 1:.*attempt 2:/);
    expect(calls).toBe(2);
    expect(store.deckOutline(meetingId)).toBeNull();
    store.close();
  });

  test("rejects invalid narrative shape and model HTML before persistence", () => {
    const outline = fixtureOutline(7);
    expect(() => validatePlannedOutline({ ...outline, slides: outline.slides.slice(1) }, 7)).toThrow(/cover/);
    expect(() => validatePlannedOutline({
      ...outline,
      slides: [{ kind: "cover", title: "<h1>Injected</h1>" }, ...outline.slides.slice(1)],
    }, 7)).toThrow(/HTML/);
    expect(() => validatePlannedOutline(outline, 8)).toThrow(/meetingId/);
  });
});

describe("deck outline persistence", () => {
  test("round-trips outline metadata and canonical specs after reopening SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "meeting-slides-compiler-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "meetings.db");
    const store = new MeetingStore(path);
    const meetingId = store.startMeeting("fake");
    const outline = fixtureOutline(meetingId);
    store.saveDeckOutline(outline, "planner fallback used");
    store.close();

    const reopened = new MeetingStore(path);
    const stored = reopened.deckOutline(meetingId);
    expect(stored?.outline).toEqual(outline);
    expect(stored?.plannerError).toBe("planner fallback used");
    expect(stored?.compiledAt).toBeGreaterThan(0);
    reopened.close();
  });
});
