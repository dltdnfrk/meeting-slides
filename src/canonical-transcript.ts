import { createHash } from "node:crypto";

export interface CanonicalTranscriptLine {
  readonly seq: number;
  readonly capturedAtMs: number | null;
  readonly speakerTurn: number | null;
  readonly text: string;
}

export interface CanonicalTranscriptRow {
  readonly seq: number;
  readonly captured_at_ms: number | null;
  readonly speaker_turn: number | null;
  readonly text: string;
}

/** Adapt stored rows lazily; ordering and ingestion validation belong to callers. */
export function* canonicalLinesFromRows(rows: Iterable<CanonicalTranscriptRow>): IterableIterator<CanonicalTranscriptLine> {
  for (const row of rows) {
    yield { seq: row.seq, capturedAtMs: row.captured_at_ms, speakerTurn: row.speaker_turn, text: row.text };
  }
}

// Historical archive encoding, NOT the live SlidePlan {seq,speaker,text} fingerprint.
function canonicalLineJson(line: CanonicalTranscriptLine): string {
  return JSON.stringify({
    seq: line.seq,
    ts: line.capturedAtMs,
    speaker_turn: line.speakerTurn,
    text: line.text,
  });
}

export function serializeCanonicalTranscript(lines: Iterable<CanonicalTranscriptLine>): string {
  const jsonl: string[] = [];
  for (const line of lines) jsonl.push(canonicalLineJson(line), "\n");
  return jsonl.join("");
}

/** Hash each UTF-8 line and its terminator without materializing the transcript. */
export function hashCanonicalTranscript(lines: Iterable<CanonicalTranscriptLine>): string {
  const hash = createHash("sha256");
  for (const line of lines) {
    hash.update(canonicalLineJson(line));
    hash.update("\n");
  }
  return hash.digest("hex");
}
