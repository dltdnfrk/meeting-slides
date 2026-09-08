import { hashCanonicalTranscript, serializeCanonicalTranscript } from "./canonical-transcript.ts";
import type {
  AudioRecorderHandle,
  CanonicalAudioCaptureHandle,
  StoppedAudioRecording,
} from "./audio-recorder.ts";
import { MinutesStore, type TranscriptSourceKind } from "./minutes-store.ts";

export {
  RawAudioRecorder,
  claimFileAudioSource,
  sha256File,
} from "./audio-recorder.ts";
export type { AudioRecorderHandle, StoppedAudioRecording } from "./audio-recorder.ts";

export interface VersionedTranscriptEntry {
  ts: number | null;
  audioStartMs?: number | null;
  audioEndMs?: number | null;
  speaker?: number;
  text: string;
}

export interface FinalizedTranscriptVersion {
  transcriptVersionId: string;
  contentSha256: string;
}

export function canonicalTranscriptJsonl(store: MinutesStore, transcriptVersionId: string): string {
  return serializeCanonicalTranscript(store.transcriptVersionLines(transcriptVersionId));
}

export function transcriptContentSha256(store: MinutesStore, transcriptVersionId: string): string {
  return hashCanonicalTranscript(store.transcriptVersionLines(transcriptVersionId));
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
      audioStartMs: entry.audioStartMs ?? null,
      audioEndMs: entry.audioEndMs ?? null,
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

export type FinalizedRetranscription =
  | { status: "completed" }
  | { status: "not_requested" }
  | { status: "failed"; error: string };

export class CaptureFinalizer {
  private completion: Promise<FinalizedTranscriptVersion & {
    audio: FinalizedAudio;
    retranscription: FinalizedRetranscription;
  }> | null = null;

  constructor(
    private readonly store: MinutesStore,
    private readonly writer: TranscriptVersionWriter,
    private readonly meetingId: number,
    private readonly recorder: AudioRecorderHandle | CanonicalAudioCaptureHandle | null,
  ) {}

  finish(): Promise<FinalizedTranscriptVersion & {
    audio: FinalizedAudio;
    retranscription: FinalizedRetranscription;
  }> {
    this.completion ??= this.finishOnce();
    return this.completion;
  }

  private async finishOnce(): Promise<FinalizedTranscriptVersion & {
    audio: FinalizedAudio;
    retranscription: FinalizedRetranscription;
  }> {
    let audio: FinalizedAudio = { status: "unavailable", reason: "recorder_failed" };
    let duplicateError: Error | null = null;
    let stoppedRecording: StoppedAudioRecording | null = null;
    if (this.recorder) {
      try {
        stoppedRecording = await this.recorder.stop();
        const duplicateMeetingId = this.store.findMeetingByAudioHash(stoppedRecording.sha256);
        if (duplicateMeetingId !== null && duplicateMeetingId !== this.meetingId) {
          duplicateError = new Error(`[DUPLICATE_AUDIO] audio already belongs to meeting ${duplicateMeetingId}`);
        } else {
          this.store.addAudioSource(this.meetingId, {
            originalAudioPath: stoppedRecording.path,
            originalAudioSha256: stoppedRecording.sha256,
            byteLength: stoppedRecording.byteLength,
          });
          audio = { status: "available", ...stoppedRecording };
        }
      } catch {
        if (stoppedRecording) {
          const duplicateMeetingId = this.store.findMeetingByAudioHash(stoppedRecording.sha256);
          if (duplicateMeetingId !== null && duplicateMeetingId !== this.meetingId) {
            duplicateError = new Error(`[DUPLICATE_AUDIO] audio already belongs to meeting ${duplicateMeetingId}`);
          }
        }
        // Recorder failures leave no row; transcript finalization remains independent.
      }
    }
    const live = this.writer.finalize();
    let transcript = live;
    let retranscription: FinalizedRetranscription = { status: "not_requested" };
    if (stoppedRecording && this.recorder && "retranscribe" in this.recorder) {
      try {
        const secondPass = await this.recorder.retranscribe(stoppedRecording);
        if (secondPass.lines.length === 0) throw new Error("second-pass transcript is empty");
        this.writer.begin(this.meetingId, {
          sourceKind: "retranscription",
          engine: secondPass.engine,
          engineModel: secondPass.engineModel,
        });
        for (const line of secondPass.lines) {
          this.writer.append({
            ts: line.capturedAtMs,
            audioStartMs: line.audioStartMs,
            audioEndMs: line.audioEndMs,
            speaker: line.speakerTurn ?? undefined,
            text: line.text,
          });
        }
        transcript = this.writer.finalize();
        retranscription = { status: "completed" };
      } catch (error) {
        this.writer.abort();
        transcript = live;
        retranscription = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    // Canonical selection and both meeting lifecycle rows commit together.
    const finishMeeting = this.store.databaseHandle().transaction(() => {
      this.store.setCanonical(this.meetingId, transcript.transcriptVersionId);
      this.store.databaseHandle().run("UPDATE meetings SET ended_at = coalesce(ended_at, ?) WHERE id = ?", [Date.now(), this.meetingId]);
      if (this.store.meetingMeta(this.meetingId)?.phase === "capturing") this.store.endMeeting(this.meetingId);
    });
    finishMeeting.immediate();
    if (duplicateError) throw duplicateError;
    return { ...transcript, audio, retranscription };
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
