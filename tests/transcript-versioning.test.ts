import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";
import {
  RawAudioRecorder,
  TranscriptVersionWriter,
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
  test("file audio claims are hash-deduplicated and preserve the first meeting on unique collision", () => {
    const dir = mkdtempSync(join(tmpdir(), "meeting-audio-hash-"));
    const audio = join(dir, "sample.wav");
    writeFileSync(audio, "same source bytes");
    const { legacy, minutes, meetingId } = stores();
    const first = claimFileAudioSource(minutes, meetingId, audio);
    const secondMeetingId = legacy.startMeeting("cli:test");
    minutes.registerCapturingMeeting(secondMeetingId);
    const duplicate = claimFileAudioSource(minutes, secondMeetingId, audio);

    expect(first).toEqual({ duplicateMeetingId: null, sha256: sha256File(audio), byteLength: 17 });
    expect(duplicate).toEqual({ duplicateMeetingId: meetingId, sha256: first.sha256, byteLength: 17 });
    expect(minutes.findMeetingByAudioHash(first.sha256)).toBe(meetingId);
    expect(minutes.databaseHandle().query("SELECT COUNT(*) AS count FROM meeting_audio_sources").get()).toEqual({ count: 1 });
    legacy.close();
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
