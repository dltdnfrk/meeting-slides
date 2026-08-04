import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";
import {
  CaptureFinalizer,
  RawAudioRecorder,
  TranscriptVersionWriter,
  canonicalTranscriptJsonl,
  claimFileAudioSource,
  sha256File,
  snapshotLegacyTranscript,
} from "../src/transcript-versioning.ts";

function stores(): { legacy: MeetingStore; minutes: MinutesStore; meetingId: number } {
  const legacy = new MeetingStore(":memory:");
  const minutes = new MinutesStore(legacy.databaseHandle());
  const meetingId = legacy.startMeeting("cli:test");
  minutes.registerCapturingMeeting(meetingId);
  return { legacy, minutes, meetingId };
}

describe("canonical transcript versioning", () => {
  test("live capture dual-writes, finalizes a content hash, and makes canonical lines immutable", () => {
    const { legacy, minutes, meetingId } = stores();
    const writer = new TranscriptVersionWriter(minutes);
    const version = writer.begin(meetingId, { sourceKind: "live_capture", engine: "whisper.cpp", dualWriteLegacy: true });
    writer.append({ ts: 1000, speaker: 1, text: "First canonical line" });
    writer.append({ ts: 2000, text: "Second canonical line" });
    const finalized = writer.finalize({ selectCanonical: true });

    expect(finalized.transcriptVersionId).toBe(version.transcriptVersionId);
    expect(finalized.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(minutes.canonicalVersion(meetingId)).toMatchObject({ transcriptVersionId: version.transcriptVersionId, contentSha256: finalized.contentSha256 });
    expect(legacy.lines(meetingId).map(({ seq, text }) => ({ seq, text }))).toEqual([
      { seq: 1, text: "First canonical line" },
      { seq: 2, text: "Second canonical line" },
    ]);
    expect(minutes.transcriptVersionLines(version.transcriptVersionId).map(({ seq, text }) => ({ seq, text }))).toEqual([
      { seq: 1, text: "First canonical line" },
      { seq: 2, text: "Second canonical line" },
    ]);
    const canonicalLines = canonicalTranscriptJsonl(minutes, version.transcriptVersionId)
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(canonicalLines.map(Object.keys)).toEqual([
      ["seq", "ts", "speaker_turn", "text"],
      ["seq", "ts", "speaker_turn", "text"],
    ]);
    expect(canonicalLines).toEqual([
      { seq: 1, ts: 1000, speaker_turn: 1, text: "First canonical line" },
      { seq: 2, ts: 2000, speaker_turn: null, text: "Second canonical line" },
    ]);
    expect(() => minutes.databaseHandle().run(
      "UPDATE transcript_version_lines SET text = 'tampered' WHERE transcript_version_id = ? AND seq = 1",
      [version.transcriptVersionId],
    )).toThrow(/finalized transcript lines are immutable/);
    expect(() => minutes.databaseHandle().run(
      "DELETE FROM transcript_version_lines WHERE transcript_version_id = ? AND seq = 1",
      [version.transcriptVersionId],
    )).toThrow(/finalized transcript lines are immutable/);
    legacy.close();
  });

  test("retranscription creates a new immutable coordinate space without changing canonical automatically", () => {
    const { legacy, minutes, meetingId } = stores();
    const writer = new TranscriptVersionWriter(minutes);
    const v1 = writer.begin(meetingId, { sourceKind: "live_capture", dualWriteLegacy: true });
    writer.append({ ts: 1, text: "Original wording" });
    writer.finalize({ selectCanonical: true });
    const reviewId = minutes.saveCandidates({
      meetingId,
      transcriptVersionId: v1.transcriptVersionId,
      decisions: [{ description: "Original decision", source: { transcriptVersionId: v1.transcriptVersionId, startSeq: 1, endSeq: 1 } }],
    });

    const v2 = writer.begin(meetingId, { sourceKind: "retranscription" });
    writer.append({ ts: 2, text: "Corrected wording" });
    writer.finalize();
    expect(v2.versionNo).toBe(2);
    expect(minutes.canonicalVersion(meetingId)?.transcriptVersionId).toBe(v1.transcriptVersionId);
    expect(legacy.lines(meetingId)).toHaveLength(1);
    expect(minutes.itemsForReview(reviewId)[0]?.source).toEqual({ transcriptVersionId: v1.transcriptVersionId, startSeq: 1, endSeq: 1 });
    expect(minutes.transcriptVersionLines(v1.transcriptVersionId)[0]?.text).toBe("Original wording");
    expect(minutes.transcriptVersionLines(v2.transcriptVersionId)[0]?.text).toBe("Corrected wording");

    minutes.setCanonical(meetingId, v2.transcriptVersionId);
    expect(minutes.canonicalVersion(meetingId)?.transcriptVersionId).toBe(v2.transcriptVersionId);
    expect(minutes.itemsForReview(reviewId)[0]?.source).toEqual({ transcriptVersionId: v1.transcriptVersionId, startSeq: 1, endSeq: 1 });
    legacy.close();
  });

  test("an interrupted retranscription leaves the previous canonical version intact", () => {
    const { legacy, minutes, meetingId } = stores();
    const writer = new TranscriptVersionWriter(minutes);
    const v1 = writer.begin(meetingId, { sourceKind: "live_capture", dualWriteLegacy: true });
    writer.append({ ts: 1, text: "Stable line" });
    writer.finalize({ selectCanonical: true });
    const v2 = writer.begin(meetingId, { sourceKind: "retranscription" });
    writer.append({ ts: 2, text: "Partial line" });
    writer.abort();

    expect(minutes.canonicalVersion(meetingId)?.transcriptVersionId).toBe(v1.transcriptVersionId);
    expect(minutes.latestVersion(meetingId)).toMatchObject({ transcriptVersionId: v2.transcriptVersionId, finalizedAt: null });
    expect(minutes.transcriptVersionLines(v1.transcriptVersionId).map((line) => line.text)).toEqual(["Stable line"]);
    legacy.close();
  });

  test("legacy snapshot rejects duplicate coordinates instead of guessing", () => {
    const { legacy, minutes, meetingId } = stores();
    legacy.addLine({ ts: 1, text: "one" });
    minutes.databaseHandle().run(
      "INSERT INTO transcript_lines (meeting_id, seq, ts, speaker, text) VALUES (?, 1, 2, NULL, 'duplicate')",
      [meetingId],
    );
    expect(() => snapshotLegacyTranscript(minutes, meetingId)).toThrow(/duplicate legacy transcript seq/);
    expect(minutes.latestVersion(meetingId)).toBeNull();
    legacy.close();
  });
});

describe("raw audio hash and recorder contract", () => {
  test("file audio claims reject same bytes without duplicate persistence and allow different bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "meeting-audio-hash-"));
    const audio = join(dir, "sample.wav");
    writeFileSync(audio, "same source bytes");
    const { legacy, minutes, meetingId } = stores();
    const first = claimFileAudioSource(minutes, meetingId, audio);
    const secondMeetingId = legacy.startMeeting("cli:test");
    minutes.registerCapturingMeeting(secondMeetingId);
    const duplicate = claimFileAudioSource(minutes, secondMeetingId, audio);
    const differentAudio = join(dir, "different.wav");
    writeFileSync(differentAudio, "different source bytes");
    const thirdMeetingId = legacy.startMeeting("cli:test");
    minutes.registerCapturingMeeting(thirdMeetingId);
    const different = claimFileAudioSource(minutes, thirdMeetingId, differentAudio);

    expect(first).toEqual({ duplicateMeetingId: null, sha256: sha256File(audio), byteLength: 17 });
    expect(duplicate).toEqual({ duplicateMeetingId: meetingId, sha256: first.sha256, byteLength: 17 });
    expect(different).toEqual({ duplicateMeetingId: null, sha256: sha256File(differentAudio), byteLength: 22 });
    expect(minutes.findMeetingByAudioHash(first.sha256)).toBe(meetingId);
    expect(minutes.databaseHandle().query("SELECT COUNT(*) AS count FROM meeting_audio_sources").get()).toEqual({ count: 2 });
    legacy.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("capture finalization stops the recorder exactly once on success and failure", async () => {
    const successful = stores();
    const successWriter = new TranscriptVersionWriter(successful.minutes);
    successWriter.begin(successful.meetingId, { sourceKind: "live_capture" });
    successWriter.append({ ts: 1, text: "saved" });
    let successStops = 0;
    const successPath = "/configured/raw-success.wav";
    const successHash = "a".repeat(64);
    const successFinalizer = new CaptureFinalizer(successful.minutes, successWriter, successful.meetingId, {
      stop: async () => { successStops++; return { path: successPath, sha256: successHash, byteLength: 51 }; },
    });
    const success = successFinalizer.finish();
    expect(await success).toMatchObject({
      transcriptVersionId: expect.any(String),
      audio: { status: "available", path: successPath, sha256: successHash, byteLength: 51 },
    });
    expect(await successFinalizer.finish()).toEqual(await success);
    expect(successStops).toBe(1);
    expect(successful.minutes.databaseHandle().query("SELECT original_audio_path, original_audio_sha256, byte_length FROM meeting_audio_sources").get()).toEqual({
      original_audio_path: successPath, original_audio_sha256: successHash, byte_length: 51,
    });
    successful.legacy.close();

    const failed = stores();
    const failedWriter = new TranscriptVersionWriter(failed.minutes);
    const version = failedWriter.begin(failed.meetingId, { sourceKind: "live_capture" });
    failedWriter.append({ ts: 1, text: "still finalized" });
    let failedStops = 0;
    const failure = await new CaptureFinalizer(failed.minutes, failedWriter, failed.meetingId, {
      stop: async () => { failedStops++; throw new Error("recorder close failed"); },
    }).finish();
    expect(failure.audio).toEqual({ status: "unavailable", reason: "recorder_failed" });
    expect(failedStops).toBe(1);
    expect(failed.minutes.canonicalVersion(failed.meetingId)?.transcriptVersionId).toBe(version.transcriptVersionId);
    expect(failed.minutes.databaseHandle().query("SELECT COUNT(*) AS count FROM meeting_audio_sources").get()).toEqual({ count: 0 });
    failed.legacy.close();
  });

  test("recorder startup timeout terminates and awaits the child exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meeting-recorder-startup-"));
    const fake = join(dir, "ffmpeg-timeout");
    const output = join(dir, "capture.tmp.wav");
    const signals = join(dir, "signals.txt");
    writeFileSync(fake, `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nprocess.on("SIGTERM", () => { appendFileSync(${JSON.stringify(signals)}, "TERM\\n"); process.exit(0); });\nawait new Promise(() => {});\n`);
    chmodSync(fake, 0o755);

    await expect(RawAudioRecorder.start({
      bin: fake, captureId: 3, outputPath: output, startupTimeoutMs: 500,
    })).rejects.toThrow(/did not create output/);
    expect(readFileSync(signals, "utf8").trim().split("\n")).toEqual(["TERM"]);
    expect(existsSync(output)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("recorder waits for closure, hashes a valid WAV, and removes failed partial output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meeting-recorder-"));
    const fake = join(dir, "ffmpeg");
    const output = join(dir, "capture.tmp.wav");
    writeFileSync(fake, `#!/usr/bin/env bun\nconst out = process.argv.at(-1);\nawait Bun.write(out, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40), Buffer.from('pcm')]));\nprocess.on('SIGTERM', () => process.exit(0));\nawait new Promise(() => {});\n`);
    chmodSync(fake, 0o755);
    const recorder = await RawAudioRecorder.start({ bin: fake, captureId: 3, outputPath: output });
    const result = await recorder.stop();
    expect(result).toEqual({ path: output, sha256: sha256File(output), byteLength: 47 });
    expect(readFileSync(output).subarray(0, 4).toString()).toBe("RIFF");

    const failedFake = join(dir, "failed-ffmpeg");
    const failedOutput = join(dir, "failed.tmp.wav");
    writeFileSync(failedFake, `#!/usr/bin/env bun\nawait Bun.write(process.argv.at(-1), 'partial');\nprocess.on('SIGTERM', () => process.exit(0));\nawait new Promise(() => {});\n`);
    chmodSync(failedFake, 0o755);
    const failed = await RawAudioRecorder.start({ bin: failedFake, captureId: -1, outputPath: failedOutput });
    await expect(failed.stop()).rejects.toThrow(/valid WAV/);
    expect(existsSync(failedOutput)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
