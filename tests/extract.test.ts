import { describe, expect, test } from "bun:test";

import {
  MinutesExtractor,
  localRuleExtraction,
  parseMinutesExtractionJson,
  type MinutesExtractionInput,
} from "../src/extract.ts";

const request: MinutesExtractionInput = {
  schemaVersion: "1",
  meetingDate: "2026-08-01",
  timeZone: "Asia/Seoul",
  transcriptVersionId: "tv-1",
  attendees: [
    { attendeeId: "alice", displayName: "앨리스" },
    { attendeeId: "bob", displayName: "밥" },
  ],
  lines: [
    { seq: 1, speakerTurn: 1, text: "출시는 금요일로 확정했습니다." },
    { seq: 2, speakerTurn: 2, text: "앨리스가 2026-08-07까지 QA 결과를 공유하겠습니다." },
    { seq: 3, speakerTurn: null, text: "예산은 다음 회의에서 추후 논의하겠습니다." },
  ],
};

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    transcriptVersionId: "tv-1",
    decisions: [],
    actionItems: [],
    openItems: [],
    ...overrides,
  });
}

function decision(sourceSegment: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: "출시는 금요일",
    sourceSegment,
    evidenceQuote: "금요일로 확정",
    suggestedAttributionAttendeeId: null,
    ...extra,
  };
}

