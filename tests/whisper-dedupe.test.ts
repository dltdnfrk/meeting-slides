import { describe, expect, test } from "bun:test";

import type { WhisperConfig } from "../src/config.ts";
import { bigramSimilarity, WhisperStream, type TranscriptChunk } from "../src/whisper.ts";

class DedupeHarness extends WhisperStream {
  feed(text: string): TranscriptChunk[] {
    const chunks: TranscriptChunk[] = [];
    this.buf += `${text}\n`;
    this.drain((chunk) => chunks.push(chunk));
    return chunks;
  }
}

const config: WhisperConfig = {
  streamBin: "whisper-stream",
  cliBin: "whisper-cli",
  modelPath: "model.bin",
  captureId: 0,
  threads: 1,
  stepMs: 3000,
  diarize: false,
  tdrzModelPath: "tdrz.bin",
};

describe("bigramSimilarity", () => {
  test("완전히 같은 문장은 1", () => {
    expect(bigramSimilarity("안녕하세요 반갑습니다", "안녕하세요 반갑습니다")).toBe(1);
  });

  test("띄어쓰기·대소문자 차이는 정규화로 흡수", () => {
    expect(bigramSimilarity("오늘 회의 시작합니다", "오늘회의시작합니다")).toBe(1);
    expect(bigramSimilarity("Release Schedule", "release schedule")).toBe(1);
  });

  test("같은 발화의 부분 수정(리비전)은 높은 유사도", () => {
    const score = bigramSimilarity(
      "오늘 회의는 출시 일정 정리부터 시작합니다",
      "오늘 회의는 출시 일정 정리부터 시작할게요",
    );
    expect(score).toBeGreaterThan(0.6); // 실측 0.7 — 임계값(0.5) 위면 리비전으로 탐지됨
  });

  test("공통 어미(습니다)만 같은 무관한 문장은 낮은 유사도", () => {
    // 예전 문자-존재 방식은 이런 쌍을 70%+ 겹침으로 오탐했다.
    const score = bigramSimilarity(
      "오늘 점심은 김치찌개를 먹었습니다",
      "내일 배포 일정을 확정했습니다",
    );
    expect(score).toBeLessThan(0.3);
  });

  test("같은 글자를 어순만 바꾼 문장은 중복이 아님", () => {
    // 문자 존재 여부로는 100% 겹치지만 bigram 순서 정보로는 다르다.
    const score = bigramSimilarity(
      "가나다라마바사아자차카타파하",
      "하파타카차자아사바마라다나가",
    );
    expect(score).toBeLessThan(0.5);
  });

  test("빈 문자열·한 글자는 0", () => {
    expect(bigramSimilarity("", "안녕")).toBe(0);
    expect(bigramSimilarity("가", "나")).toBe(0);
  });
});

describe("overlapping whisper windows", () => {
  test("a window that extends the previous sentence replaces it instead of appending", () => {
    const whisper = new DedupeHarness(config);
    expect(whisper.feed("오늘 회의는 출시 일정")).toEqual([]);
    expect(whisper.feed("오늘 회의는 출시 일정부터 시작합니다.")).toEqual([
      expect.objectContaining({ text: "오늘 회의는 출시 일정부터 시작합니다." }),
    ]);
  });

  test("a longer revision replaces a shorter emitted prefix instead of being dropped", () => {
    const whisper = new DedupeHarness(config);
    const prefix = "오늘 회의에서 출시 일정과 마케팅 예산을 함께 정리합니다.";
    const revision = "오늘 회의에서 출시 일정과 마케팅 예산을 함께 정리합니다만 배포는 금요일입니다.";
    expect(whisper.feed(prefix)).toEqual([
      expect.objectContaining({ text: prefix }),
    ]);
    expect(whisper.feed(revision)).toEqual([
      expect.objectContaining({ text: revision }),
    ]);
  });
});
