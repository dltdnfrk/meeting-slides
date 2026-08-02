import { describe, expect, test } from "bun:test";

import { buildCliArgs } from "../src/llm-cli.ts";
import { parseBlockDetectionJson, SYSTEM_PROMPT } from "../src/llm.ts";

describe("buildCliArgs", () => {
  test("claude 프리셋: -p + text 출력", () => {
    const args = buildCliArgs({ bin: "claude", preset: "claude", timeoutMs: 1000 }, "프롬프트");
    expect(args).toEqual(["-p", "프롬프트", "--output-format", "text"]);
  });

  test("codex 프리셋: exec + 최종 메시지 파일", () => {
    const args = buildCliArgs({ bin: "codex", preset: "codex", timeoutMs: 1000 }, "프롬프트", "/tmp/out.txt");
    expect(args[0]).toBe("exec");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("-o");
    expect(args[args.indexOf("-o") + 1]).toBe("/tmp/out.txt");
    expect(args[args.length - 1]).toBe("프롬프트");
  });

  test("codex: 모델/effort 오버라이드 인자", () => {
    const args = buildCliArgs(
      { bin: "codex", preset: "codex", timeoutMs: 1000, model: "gpt-5.2", effort: "high" },
      "프롬프트",
      "/tmp/out.txt",
    );
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.2");
    expect(args[args.indexOf("-c") + 1]).toBe('model_reasoning_effort="high"');
  });

  test("claude: 모델 오버라이드 인자", () => {
    const args = buildCliArgs(
      { bin: "claude", preset: "claude", timeoutMs: 1000, model: "opus" },
      "프롬프트",
    );
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
  });
});

describe("parseBlockDetectionJson", () => {
  test("MeetingCard JSON의 선택 필드까지 파싱", () => {
    const result = parseBlockDetectionJson(JSON.stringify({
      shouldAdvance: true,
      title: "출시 일정",
      kicker: "배포 준비",
      bullets: ["베타 금요일", "QA 완료"],
      emphasis: "목요일까지 QA를 끝낸다",
    }));
    expect(result).toEqual({
      shouldAdvance: true,
      title: "출시 일정",
      kicker: "배포 준비",
      bullets: ["베타 금요일", "QA 완료"],
      emphasis: "목요일까지 QA를 끝낸다",
    });
  });

  test("앞뒤 사고 과정이 붙은 출력에서 JSON 추출 (reasoning 대응)", () => {
    const noisy = '생각해보니... {"shouldAdvance":true,"title":"기술 설계","bullets":["API 계약 확정"]} 이렇게 하겠습니다.';
    expect(parseBlockDetectionJson(noisy).title).toBe("기술 설계");
  });

  test.each([
    ["비 JSON", "JSON이 아닌 응답"],
    ["빈 출력", ""],
    ["문자열 boolean", '{"shouldAdvance":"false","title":"일정","bullets":["확인"]}'],
    ["빈 bullets", '{"shouldAdvance":false,"title":"일정","bullets":[]}'],
    ["알 수 없는 키", '{"shouldAdvance":false,"title":"일정","bullets":["확인"],"html":"<b>x</b>"}'],
  ])("잘못된 %s은 failure 경로로 예외", (_label, content) => {
    expect(() => parseBlockDetectionJson(content)).toThrow();
  });

  test("MeetingCard 스키마 드라이버를 명시", () => {
    expect(SYSTEM_PROMPT).toContain('"shouldAdvance": boolean');
    expect(SYSTEM_PROMPT).toContain('"kicker"?: string');
    expect(SYSTEM_PROMPT).toContain('"bullets": string[1..6]');
    expect(SYSTEM_PROMPT).toContain('"emphasis"?: string');
  });
});
