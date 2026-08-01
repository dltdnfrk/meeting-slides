import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { concludeMeeting, type ConclusionState } from "../src/conclusion.ts";
import { exportBundle, type ExportBundleResult } from "../src/bundle.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";

const roots: string[] = [];
const targetCommit = "0123456789abcdef0123456789abcdef01234567";
const fakePdf = new TextEncoder().encode("%PDF-1.7\nconclusion contract\n%%EOF\n");

function fixture(reviewState: "confirmed" | "candidate" = "confirmed") {
  const root = mkdtempSync(join(tmpdir(), "meeting-conclusion-test-"));
  roots.push(root);
  const legacy = new MeetingStore(join(root, "meetings.db"));
  const store = new MinutesStore(legacy.databaseHandle());
  const meetingId = legacy.startMeeting("cli:test");
  store.registerCapturingMeeting(meetingId);
  store.addAttendees(meetingId, [{ attendeeId: "alice", displayName: "Alice" }]);
  const version = store.addTranscriptVersion(meetingId, {
    transcriptVersionId: "conclusion-v1",
    sourceKind: "import",
  });
  store.addTranscriptVersionLines(version.transcriptVersionId, [
    { seq: 1, text: "Alice will publish by 2026-08-07." },
  ]);
  store.finalizeTranscriptVersion(
    version.transcriptVersionId,
    transcriptContentSha256(store, version.transcriptVersionId),
  );
  store.setCanonical(meetingId, version.transcriptVersionId);
  legacy.addSlide({ idx: 1, title: "Publish", bullets: ["Publish the bundle"], startedAt: Date.now() });
  const reviewId = store.saveCandidates({
    meetingId,
    transcriptVersionId: version.transcriptVersionId,
    reviewId: "conclusion-review-v1",
    actionItems: [{
      id: "action-1",
      description: "Publish",
      source: { transcriptVersionId: version.transcriptVersionId, startSeq: 1, endSeq: 1 },
      assigneeAttendeeId: reviewState === "confirmed" ? "alice" : null,
      attributedAttendeeId: reviewState === "confirmed" ? "alice" : null,
      deadline: reviewState === "confirmed" ? "2026-08-07" : null,
      reviewState,
    }],
  });
  return { root, outputRoot: join(root, "exports"), legacy, store, meetingId, reviewId, version };
}

function options(fx: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  return {
    store: fx.store,
    outputRoot: fx.outputRoot,
    projectRoot: join(import.meta.dir, ".."),
    targetCommit,
    renderPdf: async () => fakePdf,
    ...overrides,
  };
}

function persisted(store: MinutesStore): Record<string, unknown> | null {
  return store.databaseHandle().query("SELECT * FROM meeting_conclusions").get() as Record<string, unknown> | null;
}

afterEach(() => {
  for (const root of roots.splice(0)) Bun.spawnSync(["rm", "-rf", root]);
});

