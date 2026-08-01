import { randomUUID } from "node:crypto";
import { MeetingStore } from "./minutes-store-meetings.ts";
import type { TranscriptLineInput, TranscriptSourceKind, TranscriptVersion } from "./minutes-store-types.ts";
import { nonBlank, validHash } from "./minutes-store-utils.ts";

export class TranscriptStore extends MeetingStore {
  addTranscriptVersion(meetingId: number, input: {
    transcriptVersionId?: string; sourceKind: TranscriptSourceKind; engine?: string | null; engineModel?: string | null;
  }): { transcriptVersionId: string; versionNo: number } {
    return this.db.transaction(() => {
      const latest = this.db.query(
        "SELECT coalesce(MAX(version_no), 0) AS version_no FROM transcript_versions WHERE meeting_id = ?",
      ).get(meetingId) as { version_no: number };
      const versionNo = latest.version_no + 1;
      const transcriptVersionId = input.transcriptVersionId ?? randomUUID();
      this.db.run(`
        INSERT INTO transcript_versions
          (transcript_version_id, meeting_id, version_no, source_kind, engine, engine_model, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [transcriptVersionId, meetingId, versionNo, input.sourceKind, input.engine ?? null,
        input.engineModel ?? null, Date.now()]);
      return { transcriptVersionId, versionNo };
    })();
  }

  addTranscriptVersionLines(transcriptVersionId: string, lines: TranscriptLineInput[]): void {
    this.db.transaction(() => {
      const version = this.db.query(
        "SELECT meeting_id, finalized_at FROM transcript_versions WHERE transcript_version_id = ?",
      ).get(transcriptVersionId) as { meeting_id: number; finalized_at: number | null } | null;
      if (!version) throw new Error(`unknown transcript version ${transcriptVersionId}`);
      if (version.finalized_at !== null) throw new Error(`transcript version ${transcriptVersionId} is finalized`);
      for (const line of lines) {
        this.db.run(`
          INSERT INTO transcript_version_lines
            (meeting_id, transcript_version_id, seq, captured_at_ms, audio_start_ms, audio_end_ms, speaker_turn, text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [version.meeting_id, transcriptVersionId, line.seq, line.capturedAtMs ?? null,
          line.audioStartMs ?? null, line.audioEndMs ?? null, line.speakerTurn ?? null,
          nonBlank(line.text, "transcript text")]);
      }
    })();
  }

