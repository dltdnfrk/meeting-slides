import { createHash } from "node:crypto";

import type { AudioRecorderHandle, StoppedAudioRecording } from "./audio-recorder.ts";
import { MinutesStore, type TranscriptSourceKind } from "./minutes-store.ts";

export {
  RawAudioRecorder,
  claimFileAudioSource,
  sha256File,
} from "./audio-recorder.ts";
export type { AudioRecorderHandle, StoppedAudioRecording } from "./audio-recorder.ts";

export interface VersionedTranscriptEntry {
  ts: number;
  speaker?: number;
  text: string;
}

export interface FinalizedTranscriptVersion {
  transcriptVersionId: string;
  contentSha256: string;
}

function canonicalLineJson(line: {
  seq: number;
  capturedAtMs: number | null;
  speakerTurn: number | null;
  text: string;
}): string {
  return JSON.stringify({
    seq: line.seq,
    ts: line.capturedAtMs,
    speaker_turn: line.speakerTurn,
    text: line.text,
  });
}

export function canonicalTranscriptJsonl(store: MinutesStore, transcriptVersionId: string): string {
  const lines = store.transcriptVersionLines(transcriptVersionId);
  return lines.map(canonicalLineJson).join("\n") + (lines.length > 0 ? "\n" : "");
}

export function transcriptContentSha256(store: MinutesStore, transcriptVersionId: string): string {
  return createHash("sha256").update(canonicalTranscriptJsonl(store, transcriptVersionId)).digest("hex");
}

export class TranscriptVersionWriter {
  private active: { meetingId: number; transcriptVersionId: string; dualWriteLegacy: boolean } | null = null;

  constructor(private readonly store: MinutesStore) {}

  begin(meetingId: number, input: {
    sourceKind: TranscriptSourceKind;
    engine?: string | null;
    engineModel?: string | null;
    dualWriteLegacy?: boolean;
  }): { transcriptVersionId: string; versionNo: number } {
    if (this.active) throw new Error("a transcript version is already being written");
    const version = this.store.addTranscriptVersion(meetingId, input);
    this.active = { meetingId, transcriptVersionId: version.transcriptVersionId, dualWriteLegacy: input.dualWriteLegacy ?? false };
    return version;
  }

  append(entry: VersionedTranscriptEntry): number {
    if (!this.active) throw new Error("no active transcript version");
    return this.store.appendTranscriptLine(this.active.transcriptVersionId, {
      capturedAtMs: entry.ts,
      speakerTurn: entry.speaker ?? null,
      text: entry.text,
    }, this.active.dualWriteLegacy);
  }

  finalize(options: { selectCanonical?: boolean } = {}): FinalizedTranscriptVersion {
    if (!this.active) throw new Error("no active transcript version");
    const active = this.active;
    const contentSha256 = transcriptContentSha256(this.store, active.transcriptVersionId);
    this.store.finalizeTranscriptVersion(active.transcriptVersionId, contentSha256);
    if (options.selectCanonical) this.store.setCanonical(active.meetingId, active.transcriptVersionId);
    this.active = null;
    return { transcriptVersionId: active.transcriptVersionId, contentSha256 };
  }

  abort(): void {
    this.active = null;
  }

  activeVersionId(): string | null {
    return this.active?.transcriptVersionId ?? null;
  }
}

export type FinalizedAudio =
  | { status: "available"; path: string; sha256: string; byteLength: number }
  | { status: "unavailable"; reason: "recorder_failed" };

export class CaptureFinalizer {
  private completion: Promise<FinalizedTranscriptVersion & { audio: FinalizedAudio }> | null = null;

  constructor(
    private readonly store: MinutesStore,
    private readonly writer: TranscriptVersionWriter,
    private readonly meetingId: number,
    private readonly recorder: AudioRecorderHandle | null,
  ) {}

  finish(): Promise<FinalizedTranscriptVersion & { audio: FinalizedAudio }> {
    this.completion ??= this.finishOnce();
    return this.completion;
  }

  private async finishOnce(): Promise<FinalizedTranscriptVersion & { audio: FinalizedAudio }> {
    let audio: FinalizedAudio = { status: "unavailable", reason: "recorder_failed" };
    let duplicateError: Error | null = null;
    if (this.recorder) {
      let recording: StoppedAudioRecording | null = null;
      try {
        recording = await this.recorder.stop();
        const duplicateMeetingId = this.store.findMeetingByAudioHash(recording.sha256);
        if (duplicateMeetingId !== null && duplicateMeetingId !== this.meetingId) {
          duplicateError = new Error(`[DUPLICATE_AUDIO] audio already belongs to meeting ${duplicateMeetingId}`);
        } else {
          this.store.addAudioSource(this.meetingId, {
            originalAudioPath: recording.path,
            originalAudioSha256: recording.sha256,
            byteLength: recording.byteLength,
          });
          audio = { status: "available", ...recording };
        }
      } catch {
        if (recording) {
          const duplicateMeetingId = this.store.findMeetingByAudioHash(recording.sha256);
          if (duplicateMeetingId !== null && duplicateMeetingId !== this.meetingId) {
            duplicateError = new Error(`[DUPLICATE_AUDIO] audio already belongs to meeting ${duplicateMeetingId}`);
          }
        }
        // Recorder failures leave no row; transcript finalization remains independent.
      }
    }
    const transcript = this.writer.finalize({ selectCanonical: true });
    if (duplicateError) throw duplicateError;
    return { ...transcript, audio };
  }
}

export function snapshotLegacyTranscript(store: MinutesStore, meetingId: number): FinalizedTranscriptVersion {
  if (store.latestVersion(meetingId)) throw new Error(`meeting ${meetingId} already has a transcript version`);
  const db = store.databaseHandle();
  const duplicate = db.query(`
    SELECT seq FROM transcript_lines WHERE meeting_id = ? GROUP BY seq HAVING COUNT(*) > 1 LIMIT 1
  `).get(meetingId) as { seq: number } | null;
  if (duplicate) throw new Error(`duplicate legacy transcript seq ${duplicate.seq}`);
  const lines = db.query(`
    SELECT seq, ts, speaker, text FROM transcript_lines WHERE meeting_id = ? ORDER BY seq
  `).all(meetingId) as Array<{ seq: number; ts: number; speaker: number | null; text: string }>;
  const version = store.addTranscriptVersion(meetingId, { sourceKind: "import", engine: "legacy_snapshot" });
  store.addTranscriptVersionLines(version.transcriptVersionId, lines.map((line) => ({
    seq: line.seq,
    capturedAtMs: line.ts,
    speakerTurn: line.speaker,
    text: line.text,
  })));
  const contentSha256 = transcriptContentSha256(store, version.transcriptVersionId);
  store.finalizeTranscriptVersion(version.transcriptVersionId, contentSha256);
  store.setCanonical(meetingId, version.transcriptVersionId);
  return { transcriptVersionId: version.transcriptVersionId, contentSha256 };
}
