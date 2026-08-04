import { createHash } from "node:crypto";
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
  const hash = createHash("sha256");
  for (const line of lines) {
    hash.update(JSON.stringify({
      seq: line.seq,
      ts: line.captured_at_ms,
      speaker_turn: line.speaker_turn,
      text: line.text,
    }));
    hash.update("\n");
  }
  return hash.digest("hex");
}
