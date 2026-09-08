import { localWebSocket, startMeetingServer, type RunningMeetingServer } from "./helpers/meeting-server.ts";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MinutesStore } from "../src/minutes-store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";

const root = join(import.meta.dir, "..");
const timeoutMs = 10_000;
const hookTimeoutMs = 20_000;
let running: RunningMeetingServer;
let owner: WebSocket;
let observer: WebSocket;
let tempDir: string;
let dbPath: string;
let callsPath: string;
let port: number;

function bounded<T>(subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    subscribe(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function connect(): Promise<WebSocket> {
  const socket = localWebSocket(port);
  await bounded<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
  });
  return socket;
}

function next(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return bounded<Record<string, unknown>>((resolve) => {
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (predicate(message)) {
        socket.removeEventListener("message", listener);
        resolve(message);
      }
    };
    socket.addEventListener("message", listener);
  });
}

async function send(socket: WebSocket, payload: Record<string, unknown>, predicate: (message: Record<string, unknown>) => boolean) {
  const pending = next(socket, predicate);
  socket.send(JSON.stringify(payload));
  return pending;
}

function extractCalls(): number {
  return readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).length;
}

async function prepareEndedMeeting(transcriptVersionId: string): Promise<number> {
  await send(owner, { action: "reset" }, (message) => message.type === "transcript");
  const attendees = await send(owner, {
    action: "setAttendees", attendees: [{ attendeeId: "alice", name: "Alice" }],
  }, (message) => message.type === "attendees");
  const meetingId = attendees.meeting_id as number;
  const db = new Database(dbPath);
  const store = new MinutesStore(db);
  const version = store.addTranscriptVersion(meetingId, { transcriptVersionId, sourceKind: "import" });
  store.addTranscriptVersionLines(version.transcriptVersionId, [{
    seq: 1,
    speakerTurn: 7,
    text: "Ship Friday was confirmed. Alice will publish by 2026-08-07. Budget remains open.",
  }]);
  store.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(store, version.transcriptVersionId));
  store.setCanonical(meetingId, version.transcriptVersionId);
  db.run("UPDATE meeting_meta SET phase = 'ended' WHERE meeting_id = ?", [meetingId]);
  db.close();
  return meetingId;
}

async function confirmAllItems(review: Record<string, unknown>): Promise<void> {
  const reviewId = review.reviewId as string;
  const items = review.items as Array<{ id: string; kind: "decision" | "action_item" | "open_item"; }>;
  for (const item of items) {
    const updated = next(owner, (message) => message.type === "reviewItemUpdated" && message.itemId === item.id);
    owner.send(JSON.stringify({
      action: "updateItem", reviewId, itemId: item.id, kind: item.kind, patch: { reviewState: "confirmed" },
    }));
    await updated;
  }
  const concluded = next(owner, (message) => message.type === "meetingConcluded" && message.reviewId === reviewId);
  owner.send(JSON.stringify({ action: "confirmReview", reviewId }));
  await concluded;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "start-review-action-"));
  dbPath = join(tempDir, "meeting.db");
  callsPath = join(tempDir, "calls.txt");
  const fakeCli = join(tempDir, "fake-cli");
  const fakeWhisper = join(tempDir, "fake-whisper");
  writeFileSync(fakeCli, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("fake 1.0"); process.exit(0); }
