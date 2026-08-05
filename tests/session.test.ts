import { describe, expect, test } from "bun:test";

import { MeetingSession, type ServerMessage } from "../src/session.ts";
import type { BlockDetector, BlockDetectionResult } from "../src/llm.ts";

function makeSession(opts: {
  detectInterval?: number;
  detectBlock?: (sentences: string[]) => Promise<BlockDetectionResult>;
  sink?: { onLine: (e: { text: string; ts: number; speaker?: number }) => void; onSlide: (s: unknown) => void };
}) {
  const messages: ServerMessage[] = [];
  const listeners = new Set<(m: ServerMessage) => void>();
  listeners.add((m) => messages.push(m));
  const waitFor = (predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> =>
    new Promise((resolve, reject) => {
      const listener = (message: ServerMessage) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(message);
      };
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error("timed out waiting for session message"));
      }, 1_000);
      listeners.add(listener);
    });
  const llm = {
    detectBlock: opts.detectBlock ?? (async () => ({ shouldAdvance: false, title: "주제", bullets: ["요점"] })),
  } as unknown as BlockDetector;
  const session = new MeetingSession(llm, opts.detectInterval ?? 1, 12, listeners, opts.sink ?? null);
  return { session, messages, waitFor };
}

type SessionHarness = ReturnType<typeof makeSession>;

function chunk(text: string) {
  return { text, ts: Date.now() };
}

async function addAndDetect(harness: SessionHarness, text: string): Promise<void> {
  const detected = harness.waitFor((message) => message.type === "detect" && !message.detecting);
  harness.session.onChunk(chunk(text));
  await detected;
}

