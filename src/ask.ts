// Ask 회의 채팅 (RAG): canonical 전사에서 질문 관련 구간을 검색해
// 활성 LLM(ChatTransport)에 전달해 답변을 얻는다. Caret/Granola 스타일.

import type { ChatTransport } from "./llm.ts";
import type { MinutesStore } from "./minutes-store.ts";

export interface AskSegment {
  seq: number;
  speakerTurn: number | null;
  text: string;
}

export interface AskResult {
  answer: string;
  matchedSegments: AskSegment[];
  sourceMeetingId: number;
}

const WINDOW_BEFORE = 3;
const WINDOW_AFTER = 3;
const MAX_SEGMENTS = 12;

export function extractQueryTerms(question: string): string[] {
  const stop = new Set([
    "회의", "내용", "그거", "뭐", "어떤", "어떻게", "왜", "누가", "언제", "어디",
    "알려줘", "말해", "설명", "있나", "있어", "했나", "했어", "하나", "해줘",
    "what", "why", "how", "who", "when", "where", "the", "this", "that", "and",
  ]);
  const tokens = question
    .replace(/[?？.!。,\s]+/g, " ")
    .split(" ")
    .flatMap((word) => {
      if (word.length < 2) return [];
      const lower = word.toLowerCase();
      if (/[a-z]/.test(lower)) return [lower];
      return [lower, lower.slice(0, 2)];
    });
  return [...new Set(tokens)].filter((token) => !stop.has(token));
}

export function searchTranscriptSegments(
  store: MinutesStore,
  meetingId: number,
  question: string,
): AskSegment[] {
  const canonical = store.canonicalVersion(meetingId);
  if (!canonical) return [];
  const lines = store.transcriptVersionLines(canonical.transcriptVersionId);
  const terms = extractQueryTerms(question);
  if (terms.length === 0) {
    return lines.slice(-MAX_SEGMENTS).map(toSegment);
  }

  const hits = new Set<number>();
  for (const term of terms) {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.text.toLowerCase().includes(term)) {
        const start = Math.max(0, i - WINDOW_BEFORE);
        const end = Math.min(lines.length - 1, i + WINDOW_AFTER);
        for (let j = start; j <= end; j += 1) hits.add(j);
      }
    }
  }

  return [...hits]
    .sort((a, b) => a - b)
    .slice(0, MAX_SEGMENTS)
    .map((index) => toSegment(lines[index]!));
}

function toSegment(line: { seq: number; speakerTurn: number | null; text: string }): AskSegment {
  return { seq: line.seq, speakerTurn: line.speakerTurn, text: line.text };
}

const ASK_SYSTEM_PROMPT = `당신은 회의 기록 전문 비서입니다.
아래 [회의 전사 발췌]는 사용자의 질문과 관련된 회의 내용 일부입니다.
전사에 없는 내용은 추측하지 말고 "전사에서 확인할 수 없습니다"라고 답하세요.
근거가 되는 문장이 있으면 "문장 N에 따르면" 형식으로 출처를 함께 표시하세요.
답변은 한국어로 간결하게 작성하세요.`;

export async function askMeeting(
  store: MinutesStore,
  meetingId: number,
  question: string,
  chat: ChatTransport,
  options: { timeoutMs?: number } = {},
): Promise<AskResult> {
  const segments = searchTranscriptSegments(store, meetingId, question);
  const transcript = segments
    .map((segment) => `${segment.seq}. ${segment.speakerTurn ? `[화자 ${segment.speakerTurn}] ` : ""}${segment.text}`)
    .join("\n");
  const prompt = segments.length === 0
    ? `질문: ${question}\n\n[회의 전사 발췌]\n(관련 구간 없음)`
    : `질문: ${question}\n\n[회의 전사 발췌]\n${transcript}`;

  const answer = await chat.chat(prompt, {
    system: ASK_SYSTEM_PROMPT,
    temperature: 0.2,
    maxTokens: 1200,
    timeoutMs: options.timeoutMs,
  });
  return { answer, matchedSegments: segments, sourceMeetingId: meetingId };
}