appendFileSync(${JSON.stringify(callsPath)}, "extract\\n");
const prompt = process.argv.slice(2).join(" ");
const versionMatch = prompt.match(/"transcriptVersionId":"([^"]+)"/);
const transcriptVersionId = versionMatch?.[1] ?? "canonical-v1";
const sourceSegment = { transcript_version_id: transcriptVersionId, start_seq: 1, end_seq: 1 };
if (prompt.includes("RETRY_NOTE")) {
  console.log(JSON.stringify({
    transcriptVersionId,
    decisions: [{ description: "Retry after notes", sourceSegment, evidenceQuote: "Ship Friday was confirmed.", suggestedAttributionAttendeeId: "alice" }],
    actionItems: [],
    openItems: [],
  }));
} else {
  console.log(JSON.stringify({
    transcriptVersionId,
    decisions: [{ description: "Ship Friday", sourceSegment, evidenceQuote: "Ship Friday was confirmed.", suggestedAttributionAttendeeId: "alice" }],
    actionItems: [{ description: "Publish", sourceSegment, evidenceQuote: "Alice will publish by 2026-08-07.", suggestedAttributionAttendeeId: "alice", suggestedAssigneeAttendeeId: "alice", deadlineText: "2026-08-07" }],
    openItems: [{ description: "Budget", sourceSegment, evidenceQuote: "Budget remains open.", suggestedAttributionAttendeeId: "alice" }],
  }));
}
`);
  writeFileSync(fakeWhisper, "#!/usr/bin/env bun\nawait new Promise(() => {});\n");
  chmodSync(fakeCli, 0o755);
  chmodSync(fakeWhisper, 0o755);
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() { } } });
  port = reservation.port;
  reservation.stop();
  running = startMeetingServer({
    ...process.env,
    MEETINGS_DB_PATH: dbPath,
    MEETING_SLIDES_SETTINGS_ROOT: tempDir,
    HTTP_PORT: String(port),
    OPEN_BROWSER: "false",
    LLM_PROVIDER: "cli",
    LLM_CLI_BIN: fakeCli,
    LLM_CLI_PRESET: "claude",
    WHISPER_INPUT_MODE: "mic",
    WHISPER_STREAM_BIN: fakeWhisper,
    WHISPER_MODEL_PATH: join(tempDir, "model.bin"),
    MEETING_BUNDLE_OUTPUT_ROOT: join(tempDir, "exports"),
    MEETING_BUNDLE_TARGET_COMMIT: "0123456789abcdef0123456789abcdef01234567",
  });
  port = running.server.port!;

  owner = await connect();
  observer = await connect();
}, hookTimeoutMs);

afterAll(async () => {
  owner?.close();
  observer?.close();
  await running?.close();
  rmSync(tempDir, { recursive: true, force: true });
}, hookTimeoutMs);

test("startReview is ended-only, requester-scoped, and single-flight for one canonical version", async () => {
  const attendees = await send(owner, {
    action: "setAttendees", attendees: [{ attendeeId: "alice", name: "Alice" }],
  }, (message) => message.type === "attendees");
  const meetingId = attendees.meeting_id as number;

  const preparedFailure = await send(owner, { action: "startReview", meetingId, reviewId: "untrusted" },
    (message) => message.type === "status" && String(message.text).startsWith("요청 처리 실패:"));
  expect(preparedFailure.text).toContain("must be ended");
  const observerBeforeEnd: Record<string, unknown>[] = [];
  const observerListener = (event: MessageEvent) => observerBeforeEnd.push(JSON.parse(String(event.data)));
  observer.addEventListener("message", observerListener);
  const observerSentinel = await send(observer, { action: "status" }, (message) => message.text === "서버 정상");
  observer.removeEventListener("message", observerListener);
  expect(observerSentinel.type).toBe("status");
  expect(observerBeforeEnd.some((message) => String(message.text).includes("must be ended"))).toBe(false);

  const db = new Database(dbPath);
  const store = new MinutesStore(db);
  const version = store.addTranscriptVersion(meetingId, { transcriptVersionId: "canonical-v1", sourceKind: "import" });
  store.addTranscriptVersionLines(version.transcriptVersionId, [{
    seq: 1,
    speakerTurn: 7,
    text: "Ship Friday was confirmed. Alice will publish by 2026-08-07. Budget remains open.",
  }]);
  store.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(store, version.transcriptVersionId));
  store.setCanonical(meetingId, version.transcriptVersionId);
  db.run("UPDATE meeting_meta SET phase = 'ended' WHERE meeting_id = ?", [meetingId]);
  db.close();

  const ownerReview = next(owner, (message) => message.type === "review");
  const observerReview = next(observer, (message) => message.type === "review");
  owner.send(JSON.stringify({ action: "startReview", meetingId, transcriptVersionId: "attacker-version" }));
  observer.send(JSON.stringify({ action: "startReview", meetingId }));
  const [first, second] = await Promise.all([ownerReview, observerReview]);
  expect(first).toEqual(second);
  expect(first).toMatchObject({
    type: "review",
    transcriptVersionId: "canonical-v1",
    items: [
      { kind: "decision", sourceSegment: { transcript_version_id: "canonical-v1", start_seq: 1, end_seq: 1 } },
      { kind: "action_item", sourceSegment: { transcript_version_id: "canonical-v1", start_seq: 1, end_seq: 1 } },
      { kind: "open_item", sourceSegment: { transcript_version_id: "canonical-v1", start_seq: 1, end_seq: 1 } },
    ],
    transcript: {
      lines: [{
        seq: 1,
        speakerTurn: 7,
        text: "Ship Friday was confirmed. Alice will publish by 2026-08-07. Budget remains open.",
      }]
    },
  });
  expect(readFileSync(callsPath, "utf8").trim().split("\n")).toHaveLength(1);

  const reviewId = first.reviewId as string;
  const items = first.items as Array<{ id: string; kind: "decision" | "action_item" | "open_item"; }>;
  const persisted = new Database(dbPath, { readonly: true });
  expect(persisted.query("SELECT review_id, status FROM meeting_reviews").get()).toEqual({ review_id: reviewId, status: "draft" });
  expect([
    persisted.query("SELECT decision_id AS id, review_id FROM decisions").get(),
    persisted.query("SELECT action_item_id AS id, review_id FROM action_items").get(),
    persisted.query("SELECT open_item_id AS id, review_id FROM open_items").get(),
  ]).toEqual(items.map((item) => ({ id: item.id, review_id: reviewId })));
  persisted.close();

  for (const item of items) {
    const updated = next(owner, (message) => message.type === "reviewItemUpdated" && message.itemId === item.id);
    owner.send(JSON.stringify({
      action: "updateItem", reviewId, itemId: item.id, kind: item.kind, patch: { reviewState: "confirmed" },
    }));
    await updated;
  }
  const concluded = next(owner, (message) => message.type === "meetingConcluded" && message.reviewId === reviewId);
  owner.send(JSON.stringify({ action: "confirmReview", reviewId }));
  expect(await concluded).toMatchObject({ type: "meetingConcluded", concluded: true, reviewId });

  const completed = new Database(dbPath, { readonly: true });
  expect(completed.query("SELECT status FROM meeting_reviews WHERE review_id = ?").get(reviewId)).toEqual({ status: "confirmed" });
  expect([
    completed.query("SELECT review_state FROM decisions").get(),
    completed.query("SELECT review_state FROM action_items").get(),
    completed.query("SELECT review_state FROM open_items").get(),
  ]).toEqual(Array.from({ length: 3 }, () => ({ review_state: "confirmed" })));
  expect(completed.query("SELECT COUNT(*) AS count FROM meeting_conclusions WHERE review_id = ?").get(reviewId)).toEqual({ count: 1 });
  completed.close();
}, timeoutMs + 2_000);

test("startReview with notes re-extracts a draft and leaves a confirmed snapshot untouched", async () => {
  const meetingId = await prepareEndedMeeting("draft-retry-v1");
  const draft = await send(owner, { action: "startReview", meetingId }, (message) => message.type === "review");
  expect((draft.items as Array<{ description: string; }>)[0]?.description).toBe("Ship Friday");
  const callsAfterDraft = extractCalls();

  const retried = await send(owner, {
    action: "startReview", meetingId, notes: "RETRY_NOTE",
  }, (message) => message.type === "review");
  expect(extractCalls()).toBe(callsAfterDraft + 1);
  expect((retried.items as Array<{ description: string; }>).map((item) => item.description)).toEqual(["Retry after notes"]);
  expect(retried.status).toBe("draft");

  await confirmAllItems(retried);
  const callsAfterConfirm = extractCalls();
  const frozen = await send(owner, { action: "startReview", meetingId, notes: "RETRY_NOTE" }, (message) => message.type === "review");
  expect(extractCalls()).toBe(callsAfterConfirm);
  expect(frozen.reviewId).toBe(retried.reviewId);
  expect(frozen.status).toBe("confirmed");
  expect((frozen.items as Array<{ description: string; }>).map((item) => item.description)).toEqual(["Retry after notes"]);
}, timeoutMs + 2_000);

test("setAttendees updates an ended draft roster and is refused after confirmation", async () => {
  const meetingId = await prepareEndedMeeting("ended-roster-v1");
  const draft = await send(owner, { action: "startReview", meetingId }, (message) => message.type === "review");
  expect(draft.status).toBe("draft");

  const updated = await send(owner, {
    action: "setAttendees",
    attendees: [
      { attendeeId: "alice", name: "Alice" },
      { attendeeId: "bob", name: "Bob" },
    ],
  }, (message) => message.type === "attendees" || (message.type === "status" && String(message.text).startsWith("요청 처리 실패:")));
  expect(updated).toMatchObject({
    type: "attendees",
    meeting_id: meetingId,
    attendees: [
      { attendee_id: "alice", display_name: "Alice" },
      { attendee_id: "bob", display_name: "Bob" },
    ],
  });

  await confirmAllItems(draft);
  const refused = await send(owner, {
    action: "setAttendees",
    attendees: [{ attendeeId: "alice", name: "Alice Changed" }],
  }, (message) => message.type === "status" && String(message.text).startsWith("요청 처리 실패:"));
  expect(String(refused.text)).toContain("locked after review confirmation");
}, timeoutMs + 2_000);
