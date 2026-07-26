import { describe, expect, test } from "bun:test";

import { buildCliArgs } from "../src/llm-cli.ts";
import { parseBlockDetectionJson } from "../src/llm.ts";

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
});

describe("parseBlockDetectionJson", () => {
  test("정상 JSON 파싱", () => {
    const result = parseBlockDetectionJson('{"shouldAdvance": true, "blockTitle": "출시 일정", "bullets": ["베타 금요일", "QA 완료"]}');
    expect(result.shouldAdvance).toBe(true);
    expect(result.blockTitle).toBe("출시 일정");
    expect(result.bullets).toEqual(["베타 금요일", "QA 완료"]);
  });

  test("앞뒤 사고 과정이 붙은 출력에서 JSON 추출 (reasoning 대응)", () => {
    const noisy = '생각해보니... 주제가 바뀌었군요. {"shouldAdvance": true, "blockTitle": "기술 설계", "bullets": []} 이렇게 하겠습니다.';
    const result = parseBlockDetectionJson(noisy);
    expect(result.shouldAdvance).toBe(true);
    expect(result.blockTitle).toBe("기술 설계");
  });

  test("깨진 출력은 파싱 실패 fallback", () => {
    const result = parseBlockDetectionJson("JSON이 아닌 응답");
    expect(result.blockTitle).toBe("(파싱 실패)");
    expect(result.shouldAdvance).toBe(false);
  });

  test("빈 출력은 빈 결과", () => {
    const result = parseBlockDetectionJson("");
    expect(result.blockTitle).toBe("");
    expect(result.bullets).toEqual([]);
  });

  test("제목 50자, 불렛 80자/6개 제한", () => {
    const result = parseBlockDetectionJson(JSON.stringify({
      shouldAdvance: false,
      blockTitle: "가".repeat(60),
      bullets: Array.from({ length: 8 }, (_, i) => `${i}${"나".repeat(90)}`),
    }));
    expect(result.blockTitle).toHaveLength(50);
    expect(result.bullets).toHaveLength(6);
    expect(result.bullets[0]).toHaveLength(80);
  });
});
