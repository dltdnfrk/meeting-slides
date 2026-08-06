import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractQueryTerms, searchTranscriptSegments, type AskSegment } from "./ask.ts";
import { MinutesStore } from "./minutes-store.ts";
import { MeetingStore } from "./store.ts";
import { transcriptContentSha256 } from "./transcript-versioning.ts";

const roots: string[] = [];

function storeWithTranscript() {
  const root = mkdtempSync(join(tmpdir(), "ask-test-"));
  roots.push(root);
  const legacy = new MeetingStore(join(root, "meetings.db"));
  const store = new MinutesStore(legacy.databaseHandle());
  const meetingId = legacy.startMeeting("cli:test");
  const version = store.addTranscriptVersion(meetingId, {
    transcriptVersionId: "ask-version-v1",
    sourceKind: "import",
    engine: "fixture",
    engineModel: "exact-v1",
  });
  store.addTranscriptVersionLines(version.transcriptVersionId, [
    { seq: 1, capturedAtMs: 1_000, speakerTurn: 1, text: "이번 분기 마감일은 금요일로 정합니다." },
    { seq: 2, capturedAtMs: 2_000, speakerTurn: 1, text: "베타 배포는 수요일까지 진행합니다." },
    { seq: 3, capturedAtMs: 3_000, speakerTurn: 2, text: "예산은 백만 원으로 확정했습니다." },
    { seq: 4, capturedAtMs: 4_000, speakerTurn: 2, text: "다음 주에 회의록을 공유하겠습니다." },
  ]);
  store.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(store, version.transcriptVersionId));
  store.setCanonical(meetingId, version.transcriptVersionId);
  return { store, meetingId };
}

afterEach(() => {
  for (const root of roots.splice(0)) Bun.spawnSync(["rm", "-rf", root]);
});

describe("extractQueryTerms", () => {
  test("한국어/영어 토큰을 추출하고 불용어를 제거한다", () => {
    expect(extractQueryTerms("마감일이 언제였어?")).toEqual(["마감일이", "마감", "언제였어"]);
    expect(extractQueryTerms("what was the deadline")).toEqual(["was", "deadline"]);
  });

  test("2자 미만 토큰과 불용어만 있으면 빈 배열을 반환한다", () => {
    expect(extractQueryTerms("회의 내용 알려줘")).toEqual(["알려"]);
    expect(extractQueryTerms("a b")).toEqual([]);
  });
});

describe("searchTranscriptSegments", () => {
  test("질문 용어와 일치하는 라인 주변을 윈도우로 묶는다", () => {
    const { store, meetingId } = storeWithTranscript();
    const segments = searchTranscriptSegments(store, meetingId, "마감일이 언제였어?");
    expect(segments.map((s) => s.seq)).toContain(1);
    expect(segments.map((s) => s.seq)).toContain(2);
  });

  test("검색어가 없으면 마지막 라인을 컨텍스트로 쓴다", () => {
    const { store, meetingId } = storeWithTranscript();
    const segments = searchTranscriptSegments(store, meetingId, "회의 내용");
    expect(segments.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
  });

  test("canonical 전사가 없으면 빈 배열을 반환한다", () => {
    const root = mkdtempSync(join(tmpdir(), "ask-test-empty-"));
    roots.push(root);
    const legacy = new MeetingStore(join(root, "meetings.db"));
    const store = new MinutesStore(legacy.databaseHandle());
    const meetingId = legacy.startMeeting("cli:test");
    expect(searchTranscriptSegments(store, meetingId, "뭐든")).toEqual([]);
  });
});

describe("askMeeting", () => {
  test("관련 구간과 함께 질문을 LLM에 전달해 답변을 받는다", async () => {
    const { store, meetingId } = storeWithTranscript();
    const chat = {
      chat: async (prompt: string, options: { system?: string }) => {
        expect(options.system).toContain("회의 기록 전문 비서");
        expect(prompt).toContain("마감일이");
        expect(prompt).toContain("금요일로 정합니다");
        return "마감일은 금요일입니다.";
      },
    };
    const { askMeeting } = await import("./ask.ts");
    const result = await askMeeting(store, meetingId, "마감일이 언제였어?", chat);
    expect(result.answer).toBe("마감일은 금요일입니다.");
    expect(result.matchedSegments.length).toBeGreaterThan(0);
    expect(result.sourceMeetingId).toBe(meetingId);
  });

  test("관련 구간이 없어도 질문을 전달한다", async () => {
    const { store, meetingId } = storeWithTranscript();
    const chat = {
      chat: async (prompt: string) => {
        expect(prompt).toContain("(관련 구간 없음)");
        return "전사에서 확인할 수 없습니다.";
      },
    };
    const { askMeeting } = await import("./ask.ts");
    const result = await askMeeting(store, meetingId, "스마트폰 가격", chat);
    expect(result.matchedSegments).toEqual([] as AskSegment[]);
    expect(result.answer).toContain("확인할 수 없습니다");
  });
});
