import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, rmSync, statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { MinutesStore, type TranscriptSourceKind } from "./minutes-store.ts";

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
  audioStartMs: number | null;
  audioEndMs: number | null;
  speakerTurn: number | null;
  text: string;
}): string {
  return JSON.stringify({
    seq: line.seq,
    captured_at_ms: line.capturedAtMs,
    audio_start_ms: line.audioStartMs,
    audio_end_ms: line.audioEndMs,
    speaker_turn: line.speakerTurn,
    text: line.text,
  });
}

export function transcriptContentSha256(store: MinutesStore, transcriptVersionId: string): string {
  const hash = createHash("sha256");
  for (const line of store.transcriptVersionLines(transcriptVersionId)) {
    hash.update(canonicalLineJson(line));
    hash.update("\n");
  }
  return hash.digest("hex");
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

export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const bytes = readFileSync(path);
  hash.update(bytes);
  return hash.digest("hex");
}

export function claimFileAudioSource(store: MinutesStore, meetingId: number, path: string): {
  duplicateMeetingId: number | null;
  sha256: string;
  byteLength: number;
} {
  const byteLength = statSync(path).size;
  const sha256 = sha256File(path);
  const existing = store.findMeetingByAudioHash(sha256);
  if (existing !== null) return { duplicateMeetingId: existing, sha256, byteLength };
  try {
    store.addAudioSource(meetingId, { originalAudioSha256: sha256, originalAudioPath: path, byteLength });
    return { duplicateMeetingId: null, sha256, byteLength };
  } catch (error) {
    const collision = store.findMeetingByAudioHash(sha256);
    if (collision !== null) return { duplicateMeetingId: collision, sha256, byteLength };
    throw error;
  }
}

function recorderArgs(bin: string, captureId: number, outputPath: string): string[] {
  const name = basename(bin).toLowerCase();
  if (name.includes("ffmpeg")) {
    const input = captureId < 0 ? ":default" : `:${captureId}`;
    return ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", input,
      "-acodec", "pcm_s16le", "-y", outputPath];
  }
  if (name === "rec" || name.includes("sox")) return ["-q", "-d", outputPath];
  throw new Error(`unsupported audio recorder: ${bin}`);
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
}

export class RawAudioRecorder {
  private constructor(private readonly proc: ChildProcess, private readonly outputPath: string) {}

  static async start(input: { bin: string; captureId: number; outputPath: string }): Promise<RawAudioRecorder> {
    removeIfPresent(input.outputPath);
    const targetName = basename(input.outputPath);
    const { promise: outputCreated, resolve: created, reject: createFailed } = Promise.withResolvers<void>();
    const watcher = watch(dirname(input.outputPath), (_event, filename) => {
      if (filename === targetName && existsSync(input.outputPath)) created();
    });
    watcher.once("error", createFailed);
    const proc = spawn(input.bin, recorderArgs(input.bin, input.captureId, input.outputPath), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("audio recorder did not create output within 5 seconds")), 5_000);
        const finish = (fn: () => void) => {
          clearTimeout(timer);
          proc.off("error", onError);
          proc.off("close", onClose);
          watcher.close();
          fn();
        };
        const onError = (error: Error) => finish(() => reject(error));
        const onClose = () => finish(() => reject(new Error("audio recorder exited before creating output")));
        proc.once("error", onError);
        proc.once("close", onClose);
        outputCreated.then(() => finish(resolve), (error) => finish(() => reject(error)));
      });
      return new RawAudioRecorder(proc, input.outputPath);
    } catch (error) {
      removeIfPresent(input.outputPath);
      throw error;
    }
  }

  async stop(): Promise<{ path: string; sha256: string; byteLength: number }> {
    try {
      if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGTERM");
      await new Promise<void>((resolve, reject) => {
        if (this.proc.exitCode !== null || this.proc.signalCode !== null) return resolve();
        const timer = setTimeout(() => {
          this.proc.kill("SIGKILL");
          reject(new Error("audio recorder did not stop within 5 seconds"));
        }, 5_000);
        this.proc.once("close", () => { clearTimeout(timer); resolve(); });
        this.proc.once("error", (error) => { clearTimeout(timer); reject(error); });
      });
      if (!existsSync(this.outputPath)) throw new Error("audio recorder did not create output");
      const stat = statSync(this.outputPath);
      const header = Buffer.alloc(4);
      const stream = createReadStream(this.outputPath, { start: 0, end: 3 });
      let offset = 0;
      for await (const chunk of stream) offset += (chunk as Buffer).copy(header, offset);
      if (stat.size <= 44 || header.toString("ascii") !== "RIFF") throw new Error("audio recorder output is not a valid WAV");
      return { path: this.outputPath, sha256: sha256File(this.outputPath), byteLength: stat.size };
    } catch (error) {
      removeIfPresent(this.outputPath);
      throw error;
    }
  }
}
