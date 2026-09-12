import { describe, expect, test } from "bun:test";

import {
  MinutesExtractor,
  chunkMinutesExtractionInput,
  localRuleExtraction,
  parseMinutesExtractionJson,
  type CandidateRejectionCode,
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

  test("normalizes deadlines only from explicit source text, never model inference", () => {
    const input = {
      ...request,
      lines: [
        ...request.lines,
        { seq: 4, speakerTurn: 2, text: "밥이 내일까지 완료하겠습니다." },
      ],
    };
    const parsed = parseMinutesExtractionJson(payload({
      actionItems: [
        {
          description: "QA 결과 공유",
          sourceSegment: { transcript_version_id: "tv-1", start_seq: 2, end_seq: 2 },
          evidenceQuote: "QA 결과를 공유",
          suggestedAttributionAttendeeId: "alice",
          suggestedAssigneeAttendeeId: "alice",
          deadline: "2026-08-08",
          deadlineText: "2026-08-07까지",
        },
        {
          description: "보고 완료",
          sourceSegment: { transcript_version_id: "tv-1", start_seq: 4, end_seq: 4 },
          evidenceQuote: "내일까지 완료",
          suggestedAttributionAttendeeId: "bob",
          suggestedAssigneeAttendeeId: "bob",
          deadline: "2026-08-02",
          deadlineText: "내일까지",
        },
      ],
    }), input);

    expect(parsed.actionItems.map(({ deadline, deadlineText }) => ({ deadline, deadlineText }))).toEqual([
      { deadline: "2026-08-07", deadlineText: "2026-08-07까지" },
      { deadline: null, deadlineText: "내일까지" },
    ]);
  });

  test("diagnoses every provenance rejection without keeping invalid candidates", () => {
    const sparse = { ...request, lines: [request.lines[0]!, request.lines[2]!, { seq: 5, speakerTurn: null, text: "끝" }] };
    const cases: Array<[string, MinutesExtractionInput, Record<string, unknown>, CandidateRejectionCode]> = [
      ["wrong version", request, decision({ transcriptVersionId: "tv-x", startSeq: 1, endSeq: 1 }), "wrong_transcript_version"],
      ["invalid range", request, decision({ transcriptVersionId: "tv-1", startSeq: 0, endSeq: 1 }), "invalid_seq_range"],
      ["outside requested bounds", request, decision({ transcriptVersionId: "tv-1", startSeq: 4, endSeq: 4 }), "line_not_in_request"],
      ["missing endpoint", sparse, decision({ transcriptVersionId: "tv-1", startSeq: 2, endSeq: 2 }), "line_not_found"],
      ["missing interior", sparse, decision({ transcriptVersionId: "tv-1", startSeq: 1, endSeq: 3 }), "non_contiguous_range"],
      ["fabricated quote", request, decision({ transcriptVersionId: "tv-1", startSeq: 1, endSeq: 1 }, { evidenceQuote: "없는 인용" }), "evidence_quote_mismatch"],
      ["attendee outside request", request, decision({ transcriptVersionId: "tv-1", startSeq: 1, endSeq: 1 }, { suggestedAttributionAttendeeId: "mallory" }), "attendee_not_in_request"],
      ["blank description", request, decision({ transcriptVersionId: "tv-1", startSeq: 1, endSeq: 1 }, { description: "   " }), "missing_description"],
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

  test("accepts fenced or prefixed JSON objects and still rejects malformed candidates", () => {
    const grounded = payload({
      decisions: [decision({ transcript_version_id: "tv-1", start_seq: 1, end_seq: 1 })],
    });
    const fenced = `\`\`\`json\n${grounded}\n\`\`\``;
    const fencedParsed = parseMinutesExtractionJson(fenced, request);
    expect(fencedParsed.batchFailed).toBe(false);
    expect(fencedParsed.decisions).toHaveLength(1);

    const prefixed = `Here is the extraction:\n${grounded}`;
    const prefixedParsed = parseMinutesExtractionJson(prefixed, request);
    expect(prefixedParsed.batchFailed).toBe(false);
    expect(prefixedParsed.decisions).toHaveLength(1);

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

  test("matches informal Korean and English decision lines", () => {
    const result = localRuleExtraction({
      ...request,
      lines: [
        { seq: 20, speakerTurn: 1, text: "그럼 그걸로 하죠" },
        { seq: 21, speakerTurn: 2, text: "We decided to ship Friday" },
      ],
    });
    expect(result.decisions.map((item) => item.evidenceQuote)).toEqual([
      "그럼 그걸로 하죠",
      "We decided to ship Friday",
    ]);
    expect(result.actionItems).toEqual([]);
    expect(result.openItems).toEqual([]);
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
    expect(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1))).toEqual(request);
    expect(options).toMatchObject({
      temperature: 0,
      maxTokens: 4000,
      system: expect.any(String),
    });
  });

  test("chunks a long transcript, preserves source seq, and de-duplicates overlap", async () => {
    const longRequest: MinutesExtractionInput = {
      ...request,
      lines: Array.from({ length: 30 }, (_, index) => ({
        seq: index + 1,
        speakerTurn: index % 2,
        text: `근거 ${index + 1}: ${"긴 회의 발언 ".repeat(14)}결정했습니다.`,
      })),
    };
    const seenChunks: number[][] = [];
    const extractor = new MinutesExtractor({
      async chat(prompt) {
        const json = prompt.slice(prompt.indexOf("\n") + 1).split("\n\nMeeting notes")[0]!;
        const chunk = JSON.parse(json) as MinutesExtractionInput;
        seenChunks.push(chunk.lines.map((line) => line.seq));
        return payload({
          decisions: chunk.lines.map((line) => ({
            description: line.text,
            sourceSegment: { transcript_version_id: "tv-1", start_seq: line.seq, end_seq: line.seq },
            evidenceQuote: line.text,
            suggestedAttributionAttendeeId: null,
          })),
        });
      },
    }, 3_000);
    const result = await extractor.extract(longRequest);
    expect(seenChunks.length).toBeGreaterThan(1);
    expect(seenChunks.every((seqs) => seqs.length < longRequest.lines.length)).toBe(true);
    expect(result.decisions.map((item) => item.sourceSegment.start_seq)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
    expect(result.usedFallback).toBe(false);
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
    // empty LLM result is unioned with local rules (recall backfill), not returned as-is
    expect(empty.decisions.every((d) => d.origin === "local_rule")).toBe(true);
  });

  test("parses a grounded summary, rejects an ungrounded topic, and leaves fallback summary null", () => {
    const parsed = parseMinutesExtractionJson(payload({
      summary: {
        overview: "출시 일정과 후속 작업을 정리했다.",
        topics: [
          {
            title: "출시 일정",
            summary: "금요일 출시로 확정했다.",
            source: { transcript_version_id: "tv-1", start_seq: 1, end_seq: 1 },
          },
          {
            title: "없는 주제",
            summary: "근거 없는 내용",
            source: { transcript_version_id: "tv-1", start_seq: 9, end_seq: 9 },
          },
        ],
      },
    }), request);

    expect(parsed.summary).toEqual({
      overview: "출시 일정과 후속 작업을 정리했다.",
      topics: [{
        title: "출시 일정",
        summary: "금요일 출시로 확정했다.",
        source: { transcript_version_id: "tv-1", start_seq: 1, end_seq: 1 },
      }],
    });
    expect(parsed.rejections).toEqual([{
      kind: "topic", candidateIndex: 1, code: "line_not_in_request",
    }]);
    expect(localRuleExtraction(request).summary).toBeNull();
    expect(parseMinutesExtractionJson(payload(), request).summary).toBeNull();
  });

  test("concatenates chunk topics in seq order and rebuilds overview from topic summaries", async () => {
    const longRequest: MinutesExtractionInput = {
      ...request,
      lines: Array.from({ length: 30 }, (_, index) => ({
        seq: index + 1,
        speakerTurn: index % 2,
        text: `근거 ${index + 1}: ${"긴 회의 발언 ".repeat(14)}결정했습니다.`,
      })),
    };
    const result = await new MinutesExtractor({
      async chat(prompt) {
        const json = prompt.slice(prompt.indexOf("\n") + 1).split("\n\nMeeting notes")[0]!;
        const chunk = JSON.parse(json) as MinutesExtractionInput;
        return payload({
          summary: {
            overview: "chunk-overview-must-not-survive-merge",
            topics: chunk.lines.map((line) => ({
              title: `주제 ${line.seq}`,
              summary: `요약 ${String(line.seq).padStart(2, "0")} ${"가".repeat(30)}`,
              source: { transcript_version_id: "tv-1", start_seq: line.seq, end_seq: line.seq },
            })),
          },
        });
      },
    }, 3_000).extract(longRequest);

    const topics = result.summary?.topics ?? [];
    expect(topics.map((topic) => topic.source.start_seq)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
    const joined = topics.map((topic) => topic.summary).join(" ");
    expect(result.summary?.overview).toBe(joined.slice(0, 600));
    expect(result.summary?.overview.length).toBeLessThanOrEqual(600);
    expect(result.summary?.overview).not.toContain("chunk-overview-must-not-survive-merge");
  });

  test("keeps a two-line action item that starts in the next chunk's context prefix", async () => {
    const longRequest: MinutesExtractionInput = {
      ...request,
      lines: Array.from({ length: 30 }, (_, index) => ({
        seq: index + 1,
        speakerTurn: index % 2,
        text: `근거 ${index + 1}: ${"긴 회의 발언 ".repeat(14)}결정했습니다.`,
      })),
    };
    const parsePrompt = (prompt: string): MinutesExtractionInput => {
      const json = prompt.slice(prompt.indexOf("\n") + 1).split("\n\nMeeting notes")[0]!;
      return JSON.parse(json) as MinutesExtractionInput;
    };
    const windows: number[][] = [];
    let probeChunk = 0;
    const probe = await new MinutesExtractor({
      async chat(prompt) {
        const chunk = parsePrompt(prompt);
        const index = probeChunk++;
        windows.push(chunk.lines.map((line) => line.seq));
        return payload({
          decisions: chunk.lines.map((line) => ({
            description: `${index}:${line.seq}`,
            sourceSegment: { transcript_version_id: "tv-1", start_seq: line.seq, end_seq: line.seq },
            evidenceQuote: line.text,
            suggestedAttributionAttendeeId: null,
          })),
        });
      },
    }, 3_000).extract(longRequest);

    const ownedByChunk = new Map<number, Set<number>>();
    for (const item of probe.decisions) {
      const [chunkText, seqText] = item.description.split(":");
      const chunk = Number(chunkText);
      const owned = ownedByChunk.get(chunk) ?? new Set<number>();
      owned.add(Number(seqText));
      ownedByChunk.set(chunk, owned);
    }
    expect(ownedByChunk.size).toBeGreaterThan(1);

    let boundary: { start_seq: number; end_seq: number } | null = null;
    let emittingChunk = -1;
    for (const [index, seqs] of windows.entries()) {
      if (index === 0) continue;
      const owned = ownedByChunk.get(index) ?? new Set<number>();
      const firstOwned = seqs.find((seq) => owned.has(seq));
      const prefix = seqs.filter((seq) => firstOwned !== undefined && !owned.has(seq) && seq < firstOwned);
      const lastPrefix = prefix[prefix.length - 1];
      if (lastPrefix !== undefined && firstOwned === lastPrefix + 1) {
        boundary = { start_seq: lastPrefix, end_seq: firstOwned };
        emittingChunk = index;
        break;
      }
    }
    expect(boundary).not.toBeNull();
    if (!boundary) throw new Error("expected a prefix-to-owned two-line boundary");
    const keptBoundary = boundary;

    let chatChunk = 0;
    const result = await new MinutesExtractor({
      async chat(prompt) {
        const chunk = parsePrompt(prompt);
        const index = chatChunk++;
        const seqs = chunk.lines.map((line) => line.seq);
        if (
          index !== emittingChunk ||
          !seqs.includes(keptBoundary.start_seq) || !seqs.includes(keptBoundary.end_seq)
        ) {
          return payload();
        }
        const startLine = chunk.lines.find((line) => line.seq === keptBoundary.start_seq);
        const endLine = chunk.lines.find((line) => line.seq === keptBoundary.end_seq);
        if (!startLine || !endLine) return payload();
        return payload({
          actionItems: [{
            description: "경계 작업",
            sourceSegment: {
              transcript_version_id: "tv-1",
              start_seq: keptBoundary.start_seq,
              end_seq: keptBoundary.end_seq,
            },
            evidenceQuote: `${startLine.text}\n${endLine.text}`,
            suggestedAttributionAttendeeId: null,
            suggestedAssigneeAttendeeId: null,
            deadline: null,
            deadlineText: null,
          }],
        });
      },
    }, 3_000).extract(longRequest);

    expect(result.actionItems).toHaveLength(1);
    expect(result.actionItems[0]?.sourceSegment).toEqual({
      transcript_version_id: "tv-1",
      start_seq: keptBoundary.start_seq,
      end_seq: keptBoundary.end_seq,
    });
  });
});

describe("extraction boundary characterization", () => {
  test("validates real calendar dates in parsed and local action items", () => {
    for (const [date, expected] of [
      ["2026-02-29", null], ["2024-02-29", "2024-02-29"],
      ["2026-04-31", null], ["2026년 8월 7일", "2026-08-07"],
    ]) {
      const text = `${date}까지 완료하겠습니다.`;
      const input = { ...request, lines: [{ seq: 17, speakerTurn: null, text }] };
      const parsed = parseMinutesExtractionJson(payload({ actionItems: [{
        description: "Complete", evidenceQuote: text, deadlineText: date,
        source: { transcript_version_id: "tv-1", start_seq: 17, end_seq: 17 },
      }] }), input);
      expect(parsed.actionItems[0]?.deadline).toBe(expected);
      expect(localRuleExtraction(input).actionItems[0]?.deadline).toBe(expected);
    }
  });

  test("bounds actual UTF-8 transport bytes and keeps oversized lines local", async () => {
    const budget = 4_000;
    const input = { ...request, lines: Array.from({ length: 12 }, (_, index) => ({
      seq: index + 20, speakerTurn: null,
      text: `${"한글😀".repeat(index === 5 ? 1_000 : 45)} 결정했습니다.`,
    })) };
    let calls = 0;
    const result = await new MinutesExtractor({ async chat(prompt, options) {
      calls++;
      expect(Buffer.byteLength(prompt) + Buffer.byteLength(options?.system ?? "")).toBeLessThanOrEqual(budget);
      const chunk: MinutesExtractionInput = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
      expect(chunk.lines.some((line) => line.seq === 25)).toBe(false);
      return payload();
    } }, budget).extract(input);
    expect(calls).toBeGreaterThan(1);
    expect(result.usedFallback).toBe(true);
    // oversized line stays local; empty LLM chunks union with local rules
    expect(result.decisions.map((item) => item.sourceSegment)).toContainEqual(
      { transcript_version_id: "tv-1", start_seq: 25, end_seq: 25 },
    );
    expect(result.decisions.every((item) => item.origin === "local_rule")).toBe(true);
    for (const invalid of [999, 1_000.5, NaN, Infinity]) {
      expect(() => chunkMinutesExtractionInput(input, invalid)).toThrow("maxBytes must be an integer >= 1000");
    }
  });

  test("awaits each transport completion before starting the next chunk", async () => {
    const input = { ...request, lines: Array.from({ length: 12 }, (_, index) => ({
      seq: index + 1, speakerTurn: null, text: "evidence ".repeat(80),
    })) };
    let active = 0;
    let maximum = 0;
    let calls = 0;
    await new MinutesExtractor({ async chat() {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return payload();
    } }, 3_000).extract(input);
    expect(calls).toBeGreaterThan(1);
    expect(maximum).toBe(1);
  });
});
