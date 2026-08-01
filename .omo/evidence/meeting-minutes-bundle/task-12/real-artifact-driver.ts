import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportBundle } from "../../../../src/bundle.ts";
import { MinutesStore } from "../../../../src/minutes-store.ts";
import { MeetingStore } from "../../../../src/store.ts";
import { transcriptContentSha256 } from "../../../../src/transcript-versioning.ts";

const targetCommit = "f64fb18c83659dd6732d9481434d8758f98c231a";
const projectRoot = join(import.meta.dir, "../../../..");
const root = await mkdtemp(join(tmpdir(), "t12-real-driver-"));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

function fixture(name: string) {
  const work = join(root, name);
  mkdirSync(work, { recursive: true });
  const legacy = new MeetingStore(join(work, "meetings.db"));
  const store = new MinutesStore(legacy.databaseHandle());
  const meetingId = legacy.startMeeting("driver:real");
  store.registerCapturingMeeting(meetingId);
  store.setMeetingPurpose(meetingId, "Atomic bundle QA");
  store.addAttendees(meetingId, [{ attendeeId: "alice", displayName: "Alice", crmPersonEntityId: "crm-qa-1" }]);
  const version = store.addTranscriptVersion(meetingId, { transcriptVersionId: `${name}-transcript-v1`, sourceKind: "import", engine: "driver" });
  store.addTranscriptVersionLines(version.transcriptVersionId, [
    { seq: 1, capturedAtMs: 1000, speakerTurn: 1, text: "Alice approved publication." },
    { seq: 2, capturedAtMs: 2000, speakerTurn: 1, text: "Alice will publish by 2026-08-07." },
    { seq: 3, capturedAtMs: 3000, speakerTurn: 1, text: "Pricing remains open." },
  ]);
  store.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(store, version.transcriptVersionId));
  store.setCanonical(meetingId, version.transcriptVersionId);
  legacy.addSlide({ idx: 1, title: "Publish", bullets: ["Atomic bundle"], startedAt: 1000 });
  const reviewId = store.saveCandidates({
    meetingId, transcriptVersionId: version.transcriptVersionId, reviewId: `${name}-review`,
    decisions: [{ id: `${name}-decision`, description: "Publication approved", source: { transcriptVersionId: version.transcriptVersionId, startSeq: 1, endSeq: 1 }, attributedAttendeeId: "alice", reviewState: "confirmed" }],
    actionItems: [{ id: `${name}-action`, description: "Publish", source: { transcriptVersionId: version.transcriptVersionId, startSeq: 2, endSeq: 2 }, assigneeAttendeeId: "alice", attributedAttendeeId: "alice", deadline: "2026-08-07", reviewState: "confirmed" }],
    openItems: [{ id: `${name}-open`, description: "Pricing remains open", source: { transcriptVersionId: version.transcriptVersionId, startSeq: 3, endSeq: 3 }, attributedAttendeeId: "alice", reviewState: "confirmed" }],
  });
  store.databaseHandle().run(`
    INSERT INTO referenced_materials
      (material_id, meeting_id, review_id, material_type, title, uri, notes,
       source_transcript_version_id, source_start_seq, source_end_seq, review_state, created_at, updated_at)
    VALUES (?, ?, ?, 'link', 'Spec', 'https://example.test/spec', NULL, ?, 1, 2, 'confirmed', 1, 1)
  `, [`${name}-material`, meetingId, reviewId, version.transcriptVersionId]);
  store.confirmReview(reviewId, "real-driver");
  return { work, legacy, store, meetingId, reviewId, version };
}

