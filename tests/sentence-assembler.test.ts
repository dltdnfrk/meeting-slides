import { describe, expect, test } from "bun:test";

import { ASSEMBLER_MAX_HOLD_CHARS, SentenceAssembler } from "../src/whisper.ts";

describe("SentenceAssembler", () => {
  test("완결 구두점이면 즉시 방출", () => {
    const a = new SentenceAssembler();
    expect(a.push("안녕하세요.", true)).toEqual(["안녕하세요."]);
    expect(a.flush()).toBeNull();
  });

  test("미완결 조각은 보류 후 다음 조각과 병합", () => {
    const a = new SentenceAssembler();
    expect(a.push("그래서 저는", false)).toEqual([]); // 보류
    expect(a.push("내일 가보겠습니다", false)).toEqual([]); // 계속 보류
    expect(a.push(".", true)).toEqual(["그래서 저는내일 가보겠습니다."]); // 완결 시 방출
  });

  test("구두점으로 끝난 뒤에는 새 문장 시작", () => {
    const a = new SentenceAssembler();
    expect(a.push("첫 문장입니다.", true)).toEqual(["첫 문장입니다."]);
    expect(a.push("두 번째", false)).toEqual([]);
    expect(a.flush()).toBe("두 번째");
  });

  test("길이 상한을 넘으면 구두점 없이도 강제 방출 (실시간성 하한)", () => {
    const a = new SentenceAssembler();
    const long = "가".repeat(ASSEMBLER_MAX_HOLD_CHARS);
    expect(a.push(long, false)).toEqual([long]);
  });

  test("화자 전환/종료 시 flush로 보류분 방출", () => {
    const a = new SentenceAssembler();
    a.push("말하던 중이었는데", false);
    expect(a.flush()).toBe("말하던 중이었는데");
    expect(a.flush()).toBeNull(); // 두 번은 안 나옴
  });
});
