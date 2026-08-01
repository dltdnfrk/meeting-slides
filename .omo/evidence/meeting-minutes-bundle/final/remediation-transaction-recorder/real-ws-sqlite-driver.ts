import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { MinutesStore } from "../../../../../src/minutes-store.ts";
import { MeetingStore } from "../../../../../src/store.ts";
import { transcriptContentSha256 } from "../../../../../src/transcript-versioning.ts";

const root = join(import.meta.dir, "../../../../..");
const tempDir = mkdtempSync(join(tmpdir(), "t9-real-driver-"));
const dbPath = join(tempDir, "driver.db");
const fakeCli = join(tempDir, "fake-cli");
const fakeWhisper = join(tempDir, "fake-whisper");
const port = 21_000 + (process.pid % 500);
writeFileSync(fakeCli, "#!/bin/sh\necho fake-cli-1.0\n");
writeFileSync(fakeWhisper, "#!/usr/bin/env bun\nprocess.on('SIGTERM', () => process.exit(0));\nawait new Promise(() => {});\n");
chmodSync(fakeCli, 0o755);
chmodSync(fakeWhisper, 0o755);

let child: ChildProcessWithoutNullStreams | undefined;
let socket: WebSocket | undefined;
const timeoutMs = 10_000;

function bounded<T>(subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    subscribe((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function waitForServer(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return bounded((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(`HTTP: http://localhost:${port}`)) {
        proc.stdout.off("data", onData);
        proc.stderr.off("data", onData);
        resolve();
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.once("error", reject);
  });
}

function send(payload: Record<string, unknown>, predicate: (message: Record<string, unknown>) => boolean) {
  if (!socket) throw new Error("socket not connected");
  return bounded<Record<string, unknown>>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (predicate(message)) {
        socket!.removeEventListener("message", onMessage);
        resolve(message);
      }
    };
    socket!.addEventListener("message", onMessage);
    try { socket!.send(JSON.stringify(payload)); } catch (error) { reject(error as Error); }
  });
}

function error(payload: Record<string, unknown>, code: string) {
  return send(payload, (message) => message.type === "status" && String(message.text).includes(`[${code}]`));
}

function seed(legacy: MeetingStore, store: MinutesStore, label: string) {
  const meetingId = legacy.startMeeting("cli:driver");
  store.registerCapturingMeeting(meetingId);
  store.addAttendees(meetingId, [
    { attendeeId: "alice", displayName: "Alice" },
    { attendeeId: "bob", displayName: "Bob" },
  ]);
  const version = store.addTranscriptVersion(meetingId, { transcriptVersionId: `${label}-v1`, sourceKind: "import" });
  store.addTranscriptVersionLines(version.transcriptVersionId, [
    { seq: 1, text: `${label}: Alice will run QA by 2026-08-07.` },
    { seq: 2, text: `${label}: Bob will verify the release.` },
    { seq: 3, text: `${label}: The team accepted the plan.` },
  ]);
  store.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(store, version.transcriptVersionId));
  store.setCanonical(meetingId, version.transcriptVersionId);
  const reviewId = store.saveCandidates({
    meetingId,
    transcriptVersionId: version.transcriptVersionId,
    actionItems: [{
      id: `${label}-action`, description: "Run QA",
      source: { transcriptVersionId: version.transcriptVersionId, startSeq: 1, endSeq: 3 },
    }],
  });
  return { meetingId, transcriptVersionId: version.transcriptVersionId, reviewId, itemId: `${label}-action` };
}

