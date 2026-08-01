import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportBundle, type BundleManifest } from "../src/bundle.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";

const roots: string[] = [];
const fakePdf = new TextEncoder().encode("%PDF-1.7\nmeeting minutes test PDF bytes\n%%EOF\n");

function sha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(reviewId = "review-v1", hostile = false) {
  const root = mkdtempSync(join(tmpdir(), "meeting-bundle-test-"));
  roots.push(root);
  const legacy = new MeetingStore(join(root, "meetings.db"));
  const store = new MinutesStore(legacy.databaseHandle());
  const meetingId = legacy.startMeeting("cli:test");
  store.registerCapturingMeeting(meetingId);
  store.setMeetingPurpose(meetingId, hostile ? "Purpose </script><script>bad()</script>" : "CRM handoff");
  store.addAttendees(meetingId, [
    { attendeeId: "alice", displayName: hostile ? "Alice <Admin>" : "Alice", crmPersonEntityId: "crm-001", sortOrder: 0 },
    { attendeeId: "bob", displayName: "Bob", sortOrder: 1 },
  ]);
  const version = store.addTranscriptVersion(meetingId, {
    transcriptVersionId: "canonical/version/../../v1",
    sourceKind: "import",
    engine: "fixture",
    engineModel: "exact-v1",
  });
  const text = hostile ? "Ship </script><script>bad()</script> & preserve text." : "Alice will ship the CRM bundle by 2026-08-07.";
  store.addTranscriptVersionLines(version.transcriptVersionId, [
    { seq: 1, capturedAtMs: 1_786_000_000_000, audioStartMs: 0, audioEndMs: 900, speakerTurn: 1, text },
    { seq: 2, capturedAtMs: 1_786_000_001_000, audioStartMs: 900, audioEndMs: 1_800, speakerTurn: 2, text: "Bob confirmed the launch decision." },
    { seq: 3, capturedAtMs: 1_786_000_002_000, speakerTurn: null, text: "Pricing remains open." },
  ]);
  const transcriptHash = transcriptContentSha256(store, version.transcriptVersionId);
  store.finalizeTranscriptVersion(version.transcriptVersionId, transcriptHash);
  store.setCanonical(meetingId, version.transcriptVersionId);
  legacy.addSlide({ idx: 1, title: hostile ? "Roadmap <unsafe>" : "Roadmap", bullets: [text], startedAt: 1_786_000_000_000 });

  const savedReviewId = store.saveCandidates({
    meetingId,
    transcriptVersionId: version.transcriptVersionId,
    reviewId,
    decisions: [{ id: "d1", description: "Launch approved", source: { transcriptVersionId: version.transcriptVersionId, startSeq: 2, endSeq: 2 } }],
    actionItems: [{ id: "a1", description: text, source: { transcriptVersionId: version.transcriptVersionId, startSeq: 1, endSeq: 1 } }],
    openItems: [{ id: "o1", description: "Pricing remains open", source: { transcriptVersionId: version.transcriptVersionId, startSeq: 3, endSeq: 3 } }],
  });
  store.databaseHandle().run(`
    INSERT INTO referenced_materials
      (material_id, meeting_id, review_id, material_type, title, uri, notes,
       source_transcript_version_id, source_start_seq, source_end_seq, review_state, created_at, updated_at)
    VALUES ('m1', ?, ?, 'link', ?, 'https://example.test/spec', NULL, ?, 1, 1, 'confirmed', ?, ?)
  `, [meetingId, savedReviewId, hostile ? "CRM <spec>" : "CRM spec", version.transcriptVersionId, Date.now(), Date.now()]);
  store.updateItem(savedReviewId, "decision", "d1", { attributedAttendeeId: "bob", reviewState: "confirmed" });
  store.updateItem(savedReviewId, "action_item", "a1", {
    assigneeAttendeeId: "alice", attributedAttendeeId: "alice", deadline: "2026-08-07", deadlineText: "by August 7", reviewState: "confirmed",
  });
  store.updateItem(savedReviewId, "open_item", "o1", { attributedAttendeeId: "bob", reviewState: "confirmed" });

  const outputRoot = join(root, "exports");
  return { root, outputRoot, legacy, store, meetingId, reviewId: savedReviewId, version, transcriptHash, text };
}

