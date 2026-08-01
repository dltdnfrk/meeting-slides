import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { exportBundle, type BundleManifest } from "../src/bundle.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";

const roots: string[] = [];
const targetCommit = "f64fb18c83659dd6732d9481434d8758f98c231a";
const fakePdf = new TextEncoder().encode("%PDF-1.7\nmeeting minutes fixture\n%%EOF\n");

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(reviewId = "review-v1") {
  const root = mkdtempSync(join(tmpdir(), "meeting-bundle-test-"));
  roots.push(root);
  const legacy = new MeetingStore(join(root, "meetings.db"));
  const store = new MinutesStore(legacy.databaseHandle());
  const meetingId = legacy.startMeeting("cli:test");
  store.registerCapturingMeeting(meetingId);
  store.setMeetingPurpose(meetingId, "CRM handoff");
  store.addAttendees(meetingId, [
    { attendeeId: "alice", displayName: "Alice", crmPersonEntityId: "crm-person-1", sortOrder: 0 },
    { attendeeId: "bob", displayName: "Bob", sortOrder: 1 },
  ]);
  const version = store.addTranscriptVersion(meetingId, {
    transcriptVersionId: "transcript-version-v1",
    sourceKind: "import",
    engine: "fixture",
    engineModel: "exact-v1",
  });
  store.addTranscriptVersionLines(version.transcriptVersionId, [
    { seq: 1, capturedAtMs: 1_786_000_000_000, speakerTurn: 1, text: "Alice will ship the CRM bundle." },
    { seq: 2, capturedAtMs: 1_786_000_001_000, speakerTurn: 2, text: "Bob approved launch." },
    { seq: 3, capturedAtMs: 1_786_000_002_000, speakerTurn: null, text: "Pricing remains open." },
  ]);
  store.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(store, version.transcriptVersionId));
  store.setCanonical(meetingId, version.transcriptVersionId);
  legacy.addSlide({ idx: 1, title: "Roadmap", bullets: ["Ship the CRM bundle"], startedAt: 1_786_000_000_000 });

  const savedReviewId = store.saveCandidates({
    meetingId,
    transcriptVersionId: version.transcriptVersionId,
    reviewId,
    decisions: [{ id: "decision-1", description: "Launch approved", source: { transcriptVersionId: version.transcriptVersionId, startSeq: 2, endSeq: 2 } }],
    actionItems: [{ id: "action-1", description: "Ship CRM bundle", source: { transcriptVersionId: version.transcriptVersionId, startSeq: 1, endSeq: 1 } }],
    openItems: [{ id: "open-1", description: "Pricing remains open", source: { transcriptVersionId: version.transcriptVersionId, startSeq: 3, endSeq: 3 } }],
  });
  store.databaseHandle().run(`
    INSERT INTO referenced_materials
      (material_id, meeting_id, review_id, material_type, title, uri, notes,
       source_transcript_version_id, source_start_seq, source_end_seq, review_state, created_at, updated_at)
    VALUES ('material-1', ?, ?, 'link', 'CRM spec', 'https://example.test/spec', NULL, ?, 1, 2, 'confirmed', 1, 1)
  `, [meetingId, savedReviewId, version.transcriptVersionId]);
  store.updateItem(savedReviewId, "decision", "decision-1", { attributedAttendeeId: "bob", reviewState: "confirmed" });
  store.updateItem(savedReviewId, "action_item", "action-1", {
    assigneeAttendeeId: "alice", attributedAttendeeId: "alice", deadline: "2026-08-07", deadlineText: "by August 7", reviewState: "confirmed",
  });
  store.updateItem(savedReviewId, "open_item", "open-1", { attributedAttendeeId: "bob", reviewState: "confirmed" });

  return { root, outputRoot: join(root, "exports"), legacy, store, meetingId, reviewId: savedReviewId, version };
}

async function run(
  fx: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof exportBundle>[2]> = {},
) {
  return exportBundle(fx.meetingId, fx.reviewId, {
    store: fx.store,
    outputRoot: fx.outputRoot,
    projectRoot: join(import.meta.dir, ".."),
    targetCommit,
    renderPdf: async () => fakePdf,
    ...overrides,
  });
}

function outputNames(root: string): string[] {
  return existsSync(root) ? readdirSync(root).sort() : [];
}

afterEach(() => {
  for (const root of roots.splice(0)) Bun.spawnSync(["rm", "-rf", root]);
});