  appendTranscriptLine(transcriptVersionId: string, line: Omit<TranscriptLineInput, "seq">, dualWriteLegacy: boolean): number {
    return this.db.transaction(() => {
      const version = this.db.query(
        "SELECT meeting_id, finalized_at FROM transcript_versions WHERE transcript_version_id = ?",
      ).get(transcriptVersionId) as { meeting_id: number; finalized_at: number | null } | null;
      if (!version) throw new Error(`unknown transcript version ${transcriptVersionId}`);
      if (version.finalized_at !== null) throw new Error(`transcript version ${transcriptVersionId} is finalized`);
      const latest = this.db.query(
        "SELECT coalesce(MAX(seq), 0) AS seq FROM transcript_version_lines WHERE transcript_version_id = ?",
      ).get(transcriptVersionId) as { seq: number };
      const seq = latest.seq + 1;
      const text = nonBlank(line.text, "transcript text");
      this.db.run(`
        INSERT INTO transcript_version_lines
          (meeting_id, transcript_version_id, seq, captured_at_ms, audio_start_ms, audio_end_ms, speaker_turn, text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [version.meeting_id, transcriptVersionId, seq, line.capturedAtMs ?? null,
        line.audioStartMs ?? null, line.audioEndMs ?? null, line.speakerTurn ?? null, text]);
      if (dualWriteLegacy) {
        this.db.run(
          "INSERT INTO transcript_lines (meeting_id, seq, ts, speaker, text) VALUES (?, ?, ?, ?, ?)",
          [version.meeting_id, seq, line.capturedAtMs ?? Date.now(), line.speakerTurn ?? null, text],
        );
      }
      return seq;
    })();
  }

  transcriptVersionLines(transcriptVersionId: string): Array<{
    seq: number; capturedAtMs: number | null; audioStartMs: number | null; audioEndMs: number | null;
    speakerTurn: number | null; text: string;
  }> {
    const rows = this.db.query(`
      SELECT seq, captured_at_ms, audio_start_ms, audio_end_ms, speaker_turn, text
      FROM transcript_version_lines WHERE transcript_version_id = ? ORDER BY seq
    `).all(transcriptVersionId) as Array<{
      seq: number; captured_at_ms: number | null; audio_start_ms: number | null;
      audio_end_ms: number | null; speaker_turn: number | null; text: string;
    }>;
    return rows.map((row) => ({
      seq: row.seq, capturedAtMs: row.captured_at_ms, audioStartMs: row.audio_start_ms,
      audioEndMs: row.audio_end_ms, speakerTurn: row.speaker_turn, text: row.text,
    }));
  }

  finalizeTranscriptVersion(transcriptVersionId: string, contentSha256: string): void {
    const result = this.db.run(`
      UPDATE transcript_versions SET content_sha256 = ?, finalized_at = ?
      WHERE transcript_version_id = ? AND finalized_at IS NULL
    `, [validHash(contentSha256), Date.now(), transcriptVersionId]);
    if (Number(result.changes) !== 1) throw new Error(`unknown or finalized transcript version ${transcriptVersionId}`);
  }

  setCanonical(meetingId: number, transcriptVersionId: string): void {
    const version = this.db.query(`
      SELECT finalized_at FROM transcript_versions WHERE meeting_id = ? AND transcript_version_id = ?
    `).get(meetingId, transcriptVersionId) as { finalized_at: number | null } | null;
    if (!version?.finalized_at) throw new Error("canonical transcript version must be finalized");
    this.db.run(`
      INSERT INTO meeting_transcript_state (meeting_id, canonical_transcript_version_id, canonical_selected_at)
      VALUES (?, ?, ?)
      ON CONFLICT(meeting_id) DO UPDATE SET
        canonical_transcript_version_id = excluded.canonical_transcript_version_id,
        canonical_selected_at = excluded.canonical_selected_at
    `, [meetingId, transcriptVersionId, Date.now()]);
  }

  latestVersion(meetingId: number): TranscriptVersion | null {
    const row = this.db.query(`
      SELECT * FROM transcript_versions WHERE meeting_id = ? ORDER BY version_no DESC LIMIT 1
    `).get(meetingId) as Record<string, unknown> | null;
    return this.versionRow(row);
  }

  canonicalVersion(meetingId: number): TranscriptVersion | null {
    const row = this.db.query(`
      SELECT tv.* FROM meeting_transcript_state mts
      JOIN transcript_versions tv ON tv.transcript_version_id = mts.canonical_transcript_version_id
      WHERE mts.meeting_id = ?
    `).get(meetingId) as Record<string, unknown> | null;
    return this.versionRow(row);
  }

  private versionRow(row: Record<string, unknown> | null): {
    transcriptVersionId: string; meetingId: number; versionNo: number; sourceKind: TranscriptSourceKind;
    engine: string | null; engineModel: string | null; finalizedAt: number | null; contentSha256: string | null;
  } | null {
    if (!row) return null;
    return {
      transcriptVersionId: row.transcript_version_id as string, meetingId: row.meeting_id as number,
      versionNo: row.version_no as number, sourceKind: row.source_kind as TranscriptSourceKind,
      engine: row.engine as string | null, engineModel: row.engine_model as string | null,
      finalizedAt: row.finalized_at as number | null, contentSha256: row.content_sha256 as string | null,
    };
  }

}
