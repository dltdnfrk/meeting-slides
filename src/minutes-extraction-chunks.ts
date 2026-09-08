import type {
  CandidateKind, ExtractedBase, ExtractedSummary, ExtractedSummaryTopic,
  MinutesExtractionInput, MinutesExtractionResult,
} from "./minutes-extraction-types.ts";
import { emptyResult, OVERVIEW_MAX_CHARS } from "./minutes-extraction-parser.ts";

export const EXTRACTION_SYSTEM_PROMPT = `You extract review candidates from an immutable meeting transcript.
Return one JSON object only with transcriptVersionId, decisions, actionItems, openItems, and summary.
Every candidate must include description, sourceSegment {transcript_version_id,start_seq,end_seq}, evidenceQuote, and suggestedAttributionAttendeeId.
Action items also include suggestedAssigneeAttendeeId, deadline, and deadlineText.
Ground every candidate first: never renumber seq, and evidenceQuote must be a verbatim substring of the cited contiguous lines.
speakerTurn is not an attendee identity. Never map it to an attendee. Attendee fields are suggestions and must use only supplied attendeeId values.
Emit no candidate without direct evidence. Normalize a deadline to ISO YYYY-MM-DD only when an absolute date is explicit; otherwise use null.
Korean and English both count. Informal agreements and explicit decisions are decisions when the quote is verbatim.
Example decision evidenceQuote: "그럼 그걸로 하죠"
Example decision evidenceQuote: "We decided to ship Friday"
summary is {overview, topics} in the transcript language. overview is at most 600 characters.
Each topic has title (<=60 chars), summary (<=300 chars), and source {transcript_version_id,start_seq,end_seq} citing a contiguous range in this request.
Never invent a topic without a grounded source range.`;

export const DEFAULT_EXTRACTION_CHUNK_CHARS = 48_000;
const EXTRACTION_CONTEXT_LINES = 4;
const MAX_NOTES_PROMPT_CHARS = 12_000;

export interface ExtractionChunk {
  request: MinutesExtractionInput;
  ownedStartSeq: number;
  ownedEndSeq: number;
  oversized: boolean;
}

export function extractionPrompt(request: MinutesExtractionInput): string {
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

export function planExtractionChunks(request: MinutesExtractionInput, maxBytes: number): ExtractionChunk[] {
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

export function ownedExtractionResult(result: MinutesExtractionResult, chunk: ExtractionChunk): MinutesExtractionResult {
  const owned = <T extends ExtractedBase>(values: readonly T[]) => values.filter((value) =>
    value.sourceSegment.end_seq >= chunk.ownedStartSeq && value.sourceSegment.end_seq <= chunk.ownedEndSeq
  );
  const ownedTopics = result.summary?.topics.filter((topic) =>
    topic.source.end_seq >= chunk.ownedStartSeq && topic.source.end_seq <= chunk.ownedEndSeq
  ) ?? [];
  return {
    ...result,
    decisions: owned(result.decisions),
    actionItems: owned(result.actionItems),
    openItems: owned(result.openItems),
    summary: result.summary
      ? { overview: result.summary.overview, topics: ownedTopics }
      : null,
  };
}

function mergeSummaries(results: readonly MinutesExtractionResult[]): ExtractedSummary | null {
  const seen = new Set<string>();
  const topics: ExtractedSummaryTopic[] = [];
  for (const result of results) {
    if (!result.summary) continue;
    for (const topic of result.summary.topics) {
      const source = topic.source;
      const key = JSON.stringify([source.transcript_version_id, source.start_seq, source.end_seq, topic.title]);
      if (seen.has(key)) continue;
      seen.add(key);
      topics.push(topic);
    }
  }
  topics.sort((a, b) => a.source.start_seq - b.source.start_seq || a.source.end_seq - b.source.end_seq);
  if (topics.length === 0) return null;
  return { overview: topics.map((topic) => topic.summary).join(" ").slice(0, OVERVIEW_MAX_CHARS), topics };
}

export function mergeExtractionResults(
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
  merged.summary = mergeSummaries(results);
  return merged;
}