describe("parseMinutesExtractionJson", () => {
  test("accepts grounded candidates, assigns local ids, and preserves valid siblings", () => {
    const parsed = parseMinutesExtractionJson(payload({
      decisions: [
        decision({ transcript_version_id: "tv-1", start_seq: 1, end_seq: 1 }),
        decision(null),
      ],
      actionItems: [{
        description: "QA 결과 공유",
        sourceSegment: { transcriptVersionId: "tv-1", startSeq: 2, endSeq: 2 },
        evidenceQuote: "QA 결과를 공유",
        suggestedAttributionAttendeeId: "alice",
        suggestedAssigneeAttendeeId: "alice",
        deadline: "2026-08-07",
        deadlineText: "2026-08-07까지",
      }],
    }), request);

    expect(parsed.batchFailed).toBe(false);
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.actionItems).toHaveLength(1);
    expect(parsed.decisions[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(parsed.decisions[0]?.sourceSegment).toEqual({
      transcript_version_id: "tv-1", start_seq: 1, end_seq: 1,
    });
    expect(parsed.rejections).toEqual([{
      kind: "decision", candidateIndex: 1, code: "missing_source",
    }]);
  });

  test("diagnoses every provenance rejection without keeping invalid candidates", () => {
    const sparse = { ...request, lines: [request.lines[0]!, request.lines[2]!, { seq: 5, speakerTurn: null, text: "끝" }] };
    const cases: Array<[string, MinutesExtractionInput, Record<string, unknown>, string]> = [
      ["wrong version", request, decision({ transcriptVersionId: "tv-x", startSeq: 1, endSeq: 1 }), "wrong_transcript_version"],
      ["invalid range", request, decision({ transcriptVersionId: "tv-1", startSeq: 0, endSeq: 1 }), "invalid_seq_range"],
      ["outside requested bounds", request, decision({ transcriptVersionId: "tv-1", startSeq: 4, endSeq: 4 }), "line_not_in_request"],
      ["missing endpoint", sparse, decision({ transcriptVersionId: "tv-1", startSeq: 2, endSeq: 2 }), "line_not_found"],
      ["missing interior", sparse, decision({ transcriptVersionId: "tv-1", startSeq: 1, endSeq: 3 }), "non_contiguous_range"],
      ["fabricated quote", request, decision({ transcriptVersionId: "tv-1", startSeq: 1, endSeq: 1 }, { evidenceQuote: "없는 인용" }), "evidence_quote_mismatch"],
      ["attendee outside request", request, decision({ transcriptVersionId: "tv-1", startSeq: 1, endSeq: 1 }, { suggestedAttributionAttendeeId: "mallory" }), "line_not_in_request"],
    ];

    for (const [label, input, candidate, code] of cases) {
      const parsed = parseMinutesExtractionJson(payload({ decisions: [candidate] }), input);
      expect(parsed.decisions, label).toEqual([]);
      expect(parsed.rejections[0]?.code, label).toBe(code);
    }
  });

  test("empty/non-JSON and top-level version mismatch mark the whole batch for fallback", () => {
    for (const content of ["", "not json", payload({ transcriptVersionId: "tv-other" })]) {
      const parsed = parseMinutesExtractionJson(content, request);
      expect(parsed.batchFailed).toBe(true);
      expect(parsed.decisions).toEqual([]);
      expect(parsed.actionItems).toEqual([]);
      expect(parsed.openItems).toEqual([]);
    }
  });

  test("does not extract JSON from prose or coerce malformed candidate fields", () => {
    const wrapped = `analysis before ${payload()} analysis after`;
    expect(parseMinutesExtractionJson(wrapped, request).batchFailed).toBe(true);
    const malformed = parseMinutesExtractionJson(payload({
      decisions: [decision({ transcriptVersionId: "tv-1", startSeq: "1", endSeq: 1 })],
    }), request);
    expect(malformed.decisions).toEqual([]);
    expect(malformed.rejections[0]?.code).toBe("invalid_seq_range");
  });
});

describe("precision local-rule fallback", () => {
  test("copies only explicit ending lines verbatim with single-line provenance", () => {
    const result = localRuleExtraction(request);
    expect(result.decisions[0]).toMatchObject({
      description: request.lines[0]!.text,
      evidenceQuote: request.lines[0]!.text,
      sourceSegment: { transcript_version_id: "tv-1", start_seq: 1, end_seq: 1 },
      origin: "local_rule",
    });
    expect(result.actionItems[0]).toMatchObject({
      description: request.lines[1]!.text,
      suggestedAssigneeAttendeeId: "alice",
      deadline: "2026-08-07",
    });
    expect(result.openItems[0]?.description).toBe(request.lines[2]!.text);
  });

  test("never joins lines, resolves pronouns, maps speaker turns, or infers relative dates", () => {
    const result = localRuleExtraction({
      ...request,
      lines: [
        { seq: 10, speakerTurn: 1, text: "밥이 배포를 맡을 예정입니다." },
        { seq: 11, speakerTurn: 2, text: "제가 내일까지 완료하겠습니다." },
        { seq: 12, speakerTurn: 1, text: "가격 이야기가 나왔습니다." },
      ],
    });
    expect(result.decisions).toEqual([]);
    expect(result.openItems).toEqual([]);
    expect(result.actionItems).toHaveLength(1);
    expect(result.actionItems[0]).toMatchObject({
      description: "제가 내일까지 완료하겠습니다.",
      evidenceQuote: "제가 내일까지 완료하겠습니다.",
      suggestedAssigneeAttendeeId: null,
      deadline: null,
      deadlineText: "제가 내일까지 완료하겠습니다.",
      sourceSegment: { transcript_version_id: "tv-1", start_seq: 11, end_seq: 11 },
    });
  });
});

describe("MinutesExtractor", () => {
  test("round-trips through chat with the provenance prompt", async () => {
    let prompt = "";
    let options: unknown;
    const extractor = new MinutesExtractor({
      async chat(value, suppliedOptions) {
        prompt = value;
        options = suppliedOptions;
        return payload({ decisions: [decision({ transcriptVersionId: "tv-1", startSeq: 1, endSeq: 1 })] });
      },
    });
    const result = await extractor.extract(request);
    expect(result.usedFallback).toBe(false);
    expect(result.decisions).toHaveLength(1);
    expect(prompt).toContain('"seq":1');
    expect(options).toMatchObject({
      temperature: 0,
      maxTokens: 4000,
      system: expect.stringContaining("speakerTurn is not an attendee identity"),
    });
  });

  test("falls back on transport failure and batch failure, while valid empty JSON succeeds", async () => {
    const failures = [
      { chat: async () => { throw new Error("timeout"); } },
      { chat: async () => payload({ transcriptVersionId: "wrong" }) },
    ];
    for (const transport of failures) {
      const result = await new MinutesExtractor(transport).extract(request);
      expect(result.usedFallback).toBe(true);
      expect(result.decisions[0]?.description).toBe(request.lines[0]!.text);
    }
    const empty = await new MinutesExtractor({ chat: async () => payload() }).extract(request);
    expect(empty.usedFallback).toBe(false);
    expect(empty.decisions).toEqual([]);
  });
});