describe("exportBundle", () => {
  test("publishes six logical outputs atomically and records four required artifacts only after validation", async () => {
    const fx = fixture();
    const externalAudio = join(fx.root, "external-source.wav");
    await Bun.write(externalAudio, "RIFF external audio stays outside the bundle");
    const audioBytes = readFileSync(externalAudio);
    fx.store.addAudioSource(fx.meetingId, {
      originalAudioPath: externalAudio,
      originalAudioSha256: sha256(audioBytes),
      byteLength: audioBytes.byteLength,
    });
    fx.store.confirmReview(fx.reviewId, "bundle-test");

    const result = await run(fx);

    expect(outputNames(fx.outputRoot)).toEqual([basename(result.bundlePath)]);
    expect(outputNames(result.bundlePath)).toEqual([
      "audio.ref.json", "deck", "manifest.json", "minutes.json", "minutes.pdf", "transcript.v1.jsonl",
    ]);
    expect(basename(result.bundlePath)).toMatch(/^bundle-\d+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    expect(outputNames(fx.outputRoot).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(existsSync(join(result.bundlePath, "original-audio.wav"))).toBe(false);
    expect(JSON.parse(readFileSync(join(result.bundlePath, "audio.ref.json"), "utf8"))).toEqual({
      path: externalAudio,
      original_audio_sha256: sha256(audioBytes),
    });
    expect(readFileSync(externalAudio)).toEqual(audioBytes);
    expect(fx.store.databaseHandle().query("SELECT status FROM artifact_bundles").get()).toEqual({ status: "complete" });
    expect(fx.store.databaseHandle().query("SELECT artifact_type FROM artifacts ORDER BY artifact_type").all()).toEqual([
      { artifact_type: "canonical_transcript" }, { artifact_type: "minutes_json" },
      { artifact_type: "minutes_pdf" }, { artifact_type: "slide_deck" },
    ]);
  });

  test("mirrors the minutes ontology and keeps every source tuple equal to JSONL coordinates", async () => {
    const fx = fixture();
    fx.store.confirmReview(fx.reviewId, "reviewer");
    let renderedHtml = "";
    const result = await run(fx, { renderPdf: async (html) => { renderedHtml = html; return fakePdf; } });
    const minutes = JSON.parse(readFileSync(join(result.bundlePath, "minutes.json"), "utf8"));
    const transcript = readFileSync(join(result.bundlePath, "transcript.v1.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const seqs = new Set(transcript.map((line) => line.seq));

    expect(minutes.attendees).toEqual([
      { attendee_id: "alice", display_name: "Alice", crm_person_entity_id: "crm-person-1" },
      { attendee_id: "bob", display_name: "Bob", crm_person_entity_id: null },
    ]);
    expect(Object.keys(minutes)).toEqual(expect.arrayContaining([
      "attendees", "decisions", "action_items", "open_items", "referenced_materials",
    ]));
    for (const item of [...minutes.decisions, ...minutes.action_items, ...minutes.open_items, ...minutes.referenced_materials]) {
      const source = item.source;
      expect(source.transcript_version_id).toBe(fx.version.transcriptVersionId);
      for (let seq = source.start_seq; seq <= source.end_seq; seq++) expect(seqs.has(seq)).toBe(true);
      expect(renderedHtml).toContain(`(${source.transcript_version_id},${source.start_seq},${source.end_seq})`);
    }
  });

  test("writes canonical four-field JSONL and binds its exact bytes to content_sha256 and manifest hashes", async () => {
    const fx = fixture();
    fx.store.confirmReview(fx.reviewId);
    const result = await run(fx);
    const transcriptBytes = readFileSync(join(result.bundlePath, "transcript.v1.jsonl"));
    const lines = transcriptBytes.toString("utf8").trim().split("\n").map(JSON.parse);
    const minutes = JSON.parse(readFileSync(join(result.bundlePath, "minutes.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(result.bundlePath, "manifest.json"), "utf8")) as BundleManifest;

    expect(lines.map(Object.keys)).toEqual([
      ["seq", "ts", "speaker_turn", "text"], ["seq", "ts", "speaker_turn", "text"], ["seq", "ts", "speaker_turn", "text"],
    ]);
    expect(minutes.transcript).toMatchObject({ version_id: fx.version.transcriptVersionId, version_no: 1, relative_path: "transcript.v1.jsonl", content_sha256: sha256(transcriptBytes) });
    expect(manifest.target_commit).toBe(targetCommit);
    for (const artifact of manifest.artifacts) {
      const bytes = readFileSync(join(result.bundlePath, artifact.path));
      expect(artifact.sha256).toBe(sha256(bytes));
      expect(artifact.byte_length).toBe(bytes.byteLength);
    }
    expect(manifest.artifacts.find((artifact) => artifact.path === "transcript.v1.jsonl")?.sha256).toBe(minutes.transcript.content_sha256);
  });

  test("refuses unconfirmed, stale-canonical, and version-mismatched confirmed items without artifact rows", async () => {
    const draft = fixture("draft-review");
    await expect(run(draft)).rejects.toThrow(/REVIEW_NOT_CONFIRMED/);
    expect(outputNames(draft.outputRoot)).toEqual([]);

    draft.store.confirmReview(draft.reviewId);
    const v2 = draft.store.addTranscriptVersion(draft.meetingId, { transcriptVersionId: "transcript-version-v2", sourceKind: "retranscription" });
    draft.store.addTranscriptVersionLines(v2.transcriptVersionId, [{ seq: 1, capturedAtMs: 1, text: "replacement" }]);
    draft.store.finalizeTranscriptVersion(v2.transcriptVersionId, transcriptContentSha256(draft.store, v2.transcriptVersionId));
    draft.store.setCanonical(draft.meetingId, v2.transcriptVersionId);
    await expect(run(draft)).rejects.toThrow(/STALE_TRANSCRIPT_VERSION/);

    const mismatch = fixture("mismatch-review");
    mismatch.store.confirmReview(mismatch.reviewId);
    const db = mismatch.store.databaseHandle();
    db.run("PRAGMA foreign_keys = OFF");
    db.run("UPDATE decisions SET source_transcript_version_id = 'wrong-version' WHERE review_id = ?", [mismatch.reviewId]);
    db.run("PRAGMA foreign_keys = ON");
    await expect(run(mismatch)).rejects.toThrow(/STALE_ITEM_PROVENANCE/);
    expect(db.query("SELECT COUNT(*) AS count FROM artifact_bundles").get()).toEqual({ count: 0 });
  });

  test("refuses a missing required deck output and removes the staging tree", async () => {
    const fx = fixture();
    fx.store.confirmReview(fx.reviewId);
    const incompleteProject = join(fx.root, "incomplete-project");
    await Bun.write(join(incompleteProject, "deck", "theme.css"), "body {}\n");

    await expect(run(fx, { projectRoot: incompleteProject })).rejects.toThrow();

    expect(outputNames(fx.outputRoot)).toEqual([]);
    expect(fx.store.databaseHandle().query("SELECT COUNT(*) AS count FROM artifact_bundles").get()).toEqual({ count: 0 });
    expect(fx.store.databaseHandle().query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
  });

  test("cleans the atomic .tmp directory on PDF failure and never publishes or records partial output", async () => {
    const fx = fixture();
    fx.store.confirmReview(fx.reviewId);

    await expect(run(fx, { renderPdf: async () => { throw new Error("injected PDF failure"); } })).rejects.toThrow("injected PDF failure");

    expect(outputNames(fx.outputRoot)).toEqual([]);
    expect(fx.store.databaseHandle().query("SELECT COUNT(*) AS count FROM artifact_bundles").get()).toEqual({ count: 0 });
    expect(fx.store.databaseHandle().query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
  });

  test("keeps an atomically published bundle when database finalization fails and deduplicates it on retry", async () => {
    const fx = fixture();
    fx.store.confirmReview(fx.reviewId);
    const db = fx.store.databaseHandle();
    db.run(`CREATE TRIGGER fail_bundle_finalize BEFORE INSERT ON artifact_bundles
      BEGIN SELECT RAISE(ABORT, 'injected finalize failure'); END`);

    await expect(run(fx)).rejects.toThrow("injected finalize failure");
    const published = outputNames(fx.outputRoot);
    expect(published).toHaveLength(1);
    expect(published[0]).not.toContain(".tmp");
    expect(db.query("SELECT COUNT(*) AS count FROM artifact_bundles").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });

    db.run("DROP TRIGGER fail_bundle_finalize");
    const retried = await run(fx);
    expect(retried.deduplicated).toBe(true);
    expect(basename(retried.bundlePath)).toBe(published[0]);
    expect(db.query("SELECT COUNT(*) AS count FROM artifact_bundles").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 4 });
  });
});
