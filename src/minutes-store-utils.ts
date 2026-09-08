import { canonicalLinesFromRows, hashCanonicalTranscript } from "./canonical-transcript.ts";
import type { ReviewMutationErrorCode } from "./minutes-store-types.ts";

export function nonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be blank`);
  return trimmed;
}

export function validHash(value: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error("sha256 must be a 64-character hexadecimal value");
  return value.toLowerCase();
}

export function reviewError(code: ReviewMutationErrorCode, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

export function transcriptLinesHash(lines: Array<{
  seq: number; captured_at_ms: number | null; speaker_turn: number | null; text: string;
}>): string {
  return hashCanonicalTranscript(canonicalLinesFromRows(lines));
}