describe("MeetingSession", () => {
  test("production-style manual mode records transcript without automatic LLM detection", async () => {
    let calls = 0;
    const session = new MeetingSession(
      {
        detectBlock: async () => {
          calls += 1;
          return { shouldAdvance: false, title: "자동 카드", bullets: ["생성되면 안 됨"] };
        },
        ping: async () => true,
      },
      1,
      20,
      new Set(),
      undefined,
      { automaticDetection: false },
    );

    session.onChunk({ text: "첫 번째 전사", ts: 1 });
    session.onChunk({ text: "두 번째 전사", ts: 2 });
    await session.flush();

    expect(calls).toBe(0);
    expect(session.transcript().entries).toHaveLength(2);
    expect(session.snapshot().current).toBeNull();
  });

  test("첫 감지에서 MeetingCard 슬라이드 생성", async () => {
    const harness = makeSession({
      detectBlock: async () => ({
        shouldAdvance: false,
        title: "출시 일정",
        kicker: "배포 준비",
        bullets: ["베타 금요일"],
        emphasis: "목요일 QA 완료",
      }),
    });
    await addAndDetect(harness, "회의를 시작합니다");
    expect(harness.session.snapshot().current).toMatchObject({
      title: "출시 일정",
      kicker: "배포 준비",
      bullets: ["베타 금요일"],
      emphasis: "목요일 QA 완료",
    });
  });

  test("hysteresis: 같은 pending 후보 2회만 advance하고 첫 신호는 현재 카드를 오염시키지 않음", async () => {
    let call = 0;
    const harness = makeSession({
      detectBlock: async () => {
        call++;
        if (call === 1) return { shouldAdvance: false, title: "A", bullets: ["A 요점"] };
        return { shouldAdvance: true, title: "B", kicker: "새 안건", bullets: [`B 요점 ${call}`] };
      },
    });
    await addAndDetect(harness, "문장1");
    const slideMessagesBefore = harness.messages.filter((message) => message.type === "slide").length;

    await addAndDetect(harness, "문장2");
    expect(harness.session.snapshot().current).toMatchObject({ title: "A", bullets: ["A 요점"] });
    expect(harness.session.snapshot().history).toHaveLength(0);
    expect(harness.messages.filter((message) => message.type === "slide")).toHaveLength(slideMessagesBefore);

    await addAndDetect(harness, "문장3");
    expect(harness.session.snapshot().current).toMatchObject({ title: "B", kicker: "새 안건" });
    expect(harness.session.snapshot().history.map((slide) => slide.title)).toEqual(["A"]);
  });

  test("A→B→C 단일 신호는 A를 archive하지 않고 후보별 streak를 격리", async () => {
    const results: BlockDetectionResult[] = [
      { shouldAdvance: false, title: "A", bullets: ["A 요점"] },
      { shouldAdvance: true, title: "B", bullets: ["B 요점"] },
      { shouldAdvance: true, title: "C", bullets: ["C 첫 신호"] },
      { shouldAdvance: true, title: "C", bullets: ["C 확정"] },
    ];
    const harness = makeSession({ detectBlock: async () => results.shift()! });
    await addAndDetect(harness, "A 문장");
    await addAndDetect(harness, "B 문장");
    await addAndDetect(harness, "C 문장");
    expect(harness.session.snapshot()).toMatchObject({ current: { title: "A" }, history: [] });

    await addAndDetect(harness, "C 확인 문장");
    expect(harness.session.snapshot().current?.title).toBe("C");
    expect(harness.session.snapshot().history.map((slide) => slide.title)).toEqual(["A"]);
  });

  test("advance 시그널이 끊기면 후보 streak 리셋", async () => {
    const results: BlockDetectionResult[] = [
      { shouldAdvance: false, title: "A", bullets: ["초기"] },
      { shouldAdvance: true, title: "B", bullets: ["후보"] },
      { shouldAdvance: false, title: "A", bullets: ["계속 논의"] },
      { shouldAdvance: true, title: "B", bullets: ["다시 후보"] },
    ];
    const harness = makeSession({ detectBlock: async () => results.shift()! });
    await addAndDetect(harness, "문장1");
    await addAndDetect(harness, "문장2");
    await addAndDetect(harness, "문장3");
    await addAndDetect(harness, "문장4");
    expect(harness.session.snapshot()).toMatchObject({ current: { title: "A" }, history: [] });
  });

  test("reset()은 진행 중이던 감지 결과를 폐기 (epoch 무효화)", async () => {
    let resolveDetect: ((result: BlockDetectionResult) => void) | null = null;
    const harness = makeSession({
      detectBlock: () => new Promise((resolve) => { resolveDetect = resolve; }),
    });
    const finished = harness.waitFor((message) => message.type === "detect" && !message.detecting);
    harness.session.onChunk(chunk("감지 시작 문장"));
    harness.session.reset();
    resolveDetect?.({ shouldAdvance: false, title: "stale 주제", bullets: ["옛날 요점"] });
    await finished;
    expect(harness.session.snapshot()).toEqual({ type: "slide", current: null, history: [] });
  });

  test("detectInterval 문장이 쌓여야 LLM 호출", async () => {
    let calls = 0;
    const harness = makeSession({
      detectInterval: 3,
      detectBlock: async () => { calls++; return { shouldAdvance: false, title: "주제", bullets: ["요점"] }; },
    });
    harness.session.onChunk(chunk("문장1"));
    harness.session.onChunk(chunk("문장2"));
    expect(calls).toBe(0);
    await addAndDetect(harness, "문장3");
    expect(calls).toBe(1);
  });

  test("자막은 디바운스 후 정확한 caption 이벤트로 브로드캐스트", async () => {
    const harness = makeSession({ detectInterval: 99 });
    const caption = harness.waitFor((message) => message.type === "caption");
    harness.session.onChunk(chunk("자막 문장"));
    expect(harness.messages.filter((message) => message.type === "caption")).toHaveLength(0);
    expect(await caption).toMatchObject({ type: "caption", text: "자막 문장" });
  });

  test("LLM 실패는 가짜 MeetingCard 없이 detecting을 안전하게 해제", async () => {
    const harness = makeSession({ detectBlock: async () => { throw new Error("invalid JSON"); } });
    await addAndDetect(harness, "고객 피드백을 정리합니다");
    expect(harness.messages.some((message) => message.type === "status" && message.text.includes("LLM 오류"))).toBe(true);
    expect(harness.session.snapshot().current).toBeNull();
    expect(harness.messages.at(-1)).toEqual({ type: "detect", detecting: false });
  });

  test("setDetector로 런타임 LLM 교체 — 다음 감지부터 새 백엔드 사용", async () => {
    const harness = makeSession({});
    let used = "";
    harness.session.setDetector({
      detectBlock: async () => { used = "new"; return { shouldAdvance: false, title: "새 백엔드", bullets: ["교체됨"] }; },
      ping: async () => true,
    });
    await addAndDetect(harness, "교체 후 문장");
    expect(used).toBe("new");
    expect(harness.session.snapshot().current?.title).toBe("새 백엔드");
  });

  test("전사 로그는 문장+시각+화자를 전부 보관하고 reset에서 비움", () => {
    const { session } = makeSession({ detectInterval: 99 });
    session.onChunk({ text: "첫 문장", ts: 1000, speaker: 1 });
    session.onChunk({ text: "둘째 문장", ts: 2000, speaker: 2 });
    expect(session.transcript().entries).toEqual([
      { text: "첫 문장", ts: 1000, speaker: 1 },
      { text: "둘째 문장", ts: 2000, speaker: 2 },
    ]);
    session.reset();
    expect(session.transcript().entries).toHaveLength(0);
  });

  test("화자 번호가 캡션에 실리고, 화자 변경 시 버퍼 즉시 플러시", async () => {
    const harness = makeSession({ detectInterval: 99 });
    const secondCaption = harness.waitFor(
      (message) => message.type === "caption" && message.speaker === 2,
    );
    harness.session.onChunk({ text: "안녕하세요", ts: Date.now(), speaker: 1 });
    harness.session.onChunk({ text: "반갑습니다", ts: Date.now(), speaker: 2 });
    expect(harness.messages.find((message) => message.type === "caption")).toMatchObject({
      type: "caption",
      speaker: 1,
      text: "안녕하세요",
    });
    expect(await secondCaption).toMatchObject({ type: "caption", speaker: 2, text: "반갑습니다" });
  });

  test("같은 토픽 MeetingCard 갱신도 sink.onSlide로 영속화", async () => {
    const slides: Array<{ index: number; title: string; kicker?: string; bullets: string[]; emphasis?: string }> = [];
    let call = 0;
    const harness = makeSession({
      detectBlock: async () => {
        call++;
        return call === 1
          ? { shouldAdvance: false, title: "출시 일정", kicker: "초안", bullets: ["초기 초안"], emphasis: "검토 필요" }
          : { shouldAdvance: false, title: "출시 일정", bullets: ["베타 금요일", "QA 목요일"], emphasis: "목요일 완료" };
      },
      sink: {
        onLine: () => {},
        onSlide: (slide) => slides.push({ ...slide as typeof slides[number], bullets: [...(slide as typeof slides[number]).bullets] }),
      },
    });
    await addAndDetect(harness, "문장1");
    await addAndDetect(harness, "문장2");

    expect(slides).toHaveLength(2);
    expect(slides[0]).toMatchObject({ kicker: "초안", emphasis: "검토 필요" });
    expect(slides[1]).not.toHaveProperty("kicker");
    expect(slides[1]).toMatchObject({ bullets: ["베타 금요일", "QA 목요일"], emphasis: "목요일 완료" });
    expect(slides.every((slide) => slide.index === slides[0].index)).toBe(true);
  });
});