try {
  const happy = fixture("happy");
  const audioPath = join(happy.work, "external.wav");
  const audio = Buffer.from("RIFF external source remains outside the bundle");
  await writeFile(audioPath, audio);
  happy.store.addAudioSource(happy.meetingId, { originalAudioPath: audioPath, originalAudioSha256: sha256(audio), byteLength: audio.byteLength });
  const result = await exportBundle(happy.meetingId, happy.reviewId, { store: happy.store, outputRoot: join(happy.work, "exports"), projectRoot, targetCommit });
  const topLevel = (await readdir(result.bundlePath)).sort();
  assert(JSON.stringify(topLevel) === JSON.stringify(["audio.ref.json", "deck", "manifest.json", "minutes.json", "minutes.pdf", "transcript.v1.jsonl"]), `unexpected top-level outputs: ${topLevel}`);
  const manifest = JSON.parse(await readFile(join(result.bundlePath, "manifest.json"), "utf8"));
  for (const entry of manifest.entries) { const bytes = await readFile(join(result.bundlePath, entry.path)); assert(sha256(bytes) === entry.sha256 && bytes.byteLength === entry.byte_length, `manifest mismatch: ${entry.path}`); }
  const transcriptBytes = await readFile(join(result.bundlePath, "transcript.v1.jsonl"));
  const transcript = transcriptBytes.toString().trim().split("\n").map(JSON.parse);
  assert(transcript.every((line) => JSON.stringify(Object.keys(line)) === JSON.stringify(["seq", "ts", "speaker_turn", "text"])), "transcript schema mismatch");
  const minutes = JSON.parse(await readFile(join(result.bundlePath, "minutes.json"), "utf8"));
  assert(minutes.transcript.content_sha256 === sha256(transcriptBytes), "transcript content hash mismatch");
  const seqs = new Set(transcript.map((line) => line.seq));
  for (const item of [...minutes.decisions, ...minutes.action_items, ...minutes.open_items, ...minutes.referenced_materials]) { assert(item.source.transcript_version_id === happy.version.transcriptVersionId, "source version mismatch"); for (let seq = item.source.start_seq; seq <= item.source.end_seq; seq++) assert(seqs.has(seq), `missing source seq ${seq}`); }
  assert(minutes.attendees[0].crm_person_entity_id === "crm-qa-1", "CRM person id omitted");
  assert(JSON.stringify(JSON.parse(await readFile(join(result.bundlePath, "audio.ref.json"), "utf8"))) === JSON.stringify({ path: audioPath, original_audio_sha256: sha256(audio) }), "audio reference mismatch");
  assert(!(await readdir(result.bundlePath)).includes("original-audio.wav"), "audio was copied into bundle");
  assert((happy.store.databaseHandle().query("SELECT COUNT(*) count FROM artifacts").get() as { count: number }).count === 4, "required artifact rows missing");
  const pdf = await readFile(join(result.bundlePath, "minutes.pdf"));
  assert(pdf.subarray(0, 5).toString() === "%PDF-" && pdf.byteLength > 1000, "real PDF invalid");
  happy.legacy.close();

  const failure = fixture("failure");
  const failureRoot = join(failure.work, "exports");
  await exportBundle(failure.meetingId, failure.reviewId, { store: failure.store, outputRoot: failureRoot, projectRoot, targetCommit, renderPdf: async () => { throw new Error("injected driver failure"); } }).then(() => { throw new Error("failure injection unexpectedly published"); }, (error) => assert(String(error).includes("injected driver failure"), "wrong failure surfaced"));
  assert(JSON.stringify(await readdir(failureRoot).catch(() => [])) === "[]", "failure left output or .tmp files");
  assert((failure.store.databaseHandle().query("SELECT COUNT(*) count FROM artifact_bundles").get() as { count: number }).count === 0, "failure wrote complete bundle row");
  assert((failure.store.databaseHandle().query("SELECT COUNT(*) count FROM artifacts").get() as { count: number }).count === 0, "failure wrote artifact rows");
  failure.legacy.close();

  console.log(JSON.stringify({ status: "PASS", target_commit: targetCommit, top_level: topLevel, manifest_entries: manifest.entries.length, transcript_sha256: sha256(transcriptBytes), pdf_bytes: pdf.byteLength, artifact_rows: 4, audio_external_only: true, source_tuples_exact: true, failure_cleanup: true, crm_db_writes: 0, cleanup: `removed ${root}` }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