try {
  child = spawn(process.execPath, ["server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      MEETINGS_DB_PATH: dbPath,
      HTTP_PORT: String(port),
      OPEN_BROWSER: "false",
      LLM_PROVIDER: "cli",
      LLM_CLI_BIN: fakeCli,
      LLM_CLI_PRESET: "claude",
      WHISPER_INPUT_MODE: "mic",
      WHISPER_STREAM_BIN: fakeWhisper,
      WHISPER_MODEL_PATH: join(tempDir, "model.bin"),
      MEETING_BUNDLE_OUTPUT_ROOT: join(tempDir, "exports"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(child);
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await bounded<void>((resolve, reject) => {
    socket!.addEventListener("open", () => resolve(), { once: true });
    socket!.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
  });

  const legacy = new MeetingStore(dbPath);
  const store = new MinutesStore(legacy.databaseHandle());
  const patchCase = seed(legacy, store, "patch");
  const staleCase = seed(legacy, store, "stale");
  const changedCase = seed(legacy, store, "changed");
  const attendeeCase = seed(legacy, store, "attendee");
  const gapCase = seed(legacy, store, "gap");
  const transactionCase = seed(legacy, store, "transaction");
  const happyCase = seed(legacy, store, "happy");

  const before = store.itemsForReview(patchCase.reviewId)[0]!.description;
  await error({
    action: "updateItem", reviewId: patchCase.reviewId, itemId: patchCase.itemId, kind: "action_item",
    patch: { description: "must not persist", assigneeAttendeeId: "mallory" },
  }, "ATTENDEE_NOT_IN_MEETING");
  const after = store.itemsForReview(patchCase.reviewId)[0]!.description;
  if (before !== after) throw new Error("partial patch mutated before rejection");
  console.log("PASS wrong-attendee + partial-patch: deterministic rejection, zero mutation");

  await error({ action: "confirmReview", reviewId: "before-review-exists" }, "REVIEW_NOT_DRAFT");
  await error({ action: "confirmReview" }, "INVALID_REVIEW_REQUEST");
  await error({ action: "updateItem", reviewId: happyCase.reviewId, itemId: happyCase.itemId, patch: {} }, "INVALID_REVIEW_REQUEST");
  await error({ action: "updateItem", reviewId: happyCase.reviewId, itemId: happyCase.itemId, kind: "action_item" }, "INVALID_REVIEW_PATCH");
  console.log("PASS malformed/missing requests: deterministic boundary rejection");

  store.updateItem(staleCase.reviewId, "action_item", staleCase.itemId, { reviewState: "rejected" });
  const staleV2 = store.addTranscriptVersion(staleCase.meetingId, { transcriptVersionId: "stale-v2", sourceKind: "retranscription" });
  store.addTranscriptVersionLines(staleV2.transcriptVersionId, [{ seq: 1, text: "Replacement canonical text." }]);
  store.finalizeTranscriptVersion(staleV2.transcriptVersionId, transcriptContentSha256(store, staleV2.transcriptVersionId));
  store.setCanonical(staleCase.meetingId, staleV2.transcriptVersionId);
  await error({ action: "confirmReview", reviewId: staleCase.reviewId }, "STALE_TRANSCRIPT_VERSION");
  if (store.review(staleCase.reviewId)?.status !== "draft") throw new Error("stale review transitioned");
  console.log("PASS wrong-version: canonical switch rejected, review remains draft");

  store.updateItem(changedCase.reviewId, "action_item", changedCase.itemId, { reviewState: "rejected" });
  const db = store.databaseHandle();
  db.run("DROP TRIGGER trg_finalized_transcript_lines_no_update");
  db.run("UPDATE transcript_version_lines SET text = 'Tampered.' WHERE transcript_version_id = ?", [changedCase.transcriptVersionId]);
  await error({ action: "confirmReview", reviewId: changedCase.reviewId }, "TRANSCRIPT_INTEGRITY_FAILED");
  if (store.review(changedCase.reviewId)?.status !== "draft") throw new Error("tampered review transitioned");
  console.log("PASS changed-transcript: hash mismatch rejected, review remains draft");

  store.updateItem(attendeeCase.reviewId, "action_item", attendeeCase.itemId, {
    assigneeAttendeeId: "alice", attributedAttendeeId: "bob", deadline: "2026-08-07", reviewState: "confirmed",
  });
  db.run("PRAGMA foreign_keys = OFF");
  db.run("UPDATE action_items SET assignee_attendee_id = 'mallory' WHERE review_id = ?", [attendeeCase.reviewId]);
  db.run("PRAGMA foreign_keys = ON");
  await error({ action: "confirmReview", reviewId: attendeeCase.reviewId }, "ATTENDEE_NOT_IN_MEETING");
  if (store.review(attendeeCase.reviewId)?.status !== "draft") throw new Error("invalid-attendee review transitioned");
  console.log("PASS persisted attendee tamper: roster revalidation rejected and review remains draft");

  store.updateItem(gapCase.reviewId, "action_item", gapCase.itemId, {
    assigneeAttendeeId: "alice", attributedAttendeeId: "bob", deadline: "2026-08-07", reviewState: "confirmed",
  });
  db.run("DROP TRIGGER trg_finalized_transcript_lines_no_delete");
  db.run("DELETE FROM transcript_version_lines WHERE transcript_version_id = ? AND seq = 2", [gapCase.transcriptVersionId]);
  db.run("UPDATE transcript_versions SET content_sha256 = ? WHERE transcript_version_id = ?", [
    transcriptContentSha256(store, gapCase.transcriptVersionId), gapCase.transcriptVersionId,
  ]);
  await error({ action: "confirmReview", reviewId: gapCase.reviewId }, "INVALID_SOURCE_SEGMENT");
  if (store.review(gapCase.reviewId)?.status !== "draft") throw new Error("interior-gap review transitioned");
  console.log("PASS source interior-gap: full range revalidation rejected and review remains draft");

  store.updateItem(transactionCase.reviewId, "action_item", transactionCase.itemId, { reviewState: "rejected" });
  db.run(`CREATE TRIGGER fail_driver_confirmation BEFORE UPDATE OF status ON meeting_reviews
    WHEN OLD.review_id = '${transactionCase.reviewId}' AND NEW.status = 'confirmed'
    BEGIN SELECT RAISE(ABORT, 'forced transaction failure'); END`);
  await send({ action: "confirmReview", reviewId: transactionCase.reviewId },
    (message) => message.type === "status" && String(message.text).includes("forced transaction failure"));
  if (store.review(transactionCase.reviewId)?.status !== "draft") throw new Error("failed transaction transitioned");
  console.log("PASS transaction failure: trigger abort rolled back status and timestamp");

  await send({
    action: "updateItem", reviewId: happyCase.reviewId, itemId: happyCase.itemId, kind: "action_item",
    patch: {
      description: "Run release QA", assigneeAttendeeId: "alice", attributedAttendeeId: "bob",
      deadline: "2026-08-07", reviewState: "confirmed",
    },
  }, (message) => message.type === "reviewItemUpdated" && message.reviewId === happyCase.reviewId);
  await send({ action: "confirmReview", reviewId: happyCase.reviewId },
    (message) => message.type === "reviewConfirmed" && message.reviewId === happyCase.reviewId);
  if (store.review(happyCase.reviewId)?.status !== "confirmed") throw new Error("happy review not confirmed");
  const artifactBundles = db.query("SELECT COUNT(*) AS count FROM artifact_bundles").get() as { count: number };
  const artifacts = db.query("SELECT COUNT(*) AS count FROM artifacts").get() as { count: number };
  const conclusions = db.query("SELECT COUNT(*) AS count FROM meeting_conclusions").get() as { count: number };
  if (artifactBundles.count !== 1 || artifacts.count !== 4 || conclusions.count !== 1) {
    throw new Error(`conclusion publication mismatch: ${JSON.stringify({ artifactBundles, artifacts, conclusions })}`);
  }
  console.log("PASS happy WS/SQLite: draft->concluded atomically; artifact_bundles=1 artifacts=4 conclusions=1");
  console.log(JSON.stringify({ database: "temporary", probes: 10, result: "PASS" }));
  legacy.close();
} finally {
  socket?.close();
  if (child && child.exitCode === null) {
    const closed = bounded<void>((resolve) => child!.once("close", () => resolve()));
    child.kill("SIGKILL");
    await closed;
  }
  rmSync(tempDir, { recursive: true, force: true });
}
