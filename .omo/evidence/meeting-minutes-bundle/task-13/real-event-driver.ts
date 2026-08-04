import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinutesStore } from "../../../../src/minutes-store.ts";
import { MeetingStore } from "../../../../src/store.ts";
import { CaptureFinalizer, RawAudioRecorder, TranscriptVersionWriter, canonicalTranscriptJsonl, sha256File } from "../../../../src/transcript-versioning.ts";

const dir = mkdtempSync(join(tmpdir(), "t13-real-driver-"));
const fake = join(dir, "ffmpeg");
const audioPath = join(dir, "configured-raw.tmp.wav");
writeFileSync(fake, `#!/usr/bin/env bun\nconst out=process.argv.at(-1);await Bun.write(out,Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(40),Buffer.from('deterministic-pcm')]));process.on('SIGTERM',()=>process.exit(0));await new Promise(()=>{});\n`);
chmodSync(fake, 0o755);
const legacy = new MeetingStore(":memory:");
const store = new MinutesStore(legacy.databaseHandle());
try {
  const meetingId = legacy.startMeeting("driver");
  store.registerCapturingMeeting(meetingId);
  const events: string[] = [];
  events.push("recorder:start");
  const recorder = await RawAudioRecorder.start({ bin: fake, captureId: 4, outputPath: audioPath });
  events.push("capture:start");
  const writer = new TranscriptVersionWriter(store);
  const v1 = writer.begin(meetingId, { sourceKind: "live_capture", dualWriteLegacy: true });
  writer.append({ ts: 100, speaker: 1, text: "decision alpha" });
  writer.append({ ts: 200, speaker: 2, text: "action beta" });
  const finalized = await new CaptureFinalizer(store, writer, meetingId, recorder).finish();
  const v2 = writer.begin(meetingId, { sourceKind: "retranscription" });
  writer.append({ ts: 300, speaker: 1, text: "decision alpha corrected" });
  writer.finalize();

  const duplicateMeetingId = legacy.startMeeting("driver");
  store.registerCapturingMeeting(duplicateMeetingId);
  const duplicateWriter = new TranscriptVersionWriter(store);
  duplicateWriter.begin(duplicateMeetingId, { sourceKind: "file_transcription" });
  duplicateWriter.append({ ts: 100, text: "duplicate rejected" });
  let dedupFailure = "none";
  try {
    await new CaptureFinalizer(store, duplicateWriter, duplicateMeetingId, {
      stop: async () => ({ path: audioPath, sha256: sha256File(audioPath), byteLength: readFileSync(audioPath).byteLength }),
    }).finish();
  } catch (error) {
    dedupFailure = error instanceof Error ? error.message : String(error);
  }

  const rows = store.databaseHandle().query("SELECT meeting_id, original_audio_path, original_audio_sha256, byte_length FROM meeting_audio_sources ORDER BY meeting_id").all();
  console.log(JSON.stringify({
    events,
    audio: { exists: existsSync(audioPath), path: finalized.audio.status === "available" ? finalized.audio.path : null, sha256: sha256File(audioPath), byteLength: readFileSync(audioPath).byteLength },
    versions: { v1, v2, latest: store.latestVersion(meetingId), canonical: store.canonicalVersion(meetingId), v1Lines: canonicalTranscriptJsonl(store, v1.transcriptVersionId).trim().split("\n").map(JSON.parse), v2Lines: canonicalTranscriptJsonl(store, v2.transcriptVersionId).trim().split("\n").map(JSON.parse) },
    dedupFailure,
    audioRows: rows,
  }, null, 2));
} finally {
  legacy.close();
  rmSync(dir, { recursive: true, force: true });
}
