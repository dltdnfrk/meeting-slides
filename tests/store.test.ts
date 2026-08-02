import { describe, expect, test } from "bun:test";

import { MeetingStore } from "../src/store.ts";

describe("MeetingStore", () => {
  test("회의 목록은 빈 저장소에서 비어 있다", () => {
    const store = new MeetingStore(":memory:");
    expect(store.listMeetings()).toEqual([]);
    store.close();
  });

  test("회의 목록은 첫 슬라이드 제목과 시작/종료 상태를 노출한다", () => {
    const store = new MeetingStore(":memory:");
    const beforeStart = Date.now();
    const id = store.startMeeting("cli:codex");

    const open = store.listMeetings();
    expect(open).toHaveLength(1);
    expect(open[0]).toEqual({
      id,
      title: `회의 #${id}`,
      started_at: expect.any(Number),
      status: "open",
    });
    expect(open[0].started_at).toBeGreaterThanOrEqual(beforeStart);

    store.addSlide({ idx: 2, title: "두 번째 안건", bullets: [], startedAt: 2000 });
    store.addSlide({ idx: 1, title: "출시 일정", bullets: ["금요일"], startedAt: 1000 });
    store.endMeeting();

    expect(store.listMeetings()).toEqual([{
      id,
      title: "출시 일정",
      started_at: open[0].started_at,
      status: "ended",
    }]);
    store.close();
  });

  test("회의 라이프사이클: 시작 → 라인/슬라이드 → 종료", () => {
    const store = new MeetingStore(":memory:");
    const id = store.startMeeting("cli:codex");
    store.addLine({ ts: 1000, speaker: 1, text: "첫 문장" });
    store.addLine({ ts: 2000, text: "둘째 문장" });
    store.addSlide({ idx: 1, title: "출시 일정", bullets: ["베타 금요일"], startedAt: 1500 });
    store.endMeeting();

    const lines = store.lines(id);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ seq: 1, ts: 1000, speaker: 1, text: "첫 문장" });
    expect(lines[1].speaker).toBeNull();

    const slides = store.slides(id);
    expect(slides).toHaveLength(1);
    expect(slides[0]).toMatchObject({ idx: 1, title: "출시 일정" });
    expect(slides[0].bullets).toEqual(["베타 금요일"]);
    store.close();
  });

  test("회의가 열려있지 않으면 라인/슬라이드 무시", () => {
    const store = new MeetingStore(":memory:");
    store.addLine({ ts: 1, text: "버려짐" });
    store.addSlide({ idx: 1, title: "버려짐", bullets: [], startedAt: 1 });
    expect(store.lines()).toHaveLength(0);
    expect(store.slides()).toHaveLength(0);
    store.close();
  });

  test("Markdown export: 헤더 + 슬라이드 + 전사본", () => {
    const store = new MeetingStore(":memory:");
    store.startMeeting("cli:claude");
    store.addLine({ ts: Date.now(), speaker: 2, text: "안녕하세요" });
    store.addSlide({ idx: 1, title: "인사", bullets: ["시작"], startedAt: Date.now() });
    store.endMeeting();
    const md = store.exportMarkdown();
    expect(md).toContain("# Meeting Notes");
    expect(md).toContain("LLM: cli:claude");
    expect(md).toContain("## 슬라이드 요약");
    expect(md).toContain("01. 인사");
    expect(md).toContain("## 전사본");
    expect(md).toContain("화자 2");
    expect(md).toContain("안녕하세요");
    store.close();
  });

  test("같은 idx 슬라이드 갱신은 upsert되어 export에 최신 불렛이 남는다", () => {
    const store = new MeetingStore(":memory:");
    store.startMeeting("cli:codex");
    store.addSlide({
      idx: 1,
      title: "출시 일정",
      bullets: ["초기 초안"],
      startedAt: 1000,
    });
    store.upsertSlide({
      idx: 1,
      title: "출시 일정 (확정)",
      bullets: ["베타 금요일", "QA 목요일"],
      startedAt: 1000,
    });

    const slides = store.slides();
    expect(slides).toHaveLength(1);
    expect(slides[0].title).toBe("출시 일정 (확정)");
    expect(slides[0].bullets).toEqual(["베타 금요일", "QA 목요일"]);

    const md = store.exportMarkdown();
    expect(md).toContain("베타 금요일");
    expect(md).toContain("QA 목요일");
    expect(md).not.toContain("초기 초안");
    store.close();
  });
});
