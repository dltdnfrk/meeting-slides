import { describe, expect, test } from "bun:test";

import { MeetingSession, type ServerMessage } from "../src/session.ts";
import { MeetingStore } from "../src/store.ts";
import { buildDeckHtml } from "../src/deck.ts";
import type { BlockDetector, BlockDetectionResult } from "../src/llm.ts";

describe("same-topic slide persistence end-to-end", () => {
  test("세션 같은 토픽 갱신 → SQLite → deck export에 최신 불렛", async () => {
    const store = new MeetingStore(":memory:");
    store.startMeeting("cli:codex");

    const listeners = new Set<(m: ServerMessage) => void>();
    let call = 0;
    const llm = {
      detectBlock: async (): Promise<BlockDetectionResult> => {
        call++;
        return {
          shouldAdvance: false,
          title: "출시 일정",
          bullets: call === 1 ? ["초기 초안"] : ["베타 금요일", "QA 목요일"],
        };
      },
    } as unknown as BlockDetector;

    const session = new MeetingSession(llm, 1, 12, listeners, {
      onLine: (entry) => store.addLine(entry),
      onSlide: (slide) => store.upsertSlide({
        idx: slide.index,
        title: slide.title,
        bullets: slide.bullets,
        startedAt: slide.startedAt,
      }),
    });

    session.onChunk({ text: "일정 초안을 말합니다", ts: 1000 });
    await session.flush();
    session.onChunk({ text: "베타와 QA 날짜를 확정합니다", ts: 2000 });
    await session.flush();

    const slides = store.slides();
    expect(slides).toHaveLength(1);
    expect(slides[0].bullets).toEqual(["베타 금요일", "QA 목요일"]);

    const html = buildDeckHtml({
      title: "Meeting Notes",
      startedAt: Date.now(),
      provider: "cli:codex",
      slides,
      lines: store.lines(),
    });
    expect(html).toContain("베타 금요일");
    expect(html).toContain("QA 목요일");
    expect(html).not.toContain("초기 초안");
    store.close();
  });
});
