import { expect, test } from "bun:test";

import type { BlockDetector } from "../src/llm.ts";
import { MeetingSession, type ServerMessage } from "../src/session.ts";

test("a valid empty detector result does not create a raw transcript fallback card", async () => {
  // Given
  const messages: ServerMessage[] = [];
  const listeners = new Set<(message: ServerMessage) => void>();
  listeners.add((message) => messages.push(message));
  const detector: BlockDetector = {
    detectBlock: async () => ({ shouldAdvance: false, title: "", bullets: [] }),
    ping: async () => true,
  };
  const session = new MeetingSession(detector, 3, 12, listeners);
  const detectionFinished = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("empty detection did not finish")),
      1_000,
    );
    const listener = (message: ServerMessage) => {
      if (message.type !== "detect" || message.detecting) return;
      clearTimeout(timeout);
      listeners.delete(listener);
      resolve();
    };
    listeners.add(listener);
  });

  // When
  session.onChunk({ text: "첫 주 이탈률이 높다는 사실을 확인했습니다.", ts: 1 });
  session.onChunk({ text: "가입 흐름을 줄이는 방향을 논의했습니다.", ts: 2 });
  session.onChunk({ text: "담당자와 일정은 아직 결정하지 않았습니다.", ts: 3 });
  await detectionFinished;
  await session.flush();

  // Then
  expect(session.snapshot()).toEqual({ type: "slide", current: null, history: [] });
  expect(messages.some((message) => message.type === "slide")).toBe(false);
});
