import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";

function fixture() {
  const legacy = new MeetingStore(":memory:");
  const store = new MinutesStore(legacy.databaseHandle());
  const meetingId = legacy.startMeeting("cli:test");
  store.registerCapturingMeeting(meetingId);
  store.addAttendees(meetingId, [
    { attendeeId: "alice", displayName: "Alice" },
    { attendeeId: "bob", displayName: "Bob" },
  ]);
  const version = store.addTranscriptVersion(meetingId, {
    transcriptVersionId: "canonical-v1",
    sourceKind: "live_capture",
  });
  store.addTranscriptVersionLines(version.transcriptVersionId, [
    { seq: 1, text: "Ship Friday was confirmed." },
    { seq: 2, text: "Alice will run QA by 2026-08-07." },
    { seq: 3, text: "Bob agreed to verify the result." },
  ]);
  store.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(store, version.transcriptVersionId));
  store.setCanonical(meetingId, version.transcriptVersionId);
  const reviewId = store.saveCandidates({
    meetingId,
    transcriptVersionId: version.transcriptVersionId,
    decisions: [{
      id: "decision-1",
      description: "Ship Friday",
      source: { transcriptVersionId: version.transcriptVersionId, startSeq: 1, endSeq: 1 },
    }],
    actionItems: [{
      id: "action-1",
      description: "Run QA",
      source: { transcriptVersionId: version.transcriptVersionId, startSeq: 1, endSeq: 3 },
    }],
  });
  return { legacy, store, meetingId, transcriptVersionId: version.transcriptVersionId, reviewId };
}

function expectCode(fn: () => unknown, code: string): void {
  expect(fn).toThrow(`[${code}]`);
}

