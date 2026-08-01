import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { MinutesStore } from "../../../../src/minutes-store.ts";
import { MeetingStore } from "../../../../src/store.ts";
import { transcriptContentSha256 } from "../../../../src/transcript-versioning.ts";

const root = join(import.meta.dir, "../../../..");
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
  store.addTranscriptVersionLines(version.transcriptVersionId, [{ seq: 1, text: `${label}: Alice will run QA by 2026-08-07.` }]);
  store.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(store, version.transcriptVersionId));
  store.setCanonical(meetingId, version.transcriptVersionId);
  const reviewId = store.saveCandidates({
    meetingId,
    transcriptVersionId: version.transcriptVersionId,
    actionItems: [{
      id: `${label}-action`, description: "Run QA",
      source: { transcriptVersionId: version.transcriptVersionId, startSeq: 1, endSeq: 1 },
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
  console.log("PASS confirm-before-review: deterministic REVIEW_NOT_DRAFT");

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
  if (artifactBundles.count !== 0 || artifacts.count !== 0) throw new Error("T9 created artifacts");
  console.log("PASS happy WS/SQLite: draft->confirmed atomically; artifact_bundles=0 artifacts=0");
  console.log(JSON.stringify({ database: "temporary", probes: 6, result: "PASS" }));
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