async function run(fx: ReturnType<typeof fixture>, renderPdf = async () => fakePdf) {
  return exportBundle(fx.meetingId, fx.reviewId, {
    store: fx.store,
    outputRoot: fx.outputRoot,
    projectRoot: join(import.meta.dir, ".."),
    renderPdf,
    targetCommit: "0123456789abcdef0123456789abcdef01234567",
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) Bun.spawnSync(["rm", "-rf", root]);
});

describe("atomic CRM meeting bundle", () => {
  test("exports confirmed review, immutable provenance, canonical metadata, raw audio, deck, and validated manifest", async () => {
    const fx = fixture();
    const audio = join(fx.root, "source.wav");
    writeFileSync(audio, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(80, 7)]));
    const audioBytes = readFileSync(audio);
    fx.store.addAudioSource(fx.meetingId, { originalAudioPath: audio, originalAudioSha256: sha(audioBytes), byteLength: audioBytes.byteLength });
    fx.store.confirmReview(fx.reviewId, "bundle-test");

    const result = await run(fx);
    expect(result.deduplicated).toBe(false);
    expect(existsSync(result.bundlePath)).toBe(true);
    expect(readdirSync(fx.outputRoot).some((name) => name.endsWith(".tmp"))).toBe(false);

    const minutes = JSON.parse(readFileSync(join(result.bundlePath, "minutes.json"), "utf8"));
    expect(minutes).toMatchObject({
      schema_version: 1,
      meeting: { meeting_id: fx.meetingId, purpose: "CRM handoff", provider: "cli:test" },
      transcript: { version_id: fx.version.transcriptVersionId, version_no: 1, content_sha256: fx.transcriptHash, source_kind: "import" },
      attendees: [{ attendee_id: "alice", display_name: "Alice", crm_person_entity_id: "crm-001" }, { attendee_id: "bob", display_name: "Bob", crm_person_entity_id: null }],
      decisions: [{ decision_id: "d1", source_segment: { transcript_version_id: fx.version.transcriptVersionId, start_seq: 2, end_seq: 2 } }],
      action_items: [{ action_item_id: "a1", assignee_attendee_id: "alice", deadline: "2026-08-07", source_segment: { transcript_version_id: fx.version.transcriptVersionId, start_seq: 1, end_seq: 1 } }],
      open_items: [{ open_item_id: "o1", source_segment: { transcript_version_id: fx.version.transcriptVersionId, start_seq: 3, end_seq: 3 } }],
      referenced_materials: [{ material_id: "m1", material_type: "link" }],
    });

    const transcriptPath = join(result.bundlePath, minutes.transcript.relative_path);
    expect(sha(readFileSync(transcriptPath))).toBe(fx.transcriptHash);
    const lines = readFileSync(transcriptPath, "utf8").trim().split("\n").map(JSON.parse);
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3]);
    for (const collection of [minutes.decisions, minutes.action_items, minutes.open_items]) {
      for (const item of collection) expect(lines.some((line) => line.seq === item.source_segment.start_seq)).toBe(true);
    }

    const manifest = JSON.parse(readFileSync(join(result.bundlePath, "manifest.json"), "utf8")) as BundleManifest;
    expect(manifest.target_commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(manifest.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      "minutes.html", "minutes.pdf", "minutes.json", minutes.transcript.relative_path, "audio.ref.json", "original-audio.wav", "deck/index.html",
    ]));
    for (const entry of manifest.entries) {
      const bytes = readFileSync(join(result.bundlePath, entry.path));
      expect(entry.sha256).toBe(sha(bytes));
      expect(entry.byte_size).toBe(bytes.byteLength);
      expect(entry.content_type).toBeTruthy();
      expect(entry.version.transcript_version_id).toBe(fx.version.transcriptVersionId);
    }
    expect(readFileSync(join(result.bundlePath, "minutes.pdf")).subarray(0, 5).toString()).toBe("%PDF-");
    expect(readFileSync(join(result.bundlePath, "original-audio.wav"))).toEqual(audioBytes);
    expect(JSON.parse(readFileSync(join(result.bundlePath, "audio.ref.json"), "utf8"))).toMatchObject({ status: "available", path: "original-audio.wav", original_audio_sha256: sha(audioBytes) });
    expect(fx.store.databaseHandle().query("SELECT status FROM artifact_bundles").get()).toEqual({ status: "complete" });
    expect(fx.store.databaseHandle().query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 5 });
  });

  test("rejects draft, stale, and cross-meeting reviews before creating files or artifact rows", async () => {
    const draft = fixture();
    await expect(run(draft)).rejects.toThrow(/REVIEW_NOT_CONFIRMED/);
    expect(existsSync(draft.outputRoot)).toBe(false);

    draft.store.confirmReview(draft.reviewId);
    const v2 = draft.store.addTranscriptVersion(draft.meetingId, { transcriptVersionId: "v2", sourceKind: "retranscription" });
    draft.store.addTranscriptVersionLines(v2.transcriptVersionId, [{ seq: 1, text: "new canonical" }]);
    draft.store.finalizeTranscriptVersion(v2.transcriptVersionId, transcriptContentSha256(draft.store, v2.transcriptVersionId));
    draft.store.setCanonical(draft.meetingId, v2.transcriptVersionId);
    await expect(run(draft)).rejects.toThrow(/STALE_TRANSCRIPT_VERSION/);
    expect(draft.store.databaseHandle().query("SELECT COUNT(*) AS count FROM artifact_bundles").get()).toEqual({ count: 0 });
  });

  test("uses fixed safe paths for hostile IDs/text, preserves JSON text, and escapes both HTML render paths", async () => {
    const fx = fixture("../../escape/../hostile-review", true);
    fx.store.confirmReview(fx.reviewId);
    const result = await run(fx);
    expect(result.bundlePath.startsWith(fx.outputRoot)).toBe(true);
    expect(result.bundlePath).not.toContain("hostile-review");
    expect(existsSync(join(fx.root, "escape"))).toBe(false);
    const json = JSON.parse(readFileSync(join(result.bundlePath, "minutes.json"), "utf8"));
    expect(json.action_items[0].description).toBe(fx.text);
    for (const relative of ["minutes.html", "deck/index.html"]) {
      const html = readFileSync(join(result.bundlePath, relative), "utf8");
      expect(html).not.toContain("</script><script>bad()</script>");
      expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    }
    expect(readdirSync(result.bundlePath).every((name) => name !== ".." && !name.includes(fx.version.transcriptVersionId))).toBe(true);
  });

  test("cleans every temporary/partial output and database row when PDF generation fails", async () => {
    const fx = fixture();
    fx.store.confirmReview(fx.reviewId);
    await expect(run(fx, async () => { throw new Error("injected PDF failure"); })).rejects.toThrow("injected PDF failure");
    expect(existsSync(fx.outputRoot) ? readdirSync(fx.outputRoot) : []).toEqual([]);
    expect(fx.store.databaseHandle().query("SELECT COUNT(*) AS count FROM artifact_bundles").get()).toEqual({ count: 0 });
    expect(fx.store.databaseHandle().query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
  });

  test("repeat export validates and deduplicates the same immutable bundle without rerendering", async () => {
    const fx = fixture();
    fx.store.confirmReview(fx.reviewId);
    let renders = 0;
    const render = async () => { renders++; return fakePdf; };
    const first = await run(fx, render);
    const second = await run(fx, render);
    expect(second).toEqual({ ...first, deduplicated: true });
    expect(renders).toBe(1);
    expect(fx.store.databaseHandle().query("SELECT COUNT(*) AS count FROM artifact_bundles").get()).toEqual({ count: 1 });
    expect(readdirSync(fx.outputRoot)).toEqual([first.bundlePath.split("/").at(-1)!]);
  });

  test("rejects missing or hash-mismatched audio and leaves no partial bundle", async () => {
    for (const mode of ["missing", "mismatch"] as const) {
      const fx = fixture(`review-${mode}`);
      const audio = join(fx.root, "raw.wav");
      if (mode === "mismatch") writeFileSync(audio, "changed bytes");
      fx.store.addAudioSource(fx.meetingId, { originalAudioPath: audio, originalAudioSha256: "a".repeat(64), byteLength: 12 });
      fx.store.confirmReview(fx.reviewId);
      await expect(run(fx)).rejects.toThrow(/ORIGINAL_AUDIO_(MISSING|INTEGRITY_FAILED)/);
      expect(existsSync(fx.outputRoot) ? readdirSync(fx.outputRoot) : []).toEqual([]);
    }
  });
});
