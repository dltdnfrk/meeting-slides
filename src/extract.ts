import { randomUUID } from "node:crypto";

import type { ChatTransport } from "./llm.js";

export interface SourceSegmentRef {
  transcript_version_id: string;
  start_seq: number;
  end_seq: number;
}

export interface MinutesExtractionInput {
  schemaVersion: string | number;
  meetingDate: string;
  timeZone: string;
  transcriptVersionId: string;
  attendees: Array<{ attendeeId: string; displayName: string }>;
  lines: Array<{ seq: number; speakerTurn: number | null; text: string }>;
  notes?: string;
}

export type CandidateKind = "decision" | "action_item" | "open_item";
export type CandidateRejectionCode =
  | "missing_source" | "wrong_transcript_version" | "invalid_seq_range"
  | "line_not_in_request" | "line_not_found" | "non_contiguous_range"
  | "evidence_quote_mismatch";

export interface CandidateRejection {
  kind: CandidateKind | "batch";
  candidateIndex: number;
  code: CandidateRejectionCode;
}

interface ExtractedBase {
  id: string;
  description: string;
  sourceSegment: SourceSegmentRef;
  evidenceQuote: string;
  suggestedAttributionAttendeeId: string | null;
  origin: "llm" | "local_rule";
}

export interface ExtractedDecision extends ExtractedBase {}
export interface ExtractedActionItem extends ExtractedBase {
  suggestedAssigneeAttendeeId: string | null;
  deadline: string | null;
  deadlineText: string | null;
}
export interface ExtractedOpenItem extends ExtractedBase {}

export interface MinutesExtractionResult {
  transcriptVersionId: string;
  decisions: ExtractedDecision[];
  actionItems: ExtractedActionItem[];
  openItems: ExtractedOpenItem[];
  rejections: CandidateRejection[];
  batchFailed: boolean;
  usedFallback: boolean;
}

const EXTRACTION_SYSTEM_PROMPT = `You extract review candidates from an immutable meeting transcript.
Return one JSON object only with transcriptVersionId, decisions, actionItems, and openItems.
Every candidate must include description, sourceSegment {transcript_version_id,start_seq,end_seq}, evidenceQuote, and suggestedAttributionAttendeeId.
Action items also include suggestedAssigneeAttendeeId, deadline, and deadlineText.
Ground every candidate first: never renumber seq, and evidenceQuote must be a verbatim substring of the cited contiguous lines.
speakerTurn is not an attendee identity. Never map it to an attendee. Attendee fields are suggestions and must use only supplied attendeeId values.
Emit no candidate without direct evidence. Normalize a deadline to ISO YYYY-MM-DD only when an absolute date is explicit; otherwise use null.`;