describe("meeting conclusion", () => {
  test("confirms, atomically builds the bundle, then persists and returns its complete identity", async () => {
    const fx = fixture();
    let calls = 0;
    const exporter = async (...args: Parameters<typeof exportBundle>) => {
      calls++;
      expect(fx.store.review(fx.reviewId)?.status).toBe("confirmed");
      expect(persisted(fx.store)).toBeNull();
      return exportBundle(...args);
    };

    const result = await concludeMeeting(fx.reviewId, options(fx, { exporter }));

    expect(calls).toBe(1);
    const bundleId = result.bundleId;
    expect(result).toMatchObject({
      type: "meetingConcluded",
      concluded: true,
      meetingId: fx.meetingId,
      reviewId: fx.reviewId,
      transcriptVersionId: fx.version.transcriptVersionId,
      bundleId: expect.stringMatching(/^bundle-[0-9a-f]{64}$/),
      bundlePath: expect.stringContaining("bundle-"),
      manifest: { targetCommit, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      concludedAt: expect.any(Number),
    });
    expect(persisted(fx.store)).toMatchObject({
      meeting_id: fx.meetingId,
      review_id: fx.reviewId,
      transcript_version_id: fx.version.transcriptVersionId,
      bundle_id: bundleId,
      manifest_sha256: result.manifest.sha256,
      target_commit: targetCommit,
    });
    expect(fx.store.databaseHandle().query("SELECT COUNT(*) count FROM artifacts WHERE bundle_id = ?").get(bundleId)).toEqual({ count: 4 });
    fx.legacy.close();
  });

  test("does not claim conclusion on bundle failure, then retries a confirmed review idempotently", async () => {
    const fx = fixture();
    let fail = true;
    const exporter = async (...args: Parameters<typeof exportBundle>): Promise<ExportBundleResult> => {
      if (fail) throw new Error("injected bundle failure");
      return exportBundle(...args);
    };

    await expect(concludeMeeting(fx.reviewId, options(fx, { exporter }))).rejects.toThrow("injected bundle failure");
    expect(fx.store.review(fx.reviewId)?.status).toBe("draft");
    expect(persisted(fx.store)).toBeNull();
    expect(existsSync(fx.outputRoot) ? readdirSync(fx.outputRoot) : []).toEqual([]);

    fail = false;
    const first = await concludeMeeting(fx.reviewId, options(fx, { exporter }));
    const repeat = await concludeMeeting(fx.reviewId, options(fx, { exporter }));
    expect(repeat).toEqual(first);
    expect(fx.store.databaseHandle().query("SELECT COUNT(*) count FROM meeting_conclusions").get()).toEqual({ count: 1 });
    expect(fx.store.databaseHandle().query("SELECT COUNT(*) count FROM artifact_bundles").get()).toEqual({ count: 1 });
    expect(existsSync(fx.outputRoot) ? readdirSync(fx.outputRoot) : []).toEqual([first.bundlePath.split("/").at(-1)!]);
    fx.legacy.close();
  });

  test("revalidates attendee identity in the confirmation transaction before bundle publication", async () => {
    const fx = fixture();
    const db = fx.store.databaseHandle();
    db.run("PRAGMA foreign_keys = OFF");
    db.run("UPDATE action_items SET assignee_attendee_id = 'mallory' WHERE review_id = ?", [fx.reviewId]);
    db.run("PRAGMA foreign_keys = ON");
    let calls = 0;
    await expect(concludeMeeting(fx.reviewId, options(fx, {
      exporter: async (..._args: Parameters<typeof exportBundle>) => {
        calls++;
        throw new Error("must not run");
      },
    }))).rejects.toThrow("[ATTENDEE_NOT_IN_MEETING]");
    expect(calls).toBe(0);
    expect(fx.store.review(fx.reviewId)?.status).toBe("draft");
    expect(persisted(fx.store)).toBeNull();
    fx.legacy.close();
  });

  test("rejects pending and stale reviews before bundle publication", async () => {
    const pending = fixture("candidate");
    let calls = 0;
    const exporter = async (..._args: Parameters<typeof exportBundle>): Promise<ExportBundleResult> => {
      calls++;
      throw new Error("must not run");
    };
    await expect(concludeMeeting(pending.reviewId, options(pending, { exporter }))).rejects.toThrow("[PENDING_REVIEW_ITEMS]");
    expect(calls).toBe(0);
    expect(persisted(pending.store)).toBeNull();
    pending.legacy.close();

    const stale = fixture();
    const v2 = stale.store.addTranscriptVersion(stale.meetingId, { transcriptVersionId: "conclusion-v2", sourceKind: "retranscription" });
    stale.store.addTranscriptVersionLines(v2.transcriptVersionId, [{ seq: 1, text: "Replacement." }]);
    stale.store.finalizeTranscriptVersion(v2.transcriptVersionId, transcriptContentSha256(stale.store, v2.transcriptVersionId));
    stale.store.setCanonical(stale.meetingId, v2.transcriptVersionId);
    await expect(concludeMeeting(stale.reviewId, options(stale, { exporter }))).rejects.toThrow("[STALE_TRANSCRIPT_VERSION]");
    expect(calls).toBe(0);
    expect(persisted(stale.store)).toBeNull();
    stale.legacy.close();
  });

  test("rejects exporter results whose manifest identity does not match the meeting without persisting conclusion", async () => {
    const fx = fixture();
    const exporter = async (...args: Parameters<typeof exportBundle>) => {
      const result = await exportBundle(...args);
      return { ...result, manifest: { ...result.manifest, review_id: "other-review" } };
    };
    await expect(concludeMeeting(fx.reviewId, options(fx, { exporter }))).rejects.toThrow("[CONCLUSION_IDENTITY_MISMATCH]");
    expect(persisted(fx.store)).toBeNull();
    fx.legacy.close();
  });

  test("rejects unconfirmed direct publication and mismatched artifact links without a conclusion", async () => {
    const unconfirmed = fixture();
    await expect(exportBundle(unconfirmed.meetingId, unconfirmed.reviewId, options(unconfirmed)))
      .rejects.toThrow("[REVIEW_NOT_CONFIRMED]");
    expect(persisted(unconfirmed.store)).toBeNull();
    expect(existsSync(unconfirmed.outputRoot)).toBe(false);
    unconfirmed.legacy.close();

    const mismatched = fixture();
    const exporter = async (...args: Parameters<typeof exportBundle>) => {
      const result = await exportBundle(...args);
      mismatched.store.databaseHandle().run(
        "UPDATE artifacts SET relative_path = 'wrong.pdf' WHERE bundle_id = ? AND artifact_type = 'minutes_pdf'",
        [result.bundleId],
      );
      return result;
    };
    await expect(concludeMeeting(mismatched.reviewId, options(mismatched, { exporter })))
      .rejects.toThrow("[CONCLUSION_IDENTITY_MISMATCH]");
    expect(persisted(mismatched.store)).toBeNull();
    mismatched.legacy.close();
  });
});
