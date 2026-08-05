import { describe, expect, test } from "bun:test";

import {
  composeNarrativeDeck,
  parseNarrativeDeck,
  type NarrativeDeck,
} from "../src/scene-graph.ts";
import { renderSceneSlideHtml } from "../src/scene-html.ts";

const narrative: NarrativeDeck = {
  meetingId: 7,
  title: "출시 의사결정",
  slides: [
    { intent: "cover", title: "출시 의사결정", subtitle: "8월 운영 회의" },
    {
      intent: "decision",
      title: "출시일 확정",
      decision: "9월 1일에 정식 출시한다",
      rationale: "QA 완료와 파트너 공지가 같은 주에 끝난다",
    },
    {
      intent: "actions",
      title: "출시 준비",
      items: [
        { task: "릴리스 노트 작성", owner: "민지", due: "8월 28일" },
        { task: "파트너 공지", owner: "현준" },
      ],
    },
  ],
};

describe("semantic slide scene graph", () => {
  test("narrative input rejects the legacy bullet contract", () => {
    expect(() => parseNarrativeDeck({
      meetingId: 1,
      title: "잘못된 덱",
      slides: [{ intent: "statement", title: "제목", bullets: ["레거시"] }],
    })).toThrow(/bullets/);
  });

  test("semantic intents compose into positioned editable scene elements", () => {
    const scene = composeNarrativeDeck(narrative);

    expect(scene.slides).toHaveLength(3);
    expect(JSON.stringify(scene)).not.toContain('"bullets"');
    expect(scene.slides[1]?.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", role: "title", text: "출시일 확정" }),
      expect.objectContaining({ type: "text", role: "statement", text: "9월 1일에 정식 출시한다" }),
      expect.objectContaining({ type: "shape" }),
    ]));
  });

  test("HTML renderer draws the scene without list markup", () => {
    const scene = composeNarrativeDeck(narrative);
    const html = renderSceneSlideHtml(scene.slides[2]!);

    expect(html).toContain('data-scene-slide="actions"');
    expect(html).toContain("릴리스 노트 작성");
    expect(html).toContain("민지");
    expect(html).not.toMatch(/<(?:ul|ol|li)\b/);
  });
});