function emptyResult(request: MinutesExtractionInput, batchFailed = false): MinutesExtractionResult {
  return {
    transcriptVersionId: request.transcriptVersionId,
    decisions: [], actionItems: [], openItems: [], rejections: [],
    batchFailed, usedFallback: false,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function sourceFrom(raw: Record<string, unknown>): SourceSegmentRef | null {
  const source = record(raw.sourceSegment ?? raw.source_segment);
  if (!source) return null;
  return {
    transcript_version_id: source.transcript_version_id as string ?? source.transcriptVersionId as string,
    start_seq: source.start_seq as number ?? source.startSeq as number,
    end_seq: source.end_seq as number ?? source.endSeq as number,
  };
}

function sourceText(source: SourceSegmentRef, request: MinutesExtractionInput): string {
  return request.lines.filter((line) => line.seq >= source.start_seq && line.seq <= source.end_seq)
    .map((line) => line.text).join("\n");
}

function rejectionFor(
  raw: Record<string, unknown>, request: MinutesExtractionInput,
): CandidateRejectionCode | null {
  const source = sourceFrom(raw);
  if (!source) return "missing_source";
  if (source.transcript_version_id !== request.transcriptVersionId) return "wrong_transcript_version";
  if (!Number.isInteger(source.start_seq) || !Number.isInteger(source.end_seq) ||
      source.start_seq < 1 || source.end_seq < source.start_seq) return "invalid_seq_range";

  const seqs = request.lines.map((line) => line.seq);
  const min = seqs.length ? Math.min(...seqs) : Infinity;
  const max = seqs.length ? Math.max(...seqs) : -Infinity;
  if (source.start_seq < min || source.end_seq > max) return "line_not_in_request";
  const lines = new Map(request.lines.map((line) => [line.seq, line]));
  if (!lines.has(source.start_seq) || !lines.has(source.end_seq)) return "line_not_found";
  for (let seq = source.start_seq; seq <= source.end_seq; seq++) {
    if (!lines.has(seq)) return "non_contiguous_range";
  }
  const quote = raw.evidenceQuote;
  if (typeof quote !== "string" || !quote || !sourceText(source, request).includes(quote)) {
    return "evidence_quote_mismatch";
  }
  const attendeeIds = new Set(request.attendees.map((attendee) => attendee.attendeeId));
  for (const key of ["suggestedAttributionAttendeeId", "suggestedAssigneeAttendeeId"] as const) {
    const value = raw[key];
    if (value !== undefined && value !== null && (typeof value !== "string" || !attendeeIds.has(value))) {
      // The contract has no attendee-specific code; this means the suggested identity was not in the request.
      return "line_not_in_request";
    }
  }
  return typeof raw.description === "string" && raw.description.trim() ? null : "missing_source";
}

export function parseMinutesExtractionJson(content: string, request: MinutesExtractionInput): MinutesExtractionResult {
  const result = emptyResult(request);
  let top: Record<string, unknown> | null = null;
  try { top = record(JSON.parse(content)); } catch { /* batch failure below */ }
  if (!top) return { ...result, batchFailed: true };
  if (top.transcriptVersionId !== request.transcriptVersionId) {
    return { ...result, batchFailed: true, rejections: [{
      kind: "batch", candidateIndex: -1, code: "wrong_transcript_version",
    }] };
  }

  const specs = [
    ["decisions", "decision"], ["actionItems", "action_item"], ["openItems", "open_item"],
  ] as const;
  for (const [field, kind] of specs) {
    const candidates = Array.isArray(top[field]) ? top[field] : [];
    candidates.forEach((value, candidateIndex) => {
      const raw = record(value);
      const code = raw ? rejectionFor(raw, request) : "missing_source";
      if (code || !raw) {
        result.rejections.push({ kind, candidateIndex, code: code ?? "missing_source" });
        return;
      }
      const base: ExtractedBase = {
        id: randomUUID(), description: raw.description as string,
        sourceSegment: sourceFrom(raw)!, evidenceQuote: raw.evidenceQuote as string,
        suggestedAttributionAttendeeId: raw.suggestedAttributionAttendeeId as string | null ?? null,
        origin: "llm",
      };
      if (kind === "decision") result.decisions.push(base);
      else if (kind === "open_item") result.openItems.push(base);
      else {
        const transcriptText = sourceText(base.sourceSegment, request);
        const suggestedDeadlineText = raw.deadlineText;
        const deadlineText = typeof suggestedDeadlineText === "string" && suggestedDeadlineText &&
          transcriptText.includes(suggestedDeadlineText) ? suggestedDeadlineText : null;
        result.actionItems.push({
          ...base,
          suggestedAssigneeAttendeeId: raw.suggestedAssigneeAttendeeId as string | null ?? null,
          deadline: deadlineText ? absoluteDeadline(deadlineText) : null,
          deadlineText,
        });
      }
    });
  }
  return result;
}

const DECISION_END = /(?:(?:결정|확정|합의|채택)(?:했습니다|하였습니다|했다|하였다|합니다|한다)|하기로 (?:했습니다|했다|하였다))[.!?]?$/;
const ACTION_END = /(?:하겠습니다|할게요|맡겠습니다|담당하겠습니다)[.!?]?$/;
const DEADLINE_ACTION = /까지.+(?:완료|공유)(?:하겠습니다|할게요|했습니다|했다)?[.!?]?$/;
const OPEN_END = /(?:미정|보류|확인 필요|결정하지 못했다)[.!?]?$|(?:추후 논의|다음 회의에서)(?:하겠습니다|하죠|합니다)?[.!?]?$/;

function absoluteDeadline(text: string): string | null {
  const match = text.match(/(?:^|\D)(\d{4})(?:[-./](\d{1,2})[-./](\d{1,2})|년\s*(\d{1,2})월\s*(\d{1,2})일)(?=\D|$)/);
  if (!match) return null;
  const month = match[2] ?? match[4]!;
  const day = match[3] ?? match[5]!;
  const value = `${match[1]}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value) ? value : null;
}

export function localRuleExtraction(request: MinutesExtractionInput): MinutesExtractionResult {
  const result = emptyResult(request);
  result.usedFallback = true;
  for (const line of request.lines) {
    const sourceSegment = {
      transcript_version_id: request.transcriptVersionId, start_seq: line.seq, end_seq: line.seq,
    };
    const base: ExtractedBase = {
      id: randomUUID(), description: line.text, sourceSegment, evidenceQuote: line.text,
      suggestedAttributionAttendeeId: null, origin: "local_rule",
    };
    if (DECISION_END.test(line.text)) result.decisions.push(base);
    else if (OPEN_END.test(line.text)) result.openItems.push(base);
    else if (ACTION_END.test(line.text) || DEADLINE_ACTION.test(line.text)) {
      const mentioned = request.attendees.filter((attendee) => line.text.includes(attendee.displayName));
      const deadline = absoluteDeadline(line.text);
      result.actionItems.push({
        ...base, suggestedAssigneeAttendeeId: mentioned.length === 1 ? mentioned[0]!.attendeeId : null,
        deadline, deadlineText: deadline ? line.text : /까지/.test(line.text) ? line.text : null,
      });
    }
  }
  return result;
}

export const DEFAULT_EXTRACTION_CHUNK_CHARS = 48_000;
const EXTRACTION_CONTEXT_LINES = 4;
const MAX_NOTES_PROMPT_CHARS = 12_000;

interface ExtractionChunk {
  request: MinutesExtractionInput;
  ownedStartSeq: number;
  ownedEndSeq: number;
  oversized: boolean;
}

function extractionPrompt(request: MinutesExtractionInput): string {
  const notes = request.notes?.trim();
  const notesBlock = notes
    ? `

Meeting notes taken by the user during the call:
${notes.slice(0, MAX_NOTES_PROMPT_CHARS)}${notes.length > MAX_NOTES_PROMPT_CHARS ? "\n[notes truncated to prompt budget]" : ""}

Use the notes as a guide: candidates that appear in the notes but lack direct transcript evidence must still be grounded in a verbatim quote; if no evidence exists, do not emit them.`
    : "";
  const { notes: _notes, ...promptRequest } = request;
  return `Extract candidates from this request without changing any seq values. Use the smallest contiguous evidence range:
${JSON.stringify(promptRequest)}${notesBlock}`;
}

function extractionPromptBytes(request: MinutesExtractionInput): number {
  return Buffer.byteLength(EXTRACTION_SYSTEM_PROMPT, "utf8") + Buffer.byteLength(extractionPrompt(request), "utf8");
}

function planExtractionChunks(request: MinutesExtractionInput, maxBytes: number): ExtractionChunk[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_000) throw new TypeError("maxBytes must be an integer >= 1000");
  if (request.lines.length === 0 || extractionPromptBytes(request) <= maxBytes) {
    return [{
      request,
      ownedStartSeq: request.lines[0]?.seq ?? 0,
      ownedEndSeq: request.lines.at(-1)?.seq ?? 0,
      oversized: false,
    }];
  }

  const chunks: ExtractionChunk[] = [];
  const coreBudget = Math.floor(maxBytes * 0.8);
  let start = 0;
  while (start < request.lines.length) {
    const single = { ...request, lines: request.lines.slice(start, start + 1) };
    if (extractionPromptBytes(single) > maxBytes) {
      chunks.push({
        request: single,
        ownedStartSeq: request.lines[start]!.seq,
        ownedEndSeq: request.lines[start]!.seq,
        oversized: true,
      });
      start += 1;
      continue;
    }

    let end = start + 1;
    while (end < request.lines.length) {
      const candidate = { ...request, lines: request.lines.slice(start, end + 1) };
      if (extractionPromptBytes(candidate) > coreBudget) break;
      end += 1;
    }
    let contextStart = Math.max(0, start - EXTRACTION_CONTEXT_LINES);
    let contextEnd = Math.min(request.lines.length, end + EXTRACTION_CONTEXT_LINES);
    let chunkRequest = { ...request, lines: request.lines.slice(contextStart, contextEnd) };
    while (extractionPromptBytes(chunkRequest) > maxBytes && (contextStart < start || contextEnd > end)) {
      if (contextEnd > end) contextEnd -= 1;
      else contextStart += 1;
      chunkRequest = { ...request, lines: request.lines.slice(contextStart, contextEnd) };
    }
    chunks.push({
      request: chunkRequest,
      ownedStartSeq: request.lines[start]!.seq,
      ownedEndSeq: request.lines[end - 1]!.seq,
      oversized: false,
    });
    start = end;
  }
  return chunks;
}

export function chunkMinutesExtractionInput(
  request: MinutesExtractionInput,
  maxBytes = DEFAULT_EXTRACTION_CHUNK_CHARS,
): MinutesExtractionInput[] {
  return planExtractionChunks(request, maxBytes).map((chunk) => chunk.request);
}

function ownedExtractionResult(result: MinutesExtractionResult, chunk: ExtractionChunk): MinutesExtractionResult {
  const owned = <T extends ExtractedBase>(values: readonly T[]) => values.filter((value) =>
    value.sourceSegment.start_seq >= chunk.ownedStartSeq && value.sourceSegment.start_seq <= chunk.ownedEndSeq
  );
  return {
    ...result,
    decisions: owned(result.decisions),
    actionItems: owned(result.actionItems),
    openItems: owned(result.openItems),
  };
}

function mergeExtractionResults(
  request: MinutesExtractionInput,
  results: readonly MinutesExtractionResult[],
): MinutesExtractionResult {
  const merged = emptyResult(request);
  const seen = new Set<string>();
  const append = <T extends ExtractedBase>(kind: CandidateKind, target: T[], values: readonly T[]) => {
    for (const value of values) {
      const source = value.sourceSegment;
      const key = JSON.stringify([kind, source.transcript_version_id, source.start_seq, source.end_seq, value.evidenceQuote]);
      if (seen.has(key)) continue;
      seen.add(key);
      target.push(value);
    }
  };
  for (const result of results) {
    append("decision", merged.decisions, result.decisions);
    append("action_item", merged.actionItems, result.actionItems);
    append("open_item", merged.openItems, result.openItems);
    merged.rejections.push(...result.rejections);
    merged.batchFailed ||= result.batchFailed;
    merged.usedFallback ||= result.usedFallback;
  }
  const bySource = (a: ExtractedBase, b: ExtractedBase) =>
    a.sourceSegment.start_seq - b.sourceSegment.start_seq || a.sourceSegment.end_seq - b.sourceSegment.end_seq;
  merged.decisions.sort(bySource);
  merged.actionItems.sort(bySource);
  merged.openItems.sort(bySource);
  return merged;
}

export class MinutesExtractor {
  constructor(
    private readonly transport: ChatTransport,
    private readonly maxChunkChars = DEFAULT_EXTRACTION_CHUNK_CHARS,
  ) {}

  private async extractChunk(chunk: ExtractionChunk): Promise<MinutesExtractionResult> {
    const request = chunk.request;
    if (chunk.oversized) return localRuleExtraction(request);
    let result: MinutesExtractionResult;
    try {
      const parsed = parseMinutesExtractionJson(await this.transport.chat(extractionPrompt(request), {
        system: EXTRACTION_SYSTEM_PROMPT, temperature: 0, maxTokens: 4000,
      }), request);
      result = !parsed.batchFailed
        ? parsed
        : { ...localRuleExtraction(request), batchFailed: true, rejections: parsed.rejections };
    } catch {
      result = localRuleExtraction(request);
    }
    return ownedExtractionResult(result, chunk);
  }

  async extract(request: MinutesExtractionInput): Promise<MinutesExtractionResult> {
    const chunks = planExtractionChunks(request, this.maxChunkChars);
    if (chunks.length === 1) return this.extractChunk(chunks[0]!);
    const results: MinutesExtractionResult[] = [];
    // Sequential calls avoid multiplying provider rate-limit pressure for long meetings.
    for (const chunk of chunks) results.push(await this.extractChunk(chunk));
    return mergeExtractionResults(request, results);
  }
}
