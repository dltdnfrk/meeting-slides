import { describe, expect, test } from "bun:test";

import { canonicalLinesFromRows, hashCanonicalTranscript, serializeCanonicalTranscript } from "../src/canonical-transcript.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { transcriptLinesHash } from "../src/minutes-store-utils.ts";
import { MeetingStore } from "../src/store.ts";
import { canonicalTranscriptJsonl, transcriptContentSha256 } from "../src/transcript-versioning.ts";

const rows = [
  { seq: 2, captured_at_ms: null, speaker_turn: null, text: "  \ud55c\uae00 \ud83d\ude00 e\u0301\nline\r\n\t\"\\  " },
  { seq: 7, captured_at_ms: 0, speaker_turn: 1, text: "tail" },
];
const expectedHex = "7b22736571223a322c227473223a6e756c6c2c22737065616b65725f7475726e223a6e756c6c2c2274657874223a222020ed959ceab88020f09f98802065cc815c6e6c696e655c725c6e5c745c225c5c2020227d0a7b22736571223a372c227473223a302c22737065616b65725f7475726e223a312c2274657874223a227461696c227d0a";
const expectedHash = "b3b35b452d0777743d70c8d5bcc7d7f9c631ee611bfff205576240fda06e6105";
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("historical canonical transcript bytes", () => {
  test("shares the literal byte contract with the pure serializer and iterable hash", () => {
    const serialized = serializeCanonicalTranscript(canonicalLinesFromRows(rows));

    expect(Buffer.from(serialized).toString("hex")).toBe(expectedHex);
    expect(hashCanonicalTranscript(canonicalLinesFromRows(rows))).toBe(expectedHash);
    expect(serializeCanonicalTranscript([])).toBe("");
    expect(hashCanonicalTranscript([])).toBe(emptyHash);
  });

  test("hashes each line before advancing a single-use iterator", () => {
    function* lines() {
      const line = { seq: 2, capturedAtMs: null, speakerTurn: null, text: rows[0].text };
      yield line;
      Object.assign(line, { seq: 7, capturedAtMs: 0, speakerTurn: 1, text: "tail" });
      yield line;
    }

    const hash = hashCanonicalTranscript(lines());

    expect(hash).toBe(expectedHash);
  });

  test("preserves persisted nulls, zero timestamps, Unicode and escaped embedded newlines", () => {
    const legacy = new MeetingStore(":memory:");
    try {
      const store = new MinutesStore(legacy.databaseHandle());
      const meetingId = legacy.startMeeting("cli:test");
      store.registerCapturingMeeting(meetingId);
      const version = store.addTranscriptVersion(meetingId, { sourceKind: "import" });
      // Exercise persisted bytes, not the separate nonBlank ingestion policy.
      for (const row of [...rows].reverse()) {
        store.databaseHandle().run(`INSERT INTO transcript_version_lines
          (meeting_id, transcript_version_id, seq, captured_at_ms, speaker_turn, text)
          VALUES (?, ?, ?, ?, ?, ?)`, [meetingId, version.transcriptVersionId,
          row.seq, row.captured_at_ms, row.speaker_turn, row.text]);
      }

      const jsonl = canonicalTranscriptJsonl(store, version.transcriptVersionId);

      expect(Buffer.from(jsonl).toString("hex")).toBe(expectedHex);
      expect(Buffer.byteLength(jsonl)).toBe(133);
      expect(transcriptContentSha256(store, version.transcriptVersionId)).toBe(expectedHash);
      expect(transcriptLinesHash(rows)).toBe(expectedHash);
    } finally {
      legacy.close();
    }
  });

  test("hashes empty text and zero speaker without applying ingestion validation", () => {
    const edgeRows = [rows[0], { seq: 7, captured_at_ms: 0, speaker_turn: 0, text: "" }];

    const hash = transcriptLinesHash(edgeRows);

    expect(hash).toBe("f19e55fdb8880c69a214b21c5fcf51726e7cb4fbe397ff3724dc549fd1b104aa");
  });

  test("emits no newline and hashes zero bytes for an empty transcript", () => {
    const legacy = new MeetingStore(":memory:");
    try {
      const store = new MinutesStore(legacy.databaseHandle());
      const meetingId = legacy.startMeeting("cli:test");
      store.registerCapturingMeeting(meetingId);
      const version = store.addTranscriptVersion(meetingId, { sourceKind: "import" });

      const jsonl = canonicalTranscriptJsonl(store, version.transcriptVersionId);

      expect(jsonl).toBe("");
      expect(transcriptContentSha256(store, version.transcriptVersionId)).toBe(emptyHash);
      expect(transcriptLinesHash([])).toBe(emptyHash);
    } finally {
      legacy.close();
    }
  });
});