describe("meta card rejection", () => {
  test("LLM이 회의 종료 카드를 내도 스테이지에 올리지 않는다", async () => {
    const harness = makeSession({
      detectBlock: async () => ({
        shouldAdvance: true,
        title: "회의 종료",
        bullets: ["회의가 종료되었습니다."],
      }),
    });
    await addAndDetect(harness, "회의를 종료합니다");
    expect(harness.session.snapshot().current).toBeNull();
  });

  test("fallback 경로의 메타성 문장도 슬라이드를 만들지 않는다", async () => {
    const harness = makeSession({
      detectBlock: async () => {
        throw new Error("boom");
      },
    });
    await addAndDetect(harness, "회의를 종료합니다");
    await addAndDetect(harness, "회의가 종료되었습니다");
    await addAndDetect(harness, "수고하셨습니다");
    const current = harness.session.snapshot().current;
    expect(current).toBeNull();
  });

  test("음성 인식 테스트 자체가 회의 주제이면 실제 논의 카드를 생성한다", async () => {
    const harness = makeSession({
      detectBlock: async () => ({
        shouldAdvance: false,
        title: "",
        bullets: [],
      }),
    });

    harness.session.onChunk({ text: "음성 인식 테스트를 진행하겠습니다.", ts: 1 });
    harness.session.onChunk({ text: "전사는 정상적으로 들어오고 있습니다.", ts: 2 });
    harness.session.onChunk({ text: "슬라이드 생성 기준을 확인하겠습니다.", ts: 3 });
    await harness.session.flush();

    expect(harness.session.snapshot().current).toMatchObject({
      title: "음성 인식 테스트를 진행하겠습니다",
      bullets: [
        "음성 인식 테스트를 진행하겠습니다.",
        "전사는 정상적으로 들어오고 있습니다.",
        "슬라이드 생성 기준을 확인하겠습니다.",
      ],
    });
    expect(harness.session.snapshot().current?.scene).toMatchObject({
      intent: "statement",
      elements: expect.arrayContaining([
        expect.objectContaining({ type: "text", role: "statement" }),
      ]),
    });
  });
});
