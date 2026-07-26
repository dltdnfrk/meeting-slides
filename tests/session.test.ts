import { describe, expect, test } from "bun:test";

import { MeetingSession, type ServerMessage } from "../src/session.ts";
import type { BlockDetector, BlockDetectionResult } from "../src/llm.ts";

function makeSession(opts: {
  detectInterval?: number;
  detectBlock?: (sentences: string[]) => Promise<BlockDetectionResult>;
}) {
  const messages: ServerMessage[] = [];
  const listeners = new Set<(m: ServerMessage) => void>();
  listeners.add((m) => messages.push(m));
  const llm = {
    detectBlock: opts.detectBlock ?? (async () => ({ shouldAdvance: false, blockTitle: "주제", bullets: ["요점"] })),
  } as unknown as BlockDetector;
  const session = new MeetingSession(llm, opts.detectInterval ?? 1, 12, listeners);
  return { session, messages };
}

function chunk(text: string) {
  return { text, ts: Date.now() };
}

describe("MeetingSession", () => {
  test("첫 감지에서 첫 슬라이드 생성", async () => {
    const { session } = makeSession({});
    session.onChunk(chunk("회의를 시작합니다"));
    await Bun.sleep(10);
    const snap = session.snapshot();
    expect(snap.current?.title).toBe("주제");
    expect(snap.history).toHaveLength(0);
  });

  test("hysteresis: advance 1회는 불렛만 갱신, 2회 연속이면 새 슬라이드", async () => {
    let call = 0;
    const { session } = makeSession({
      detectBlock: async () => {
        call++;
        // 1차: 초기 슬라이드, 2차: advance 시도(보류), 3차: advance 확정
        return { shouldAdvance: call > 1, blockTitle: `블록${call}`, bullets: [`요점${call}`] };
      },
    });
    session.onChunk(chunk("문장1"));
    await Bun.sleep(10);
    expect(session.snapshot().current?.title).toBe("블록1");

    session.onChunk(chunk("문장2")); // advance 1회 — hysteresis 보류
    await Bun.sleep(10);
    expect(session.snapshot().current?.title).toBe("블록2"); // 제목만 갱신
    expect(session.snapshot().history).toHaveLength(0); // 아직 새 장 아님

    session.onChunk(chunk("문장3")); // advance 2회 연속 — 확정
    await Bun.sleep(10);
    expect(session.snapshot().current?.title).toBe("블록3");
    expect(session.snapshot().history).toHaveLength(1); // 이전 슬라이드가 히스토리로
  });

  test("advance 시그널이 끊기면 streak 리셋", async () => {
    let call = 0;
    const { session } = makeSession({
      detectBlock: async () => {
        call++;
        return { shouldAdvance: call === 2, blockTitle: "주제", bullets: ["요점"] };
      },
    });
    session.onChunk(chunk("문장1"));
    await Bun.sleep(10);
    session.onChunk(chunk("문장2")); // advance 1회 (streak=1)
    await Bun.sleep(10);
    session.onChunk(chunk("문장3")); // false → streak=0
    await Bun.sleep(10);
    expect(session.snapshot().history).toHaveLength(0);
  });

  test("reset()은 진행 중이던 감지 결과를 폐기 (epoch 무효화)", async () => {
    let resolveDetect: ((r: BlockDetectionResult) => void) | null = null;
    const { session } = makeSession({
      detectBlock: () => new Promise((res) => { resolveDetect = res; }),
    });
    session.onChunk(chunk("감지 시작 문장"));
    await Bun.sleep(10); // maybeDetect가 await에 들어간 상태

    session.reset();
    resolveDetect?.({ shouldAdvance: false, blockTitle: "stale 주제", bullets: ["옛날 요점"] });
    await Bun.sleep(20);

    const snap = session.snapshot();
    expect(snap.current).toBeNull();
    expect(snap.history).toHaveLength(0);
  });

  test("detectInterval 문장이 쌓여야 LLM 호출", async () => {
    let calls = 0;
    const { session } = makeSession({
      detectInterval: 3,
      detectBlock: async () => { calls++; return { shouldAdvance: false, blockTitle: "주제", bullets: [] }; },
    });
    session.onChunk(chunk("문장1"));
    session.onChunk(chunk("문장2"));
    await Bun.sleep(10);
    expect(calls).toBe(0);
    session.onChunk(chunk("문장3"));
    await Bun.sleep(10);
    expect(calls).toBe(1);
  });

  test("자막은 200ms 디바운스 후 브로드캐스트", async () => {
    const { session, messages } = makeSession({});
    session.onChunk(chunk("자막 문장"));
    expect(messages.filter((m) => m.type === "caption")).toHaveLength(0);
    await Bun.sleep(260);
    const captions = messages.filter((m) => m.type === "caption");
    expect(captions).toHaveLength(1);
    expect(captions[0].type === "caption" && captions[0].text).toContain("자막 문장");
  });

  test("LLM 실패 시 status 브로드캐스트 + 로컬 fallback 슬라이드", async () => {
    const { session, messages } = makeSession({
      detectBlock: async () => { throw new Error("API down"); },
    });
    session.onChunk(chunk("고객 피드백을 정리합니다"));
    await Bun.sleep(20);
    expect(messages.some((m) => m.type === "status" && m.text.includes("LLM 오류"))).toBe(true);
    expect(session.snapshot().current?.title).toBe("고객 피드백"); // TOPIC_RULES fallback
  });

  test("전사 로그는 문장+시각+화자를 전부 보관하고 reset에서 비움", async () => {
    const { session } = makeSession({});
    session.onChunk({ text: "첫 문장", ts: 1000, speaker: 1 });
    session.onChunk({ text: "둘째 문장", ts: 2000, speaker: 2 });
    const t = session.transcript();
    expect(t.type).toBe("transcript");
    expect(t.entries).toEqual([
      { text: "첫 문장", ts: 1000, speaker: 1 },
      { text: "둘째 문장", ts: 2000, speaker: 2 },
    ]);
    session.reset();
    expect(session.transcript().entries).toHaveLength(0);
  });

  test("화자 번호가 캡션에 실리고, 화자 변경 시 버퍼 즉시 플러시", async () => {
    const { session, messages } = makeSession({});
    session.onChunk({ text: "안녕하세요", ts: Date.now(), speaker: 1 });
    session.onChunk({ text: "반갑습니다", ts: Date.now(), speaker: 2 });
    // 화자 변경 시점에 이전 화자 버퍼가 즉시 플러시됨
    const first = messages.filter((m) => m.type === "caption");
    expect(first).toHaveLength(1);
    expect(first[0].type === "caption" && first[0].speaker).toBe(1);
    expect(first[0].type === "caption" && first[0].text).toBe("안녕하세요");
    // 디바운스 후 두 번째 화자 캡션
    await Bun.sleep(260);
    const all = messages.filter((m) => m.type === "caption");
    expect(all).toHaveLength(2);
    expect(all[1].type === "caption" && all[1].speaker).toBe(2);
  });
});
