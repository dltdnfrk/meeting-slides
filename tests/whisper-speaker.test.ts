import { describe, expect, test } from "bun:test";

import { extractSpeakerTurn } from "../src/whisper.ts";

describe("extractSpeakerTurn", () => {
  test("마커가 있으면 turn=true + 텍스트에서 제거", () => {
    const r = extractSpeakerTurn("안녕하세요 여러분 [SPEAKER_TURN]");
    expect(r.turn).toBe(true);
    expect(r.text).toBe("안녕하세요 여러분");
  });

  test("마커가 없으면 원문 유지", () => {
    const r = extractSpeakerTurn("그냥 문장");
    expect(r.turn).toBe(false);
    expect(r.text).toBe("그냥 문장");
  });

  test("마커만 있는 라인은 빈 텍스트", () => {
    const r = extractSpeakerTurn("[SPEAKER_TURN]");
    expect(r.turn).toBe(true);
    expect(r.text).toBe("");
  });
});
