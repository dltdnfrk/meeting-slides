import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deleteMeetingHistory } from "../src/meeting-deletion.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";
import { claimFileAudioSource, transcriptContentSha256, TranscriptVersionWriter } from "../src/transcript-versioning.ts";
import { runSlidePlanServerAction } from "../src/slides/server-action.ts";
import { bounded, connectMeetingServer, deferred, startMeetingServer } from "./helpers/meeting-server.ts";

function snapshot(database: Database) {
  const tables = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [name, database.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

function assertImmutable(minutes: MinutesStore, transcriptVersionId: string) {
  const before = minutes.transcriptVersionLines(transcriptVersionId);
  expect(before.length).toBeGreaterThan(0);
  for (const sql of [
    "UPDATE transcript_version_lines SET text = 'TAMPER_SENTINEL' WHERE transcript_version_id = ?",
    "DELETE FROM transcript_version_lines WHERE transcript_version_id = ?",
  ]) {
    expect(() => minutes.databaseHandle().run(sql, [transcriptVersionId])).toThrow(/finalized transcript lines are immutable/);
  }
  expect(minutes.transcriptVersionLines(transcriptVersionId)).toEqual(before);
}

function canonicalMeeting(store: MeetingStore, directory: string, name: string) {
  const minutes = new MinutesStore(store.databaseHandle());
  const meetingId = store.startMeeting("deletion-fixture");
  minutes.registerCapturingMeeting(meetingId);
  minutes.addAttendees(meetingId, [{ attendeeId: "owner", displayName: "Owner" }]);
  const writer = new TranscriptVersionWriter(minutes);
  writer.begin(meetingId, { sourceKind: "live_capture", dualWriteLegacy: true });
  writer.append({ ts: 1000, speaker: 1, text: `${name}: The beta launches Friday.` });
  const canonical = writer.finalize({ selectCanonical: true });
  writer.begin(meetingId, { sourceKind: "retranscription" });
  writer.append({ ts: 1000, text: `${name}: Alternate finalized transcript.` });
  writer.finalize();
  writer.begin(meetingId, { sourceKind: "retranscription" });
  writer.append({ ts: 1000, text: `${name}: Interrupted retranscription.` });
  writer.abort();
  store.addSlide({ idx: 1, title: name, bullets: ["Friday launch"], startedAt: 1000 });
  const audioPath = join(directory, `${name}-original.wav`);
  writeFileSync(audioPath, `${name}: ORIGINAL_AUDIO_SENTINEL`);
  claimFileAudioSource(minutes, meetingId, audioPath);
  const source = { transcriptVersionId: canonical.transcriptVersionId, startSeq: 1, endSeq: 1 };
  const item = { description: "Friday launch", source, attributedAttendeeId: "owner", reviewState: "confirmed" as const };
  const reviewId = minutes.saveCandidates({
    meetingId, transcriptVersionId: canonical.transcriptVersionId,
    decisions: [item], actionItems: [{ ...item, assigneeAttendeeId: "owner", deadline: "2026-09-11" }],
    openItems: [item],
    summary: { overview: "Friday launch", topics: [] },
  });
  const database = store.databaseHandle();
  database.run(`INSERT INTO referenced_materials
    (material_id, meeting_id, review_id, material_type, title, source_transcript_version_id,
     source_start_seq, source_end_seq, review_state, created_at, updated_at)
    VALUES (?, ?, ?, 'document', 'Launch notes', ?, 1, 1, 'confirmed', 1000, 1000)`,
    [`${name}-material`, meetingId, reviewId, canonical.transcriptVersionId]);
  minutes.confirmReview(reviewId, "owner");
  database.run("INSERT INTO transcript_line_attributions VALUES (?, ?, 1, 'owner', 1000)", [meetingId, canonical.transcriptVersionId]);
  // Exercise the full durable FK graph; these rows are metadata fixtures, not published files.
  const bundleId = `${name}-bundle`;
  database.run("INSERT INTO artifact_bundles VALUES (?, ?, ?, ?, ?, 'complete', 1000, 1000)",
    [bundleId, meetingId, reviewId, canonical.transcriptVersionId, join(directory, bundleId)]);
  database.run("INSERT INTO artifacts VALUES (?, ?, 'canonical_transcript', 'transcript.jsonl', 'application/x-ndjson', ?, 1, 1000)",
    [`${name}-artifact`, bundleId, canonical.contentSha256]);
  database.run("INSERT INTO meeting_conclusions VALUES (?, ?, ?, ?, ?, ?, ?, 1000)",
    [meetingId, reviewId, canonical.transcriptVersionId, bundleId, join(directory, bundleId), "a".repeat(64), "b".repeat(40)]);
  store.endMeeting();
  minutes.endMeeting(meetingId);
  expect(minutes.canonicalVersion(meetingId)?.contentSha256).toBe(transcriptContentSha256(minutes, canonical.transcriptVersionId));
  expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  return { meetingId, ...canonical, audioPath };
}

for (const kind of ["missing", "prepared", "unfinished", "empty-finalized", "finalized", "canonical"] as const) {
  test(`deletion supports ${kind} history`, () => {
    const store = new MeetingStore(":memory:");
    try {
      const minutes = new MinutesStore(store.databaseHandle());
      const meetingId = kind === "missing" ? 999 : minutes.ensurePreparedMeeting("fixture", null);
      if (kind !== "missing" && kind !== "prepared") {
        const version = minutes.addTranscriptVersion(meetingId, { sourceKind: "import" });
        if (kind !== "empty-finalized") minutes.addTranscriptVersionLines(version.transcriptVersionId, [{ seq: 1, text: "DELETE_SENTINEL" }]);
        if (kind !== "unfinished") minutes.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(minutes, version.transcriptVersionId));
        if (kind === "canonical") minutes.setCanonical(meetingId, version.transcriptVersionId);
        minutes.endMeeting(meetingId);
        store.activateMeeting(meetingId); store.endMeeting();
      }
      expect(deleteMeetingHistory(store.databaseHandle(), meetingId)).toBe(kind !== "missing");
      expect(Object.values(snapshot(store.databaseHandle())).flat()).toEqual([]);
      expect(store.databaseHandle().query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { store.close(); }
  });
}

for (const reopen of [false, true]) {
  test(`canonical deletion preserves other history and original audio on ${reopen ? "reopened" : "fresh"} SQLite`, () => {
    const directory = mkdtempSync(join(tmpdir(), "canonical-deletion-"));
    const path = join(directory, "meetings.db");
    let store = new MeetingStore(path);
    try {
      const kept = canonicalMeeting(store, directory, "kept");
      const keptBefore = snapshot(store.databaseHandle());
      const removed = canonicalMeeting(store, directory, "removed");
      const before = snapshot(store.databaseHandle());
      const triggers = store.databaseHandle().query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
      if (reopen) { store.close(); store = new MeetingStore(path); }
      const minutes = new MinutesStore(store.databaseHandle());
      const database = store.databaseHandle();
      expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      assertImmutable(minutes, removed.transcriptVersionId);
      assertImmutable(minutes, kept.transcriptVersionId);
      expect(deleteMeetingHistory(database, removed.meetingId)).toBe(true);
      expect(deleteMeetingHistory(database, removed.meetingId)).toBe(false);
      expect(snapshot(database)).toEqual(keptBefore);
      assertImmutable(minutes, kept.transcriptVersionId);
      expect(transcriptContentSha256(minutes, kept.transcriptVersionId)).toBe(kept.contentSha256);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(database.query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).toEqual(triggers);
      expect(readFileSync(removed.audioPath, "utf8")).toBe("removed: ORIGINAL_AUDIO_SENTINEL");
      expect(readFileSync(kept.audioPath, "utf8")).toBe("kept: ORIGINAL_AUDIO_SENTINEL");
      const evidence = process.env.MEETING_DELETION_EVIDENCE_ROOT;
      if (evidence) writeFileSync(join(evidence, `${reopen ? "reopened" : "fresh"}-snapshots.json`), JSON.stringify({ directory, before, after: snapshot(database), triggers }, null, 2));
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

test("a late deletion failure rolls back canonical lines, reviews, artifacts, and meeting state", () => {
  const directory = mkdtempSync(join(tmpdir(), "deletion-rollback-"));
  const store = new MeetingStore(join(directory, "meetings.db"));
  try {
    const removed = canonicalMeeting(store, directory, "rollback");
    canonicalMeeting(store, directory, "kept");
    const database = store.databaseHandle();
    const before = snapshot(database);
    database.run(`CREATE TRIGGER deletion_failure BEFORE DELETE ON meetings
      WHEN OLD.id = ${removed.meetingId} BEGIN SELECT RAISE(ABORT, 'LATE_DELETE_SENTINEL'); END`);
    expect(() => deleteMeetingHistory(database, removed.meetingId)).toThrow(/LATE_DELETE_SENTINEL/);
    expect(snapshot(database)).toEqual(before);
    assertImmutable(new MinutesStore(database), removed.transcriptVersionId);
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("production WS canonical deletion honors artifact ownership and preserves another canonical meeting", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ws-canonical-deletion-"));
  const databasePath = join(directory, "meetings.db");
  const release = deferred<void>();
  const entered = deferred<void>();
  const running = startMeetingServer({
    ...process.env, MEETINGS_DB_PATH: databasePath, MEETING_SLIDES_SETTINGS_ROOT: directory,
    LLM_PROVIDER: "cli", LLM_CLI_BIN: "/usr/bin/false", LLM_CLI_PRESET: "claude", WHISPER_INPUT_MODE: "mic",
  }, {
    paths: {
      projectRoot: join(import.meta.dir, ".."), databasePath, settingsRoot: directory,
      modelsRoot: join(directory, "models"), exportRoot: join(directory, "exports"),
      bundleOutputRoot: join(directory, "bundles"), bundleTargetCommit: "b".repeat(40),
      envPath: join(directory, ".env"),
    },
    detector: {
      async ping() { return true; },
      async detectBlock() { return { shouldAdvance: false, title: "", bullets: [] }; },
      async planDeck() { throw new Error("UNEXPECTED_DECK_SENTINEL"); },
      async chat() { throw new Error("OWNED_JOB_SETTLED_SENTINEL"); },
    },
    runSlidePlan: async input => { entered.resolve(); await release.promise; return runSlidePlanServerAction(input); },
  });
  const store = new MeetingStore(databasePath);
  try {
    const kept = canonicalMeeting(store, directory, "ws-kept");
    const keptBefore = snapshot(store.databaseHandle());
    const removed = canonicalMeeting(store, directory, "ws-removed");
    const minutes = new MinutesStore(store.databaseHandle());
    const before = snapshot(store.databaseHandle());
    assertImmutable(minutes, removed.transcriptVersionId);
    const client = await connectMeetingServer(running.server.port!);
    const selectedBefore = await client.send({ action: "selectMeeting", meetingId: kept.meetingId }, message => message.type === "meeting");
    const terminal = client.next(message => message.type === "compile" && message.status === "error");
    await client.send({ action: "compileSlidePlan", meetingId: removed.meetingId }, message => message.type === "compile" && message.status === "started");
    await bounded(entered.promise, "artifact owner entered");
    await client.send({ action: "deleteMeeting", meetingId: removed.meetingId }, message => message.type === "status");
    expect(snapshot(store.databaseHandle())).toEqual(before);
    expect(await client.send({ action: "exportPdf", meetingId: removed.meetingId }, message => message.type === "export")).toMatchObject({ status: "error", code: "job-busy" });
    const unrelated = minutes.ensurePreparedMeeting("unrelated-job-fixture", null);
    await client.send({ action: "deleteMeeting", meetingId: unrelated }, message => message.type === "status");
    expect(store.meeting(unrelated)).toBeNull();
    release.resolve(); await terminal;
    await client.send({ action: "deleteMeeting", meetingId: removed.meetingId }, message => message.type === "status");
    const listed = await client.send({ action: "listMeetings" }, message => message.type === "meetings");
    expect(listed.items).toEqual(store.listMeetings());
    expect(store.listMeetings().map(meeting => meeting.id)).toEqual([kept.meetingId]);
    const selectedAfter = await client.send({ action: "selectMeeting", meetingId: kept.meetingId }, message => message.type === "meeting");
    expect(selectedAfter).toEqual(selectedBefore);
    expect(snapshot(store.databaseHandle())).toEqual(keptBefore);
    assertImmutable(minutes, kept.transcriptVersionId);
    expect(transcriptContentSha256(minutes, kept.transcriptVersionId)).toBe(kept.contentSha256);
    expect(store.databaseHandle().query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(readFileSync(removed.audioPath, "utf8")).toBe("ws-removed: ORIGINAL_AUDIO_SENTINEL");
    expect(readFileSync(kept.audioPath, "utf8")).toBe("ws-kept: ORIGINAL_AUDIO_SENTINEL");
    const evidence = process.env.MEETING_DELETION_EVIDENCE_ROOT;
    if (evidence) writeFileSync(join(evidence, "ws-snapshots.json"), JSON.stringify({ pid: process.pid, directory, port: running.server.port, before, after: snapshot(store.databaseHandle()), selectedBefore, selectedAfter, messages: client.messages }, null, 2));
    const closed = bounded(new Promise<void>(resolve => client.socket.addEventListener("close", () => resolve(), { once: true })), "WS close");
    await running.close(); await closed;
    expect(client.socket.readyState).toBe(WebSocket.CLOSED);
  } finally {
    release.resolve(); await running.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
