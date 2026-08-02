import { describe, expect, test } from "bun:test";

import { prepareExportDeck } from "../src/deck-export.ts";
import type { DeckOutline } from "../src/slide-spec.ts";
import { MeetingStore } from "../src/store.ts";

function fixture(): { store: MeetingStore; meetingId: number; outline: DeckOutline } {
  const store = new MeetingStore(":memory:");
  const meetingId = store.startMeeting("fake");
  store.addLine({ ts: 1000, text: "금요일에 배포합니다." });
  store.addSlide({ idx: 1, title: "라이브 출시", bullets: ["초안 일정"], startedAt: 900 });
  return {
    store,
    meetingId,
    outline: {
      meetingId,
      title: "컴파일된 출시 덱",
      style: "clear-editorial",
      slides: [
        { kind: "cover", title: "컴파일된 출시 덱", subtitle: "최종본" },
        { kind: "decision", title: "결정", decision: "금요일 배포", rationale: ["QA 완료"] },
        { kind: "actions", title: "후속 작업", actions: [{ text: "릴리스 노트", owner: "민지" }] },
        { kind: "closing", title: "마무리", bullets: ["월요일 지표 확인"] },
      ],
    },
  };
}

describe("export deck source preference", () => {
  test("without a successful compile it explicitly exports legacy live history", () => {
    const { store, meetingId, outline } = fixture();

    expect(prepareExportDeck(store, meetingId)).toMatchObject({ source: "legacy", slideCount: 3 });
    // A planner result alone is not a successful disk compile and must not displace the safe fallback.
    store.saveDeckOutline(outline);
    const unpublished = prepareExportDeck(store, meetingId);
    expect(unpublished.source).toBe("legacy");
    expect(unpublished.indexHtml).toContain("라이브 출시");
    store.close();
  });

  test("after successful publish export lists registry-rendered compiled kinds", () => {
    const { store, meetingId, outline } = fixture();
    store.saveDeckOutline(outline);
    store.markDeckPublished(meetingId, 1_700_000_000_000);

    const material = prepareExportDeck(store, meetingId);

    expect(material.source).toBe("compiled");
    expect(material.title).toBe("컴파일된 출시 덱");
    expect(material.files.map(({ filename }) => filename)).toEqual([
      "slide-00.html", "slide-01.html", "slide-02.html", "slide-03.html",
    ]);
    expect(material.files[1]?.html).toContain('class="slide-page is-decision"');
    expect(material.files[2]?.html).toContain('class="slide-page is-actions"');
    expect(material.indexHtml).toContain('data-kind="decision"');
    expect(material.indexHtml).toContain('./slides/slide-03.html');
    expect(material.slideCount).toBe(4);
    expect(material.lineCount).toBe(1);
    store.close();
  });
});