describe("MinutesStore review mutation transaction", () => {
  test("validates candidate ownership, attendee membership, and the whole patch before mutating", () => {
    const fx = fixture();
    expectCode(() => fx.store.updateItem(fx.reviewId, "decision", "action-1", {
      description: "must not cross kind boundaries",
    }), "UNKNOWN_REVIEW_ITEM");
    expectCode(() => fx.store.updateItem(fx.reviewId, "decision", "decision-1", {
      description: "partially applied text",
      attributedAttendeeId: "mallory",
    }), "ATTENDEE_NOT_IN_MEETING");
    expect(fx.store.itemsForReview(fx.reviewId).find((item) => item.id === "decision-1")).toMatchObject({
      description: "Ship Friday",
      attributedAttendeeId: null,
      reviewState: "candidate",
    });

    fx.store.updateItem(fx.reviewId, "decision", "decision-1", {
      description: "Ship on Friday",
      attributedAttendeeId: "bob",
      reviewState: "confirmed",
    });
    expect(fx.store.itemsForReview(fx.reviewId).find((item) => item.id === "decision-1")).toMatchObject({
      description: "Ship on Friday",
      attributedAttendeeId: "bob",
      reviewState: "confirmed",
    });
    fx.legacy.close();
  });

  test("atomically transitions draft to confirmed only after every item is reviewed", () => {
    const fx = fixture();
    fx.store.updateItem(fx.reviewId, "decision", "decision-1", {
      attributedAttendeeId: "alice", reviewState: "confirmed",
    });
    expectCode(() => fx.store.confirmReview(fx.reviewId, "ws-user"), "PENDING_REVIEW_ITEMS");
    expect(fx.store.review(fx.reviewId)?.status).toBe("draft");

    fx.store.updateItem(fx.reviewId, "action_item", "action-1", {
      assigneeAttendeeId: "alice",
      attributedAttendeeId: "bob",
      deadline: "2026-08-07",
      reviewState: "confirmed",
    });
    fx.store.confirmReview(fx.reviewId, "ws-user");
    expect(fx.store.review(fx.reviewId)).toMatchObject({ status: "confirmed", confirmedBy: "ws-user" });
    expectCode(() => fx.store.updateItem(fx.reviewId, "decision", "decision-1", {
      description: "too late",
    }), "REVIEW_NOT_DRAFT");
    fx.legacy.close();
  });

  test("rejects a review whose transcript version is no longer canonical", () => {
    const fx = fixture();
    fx.store.updateItem(fx.reviewId, "decision", "decision-1", { reviewState: "rejected" });
    fx.store.updateItem(fx.reviewId, "action_item", "action-1", { reviewState: "rejected" });
    const v2 = fx.store.addTranscriptVersion(fx.meetingId, { transcriptVersionId: "canonical-v2", sourceKind: "retranscription" });
    fx.store.addTranscriptVersionLines(v2.transcriptVersionId, [{ seq: 1, text: "Changed canonical transcript." }]);
    fx.store.finalizeTranscriptVersion(v2.transcriptVersionId, transcriptContentSha256(fx.store, v2.transcriptVersionId));
    fx.store.setCanonical(fx.meetingId, v2.transcriptVersionId);

    expectCode(() => fx.store.confirmReview(fx.reviewId), "STALE_TRANSCRIPT_VERSION");
    expect(fx.store.review(fx.reviewId)?.status).toBe("draft");
    fx.legacy.close();
  });

  test("detects changed canonical transcript bytes and leaves review/artifact rows untouched", () => {
    const fx = fixture();
    fx.store.updateItem(fx.reviewId, "decision", "decision-1", { reviewState: "rejected" });
    fx.store.updateItem(fx.reviewId, "action_item", "action-1", { reviewState: "rejected" });
    const db = fx.store.databaseHandle();
    db.run("DROP TRIGGER trg_finalized_transcript_lines_no_update");
    db.run("UPDATE transcript_version_lines SET text = 'Tampered transcript.' WHERE transcript_version_id = ? AND seq = 1", [fx.transcriptVersionId]);

    expectCode(() => fx.store.confirmReview(fx.reviewId), "TRANSCRIPT_INTEGRITY_FAILED");
    expect(fx.store.review(fx.reviewId)?.status).toBe("draft");
    expect(db.query("SELECT COUNT(*) AS count FROM artifact_bundles").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
    fx.legacy.close();
  });

  test("revalidates persisted attendee identities inside the confirmation transaction", () => {
    const fx = fixture();
    fx.store.updateItem(fx.reviewId, "decision", "decision-1", { reviewState: "rejected" });
    fx.store.updateItem(fx.reviewId, "action_item", "action-1", {
      assigneeAttendeeId: "alice", attributedAttendeeId: "bob", deadline: "2026-08-07", reviewState: "confirmed",
    });
    const db = fx.store.databaseHandle();
    db.run("PRAGMA foreign_keys = OFF");
    db.run("UPDATE action_items SET assignee_attendee_id = 'mallory' WHERE review_id = ?", [fx.reviewId]);
    db.run("PRAGMA foreign_keys = ON");

    expectCode(() => fx.store.confirmReview(fx.reviewId), "ATTENDEE_NOT_IN_MEETING");
    expect(fx.store.review(fx.reviewId)).toMatchObject({ status: "draft", confirmedAt: null });
    expect(db.query("SELECT COUNT(*) AS count FROM artifact_bundles").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
    fx.legacy.close();
  });

  test("rolls back confirmation when a confirmed source range has an interior gap", () => {
    const fx = fixture();
    fx.store.updateItem(fx.reviewId, "decision", "decision-1", { reviewState: "rejected" });
    fx.store.updateItem(fx.reviewId, "action_item", "action-1", {
      assigneeAttendeeId: "alice", attributedAttendeeId: "bob", deadline: "2026-08-07", reviewState: "confirmed",
    });
    const db = fx.store.databaseHandle();
    db.run("DROP TRIGGER trg_finalized_transcript_lines_no_delete");
    db.run("DELETE FROM transcript_version_lines WHERE transcript_version_id = ? AND seq = 2", [fx.transcriptVersionId]);
    db.run("UPDATE transcript_versions SET content_sha256 = ? WHERE transcript_version_id = ?", [
      transcriptContentSha256(fx.store, fx.transcriptVersionId), fx.transcriptVersionId,
    ]);

    expectCode(() => fx.store.confirmReview(fx.reviewId), "INVALID_SOURCE_SEGMENT");
    expect(fx.store.review(fx.reviewId)).toMatchObject({ status: "draft", confirmedAt: null });
    expect(db.query("SELECT COUNT(*) AS count FROM artifact_bundles").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
    fx.legacy.close();
  });

  test("rolls back the status and timestamp when the confirmation transaction fails", () => {
    const fx = fixture();
    fx.store.updateItem(fx.reviewId, "decision", "decision-1", { reviewState: "rejected" });
    fx.store.updateItem(fx.reviewId, "action_item", "action-1", { reviewState: "rejected" });
    const db = fx.store.databaseHandle();
    db.run(`CREATE TRIGGER fail_review_confirmation BEFORE UPDATE OF status ON meeting_reviews
      WHEN NEW.status = 'confirmed' BEGIN SELECT RAISE(ABORT, 'forced transaction failure'); END`);

    expect(() => fx.store.confirmReview(fx.reviewId)).toThrow("forced transaction failure");
    expect(fx.store.review(fx.reviewId)).toMatchObject({ status: "draft", confirmedAt: null });
    expect(db.query("SELECT COUNT(*) AS count FROM artifact_bundles").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
    fx.legacy.close();
  });
});

const root = join(import.meta.dir, "..");
const timeoutMs = 10_000;
let child: ChildProcessWithoutNullStreams;
let socket: WebSocket;
let tempDir: string;
let dbPath: string;
let port: number;
let meetingId: number;
let reviewId: string;
const messages: Record<string, unknown>[] = [];

function waitFor<T>(subscribe: (done: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    subscribe(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function waitForOutput(fragment: string): Promise<void> {
  return waitFor<void>((done, fail) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(fragment)) {
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        done();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", fail);
  });
}

function waitForMessageAfter(start: number, predicate: (message: Record<string, unknown>) => boolean) {
  const existing = messages.slice(start).find(predicate);
  if (existing) return Promise.resolve(existing);
  return waitFor<Record<string, unknown>>((done) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (predicate(message)) {
        socket.removeEventListener("message", onMessage);
        done(message);
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

async function sendAndWait(payload: Record<string, unknown>, predicate: (message: Record<string, unknown>) => boolean) {
  const start = messages.length;
  const pending = waitForMessageAfter(start, predicate);
  socket.send(JSON.stringify(payload));
  return pending;
}

function wsError(payload: Record<string, unknown>, code: string) {
  return sendAndWait(payload, (message) => message.type === "status" && String(message.text).includes(`[${code}]`));
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "meeting-slides-review-actions-"));
  dbPath = join(tempDir, "review.db");
  const fakeCli = join(tempDir, "fake-cli");
  const fakeWhisper = join(tempDir, "fake-whisper");
  writeFileSync(fakeCli, "#!/bin/sh\necho fake-cli-1.0\n");
  writeFileSync(fakeWhisper, "#!/usr/bin/env bun\nprocess.on('SIGTERM', () => process.exit(0));\nawait new Promise(() => {});\n");
  chmodSync(fakeCli, 0o755);
  chmodSync(fakeWhisper, 0o755);
  port = 20_300 + (process.pid % 500);
  child = spawn(process.execPath, ["server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      MEETINGS_DB_PATH: dbPath,
      MEETING_BUNDLE_OUTPUT_ROOT: join(tempDir, "exports"),
      MEETING_BUNDLE_TARGET_COMMIT: "0123456789abcdef0123456789abcdef01234567",
      HTTP_PORT: String(port),
      OPEN_BROWSER: "false",
      LLM_PROVIDER: "cli",
      LLM_CLI_BIN: fakeCli,
      LLM_CLI_PRESET: "claude",
      WHISPER_INPUT_MODE: "mic",
      WHISPER_STREAM_BIN: fakeWhisper,
      WHISPER_MODEL_PATH: join(tempDir, "model.bin"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForOutput(`HTTP: http://localhost:${port}`);
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
  await waitFor<void>((done, fail) => {
    socket.addEventListener("open", () => done(), { once: true });
    socket.addEventListener("error", () => fail(new Error("websocket connection failed")), { once: true });
  });
  const attendees = await sendAndWait({
    action: "setAttendees",
    attendees: [{ attendeeId: "alice", name: "Alice" }, { attendeeId: "bob", name: "Bob" }],
  }, (message) => message.type === "attendees");
  meetingId = attendees.meeting_id as number;

  const persistence = new MinutesStore(dbPath);
  const version = persistence.addTranscriptVersion(meetingId, { transcriptVersionId: "ws-canonical-v1", sourceKind: "import" });
  persistence.addTranscriptVersionLines(version.transcriptVersionId, [{ seq: 1, text: "Alice will run QA by 2026-08-07." }]);
  persistence.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(persistence, version.transcriptVersionId));
  persistence.setCanonical(meetingId, version.transcriptVersionId);
  reviewId = persistence.saveCandidates({
    meetingId,
    transcriptVersionId: version.transcriptVersionId,
    actionItems: [{
      id: "ws-action-1",
      description: "Run QA",
      source: { transcriptVersionId: version.transcriptVersionId, startSeq: 1, endSeq: 1 },
    }],
  });
  persistence.close();
});

afterAll(async () => {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  if (child && child.exitCode === null) {
    const closed = waitFor<void>((done) => child.once("close", () => done()));
    child.kill("SIGKILL");
    await closed;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

test("real WS actions reject adversarial patches, persist valid changes, and conclude with one complete bundle", async () => {
  await wsError({ action: "confirmReview", reviewId: "not-started" }, "REVIEW_NOT_DRAFT");
  await wsError({ action: "confirmReview" }, "INVALID_REVIEW_REQUEST");
  await wsError({ action: "confirmReview", reviewId }, "PENDING_REVIEW_ITEMS");
  await wsError({ action: "updateItem", reviewId, itemId: "ws-action-1", patch: {} }, "INVALID_REVIEW_REQUEST");
  await wsError({ action: "updateItem", reviewId, itemId: "ws-action-1", kind: "action_item" }, "INVALID_REVIEW_PATCH");
  await wsError({ action: "updateItem", reviewId, itemId: "ws-action-1", kind: "action_item", patch: {
    attributedAttendeeId: "bob", reviewState: "confirmed",
  } }, "INCOMPLETE_REVIEW_ITEM");
  await wsError({
    action: "updateItem", reviewId, itemId: "ws-action-1", kind: "decision", patch: { reviewState: "rejected" },
  }, "UNKNOWN_REVIEW_ITEM");
  await wsError({
    action: "updateItem", reviewId, itemId: "ws-action-1", kind: "action_item",
    patch: { description: "must roll back", assigneeAttendeeId: "mallory" },
  }, "ATTENDEE_NOT_IN_MEETING");
  await wsError({
    action: "updateItem", reviewId, itemId: "ws-action-1", kind: "action_item",
    patch: { sourceSegment: { transcript_version_id: "wrong", start_seq: 1, end_seq: 1 } },
  }, "INVALID_REVIEW_PATCH");

  const updated = await sendAndWait({
    action: "updateItem", reviewId, itemId: "ws-action-1", kind: "action_item",
    patch: {
      description: "Run release QA", assigneeAttendeeId: "alice", attributedAttendeeId: "bob",
      deadline: "2026-08-07", deadlineText: "next Friday", reviewState: "confirmed",
    },
  }, (message) => message.type === "reviewItemUpdated" && message.reviewId === reviewId);
  expect(updated).toEqual({ type: "reviewItemUpdated", reviewId, itemId: "ws-action-1", kind: "action_item" });

  const confirmed = await sendAndWait(
    { action: "confirmReview", reviewId },
    (message) => message.type === "reviewConfirmed" && message.reviewId === reviewId,
  );
  expect(confirmed).toMatchObject({ type: "reviewConfirmed", reviewId, transcriptVersionId: "ws-canonical-v1" });

  const db = new Database(dbPath, { readonly: true });
  expect(db.query("SELECT description, assignee_attendee_id, attributed_attendee_id, deadline, deadline_text, review_state FROM action_items WHERE action_item_id = 'ws-action-1'").get()).toEqual({
    description: "Run release QA",
    assignee_attendee_id: "alice",
    attributed_attendee_id: "bob",
    deadline: "2026-08-07",
    deadline_text: "next Friday",
    review_state: "confirmed",
  });
  const persistedReview = db.query("SELECT status, confirmed_at FROM meeting_reviews WHERE review_id = ?").get(reviewId) as {
    status: string; confirmed_at: number | null;
  };
  expect(persistedReview.status).toBe("confirmed");
  expect(persistedReview.confirmed_at).toBeGreaterThan(0);
  expect(db.query("SELECT COUNT(*) AS count FROM artifact_bundles WHERE status = 'complete'").get()).toEqual({ count: 1 });
  expect(db.query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 4 });
  expect(db.query("SELECT COUNT(*) AS count FROM meeting_conclusions").get()).toEqual({ count: 1 });
  db.close();
}, 20_000);
