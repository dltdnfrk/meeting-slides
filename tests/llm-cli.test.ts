import { describe, expect, test } from "bun:test";

import { buildCliArgs } from "../src/llm-cli.ts";
import {
  isLowQualityMeetingCard,
  parseBlockDetectionJson,
  SYSTEM_PROMPT,
} from "../src/llm.ts";

describe("buildCliArgs", () => {
  test("claude 프리셋: -p + text 출력", () => {
    const args = buildCliArgs({ bin: "claude", preset: "claude", timeoutMs: 1000 }, "프롬프트");
    expect(args).toEqual(["-p", "프롬프트", "--output-format", "text"]);
  });

  test("codex 프리셋: exec + 최종 메시지 파일", () => {
    const args = buildCliArgs({ bin: "codex", preset: "codex", timeoutMs: 1000 }, "프롬프트", "/tmp/out.txt");
    expect(args[0]).toBe("exec");
    expect(args).toContain("-o");
    expect(args).toContain("/tmp/out.txt");
    expect(args).toContain("프롬프트");
  });

  test("claude가 아닌 프리셋은 -p text 출력을 쓴다", () => {
    const args = buildCliArgs({ bin: "myllm", preset: "claude", timeoutMs: 1000 }, "P");
    expect(args).toEqual(["-p", "P", "--output-format", "text"]);
  });
});

describe("parseBlockDetectionJson", () => {
  test("정상 MeetingCard JSON", () => {
    const result = parseBlockDetectionJson(JSON.stringify({
      shouldAdvance: true,
      title: "기술 설계",
      bullets: ["API 계약 확정", "스키마 동결"],
      kicker: "백엔드",
      emphasis: "결정: API 계약 확정",
    }));
    expect(result.shouldAdvance).toBe(true);
    expect(result.title).toBe("기술 설계");
    expect(result.bullets).toEqual(["API 계약 확정", "스키마 동결"]);
    expect(result.kicker).toBe("백엔드");
  });

  test("앞뒤 잡음이 있어도 JSON 객체를 추출한다", () => {
    const noisy = '생각해보니... {"shouldAdvance":true,"title":"기술 설계","bullets":["API 계약 확정"]} 이렇게 하겠습니다.';
    const result = parseBlockDetectionJson(noisy);
    expect(result.shouldAdvance).toBe(true);
    expect(result.title).toBe("기술 설계");
  });

  test.each([
    ["문자열 boolean", '{"shouldAdvance":"false","title":"일정","bullets":["확인"]}'],
    ["알 수 없는 키", '{"shouldAdvance":false,"title":"일정","bullets":["확인"],"html":"<b>x</b>"}'],
  ])("%s 은 failure 경로로 예외", (_name, raw) => {
    expect(() => parseBlockDetectionJson(raw)).toThrow();
  });

  test("빈 bullets는 품질 게이트에서 no-op으로 폐기한다", () => {
    const result = parseBlockDetectionJson(JSON.stringify({
      shouldAdvance: true,
      title: "일정",
      bullets: [],
    }));
    expect(result).toEqual({ shouldAdvance: false, title: "", bullets: [] });
  });

  test("SYSTEM_PROMPT는 shouldAdvance 스키마와 메타 금지를 명시한다", () => {
    expect(SYSTEM_PROMPT).toContain('"shouldAdvance": boolean');
    expect(SYSTEM_PROMPT).toContain("회의 종료");
    expect(SYSTEM_PROMPT).not.toContain("isNewBlock");
  });

  test("회의 종료 메타 카드는 파서에서 폐기한다", () => {
    const result = parseBlockDetectionJson(JSON.stringify({
      shouldAdvance: true,
      title: "회의 종료",
      bullets: ["회의가 종료되었습니다."],
    }));
    expect(result).toEqual({ shouldAdvance: false, title: "", bullets: [] });
  });

  test("isNewBlock 별칭을 shouldAdvance로 수용한다", () => {
    const result = parseBlockDetectionJson(JSON.stringify({
      isNewBlock: true,
      title: "베타 배포 일정",
      bullets: ["금요일 베타 배포로 확정", "QA 마감 수요일 18시"],
      emphasis: "결정: 금요일 베타 배포",
    }));
    expect(result.shouldAdvance).toBe(true);
    expect(result.title).toBe("베타 배포 일정");
    expect(result.bullets.length).toBe(2);
  });

  test("isLowQualityMeetingCard 직접 판정", () => {
    expect(isLowQualityMeetingCard({ title: "회의 종료", bullets: ["회의가 종료되었습니다."] })).toBe(true);
    expect(isLowQualityMeetingCard({
      title: "베타 배포 일정",
      bullets: ["금요일 베타 배포로 확정", "QA 수요일 마감"],
    })).toBe(false);
  });
});

  test("kind 필드를 파싱해 카드에 실어 보낸다", () => {
    const result = parseBlockDetectionJson(JSON.stringify({
      shouldAdvance: true,
      title: "베타 배포 일정",
      bullets: ["금요일 베타 배포로 확정", "QA 마감 수요일 18시"],
      emphasis: "결정: 금요일 베타 배포",
      kind: "decision",
    }));
    expect(result.shouldAdvance).toBe(true);
    expect(result.kind).toBe("decision");
  });

  test("SYSTEM_PROMPT는 kind 스키마를 포함한다", () => {
    expect(SYSTEM_PROMPT).toContain('"kind"?');
    expect(SYSTEM_PROMPT).toContain("decision");
  });

