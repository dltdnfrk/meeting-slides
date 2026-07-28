import { describe, expect, test } from "bun:test";

import { extractSpeakerTurn, isHallucinationLoop } from "../src/whisper.ts";

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

describe("isHallucinationLoop", () => {
  test("토큰 4회 이상 연속 반복은 환각 루프", () => {
    expect(isHallucinationLoop("대원 노시들대원 노시들대원 노시들대원 노시들대원 노시들모빌리티")).toBe(true);
    expect(isHallucinationLoop("예산 예산 예산 예산")).toBe(true);
  });

  test("실제 강조(3회 이하)와 정상 문장은 통과", () => {
    expect(isHallucinationLoop("그래서 그래서 그래서 진행합시다")).toBe(false);
    expect(isHallucinationLoop("오늘 회의를 시작하겠습니다")).toBe(false);
    expect(isHallucinationLoop("베타 배포는 이번 주 금요일로 확정합니다")).toBe(false);
  });
});
