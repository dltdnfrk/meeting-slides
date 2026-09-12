import type { ChatTransport } from "./llm.js";
import type { MinutesExtractionInput, MinutesExtractionResult } from "./minutes-extraction-types.ts";
import { localRuleExtraction, parseMinutesExtractionJson } from "./minutes-extraction-parser.ts";
import {
  DEFAULT_EXTRACTION_CHUNK_CHARS, EXTRACTION_SYSTEM_PROMPT, extractionPrompt,
  planExtractionChunks, ownedExtractionResult, mergeExtractionResults, type ExtractionChunk,
} from "./minutes-extraction-chunks.ts";

export type {
  SourceSegmentRef, MinutesExtractionInput, CandidateKind, CandidateRejectionCode, CandidateRejection,
  ExtractedSummaryTopic, ExtractedSummary, ExtractedDecision, ExtractedActionItem, ExtractedOpenItem,
  MinutesExtractionResult,
} from "./minutes-extraction-types.ts";
export { localRuleExtraction, parseMinutesExtractionJson } from "./minutes-extraction-parser.ts";
export { DEFAULT_EXTRACTION_CHUNK_CHARS, chunkMinutesExtractionInput } from "./minutes-extraction-chunks.ts";

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
      if (!parsed.batchFailed) {
        const empty = !parsed.decisions.length && !parsed.actionItems.length && !parsed.openItems.length;
        if (empty) {
          const backfilled = mergeExtractionResults(request, [parsed, localRuleExtraction(request)]);
          backfilled.usedFallback = false;
          result = backfilled;
        } else {
          result = parsed;
        }
      } else {
        result = { ...localRuleExtraction(request), batchFailed: true, rejections: parsed.rejections };
      }
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
