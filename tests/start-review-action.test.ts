import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MinutesStore } from "../src/minutes-store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";

const root = join(import.meta.dir, "..");
const timeoutMs = 10_000;
let child: ChildProcessWithoutNullStreams;
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
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "start-review-action-"));
  dbPath = join(tempDir, "meeting.db");
  callsPath = join(tempDir, "calls.txt");
  const fakeCli = join(tempDir, "fake-cli");
  const fakeWhisper = join(tempDir, "fake-whisper");
  writeFileSync(fakeCli, `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nif (process.argv.includes("--version")) { console.log("fake 1.0"); process.exit(0); }\nappendFileSync(${JSON.stringify(callsPath)}, "extract\\n");\nconsole.log(JSON.stringify({ transcriptVersionId: "canonical-v1", decisions: [{ description: "Ship Friday", sourceSegment: { transcript_version_id: "canonical-v1", start_seq: 1, end_seq: 1 }, evidenceQuote: "Ship Friday was confirmed.", suggestedAttributionAttendeeId: "alice" }], actionItems: [{ description: "Publish", sourceSegment: { transcript_version_id: "canonical-v1", start_seq: 1, end_seq: 1 }, evidenceQuote: "Alice will publish by 2026-08-07.", suggestedAttributionAttendeeId: "alice", suggestedAssigneeAttendeeId: "alice", deadlineText: "2026-08-07" }], openItems: [{ description: "Budget", sourceSegment: { transcript_version_id: "canonical-v1", start_seq: 1, end_seq: 1 }, evidenceQuote: "Budget remains open.", suggestedAttributionAttendeeId: "alice" }] }));\n`);
  writeFileSync(fakeWhisper, "#!/usr/bin/env bun\nawait new Promise(() => {});\n");
  chmodSync(fakeCli, 0o755);
  chmodSync(fakeWhisper, 0o755);
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  port = reservation.port;
  reservation.stop();
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
      MEETING_BUNDLE_TARGET_COMMIT: "0123456789abcdef0123456789abcdef01234567",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await bounded<void>((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(`HTTP: http://localhost:${port}`)) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", reject);
  });
  owner = await connect();
  observer = await connect();
});

afterAll(async () => {
  owner?.close();
  observer?.close();
  if (child && child.exitCode === null) {
    const closed = bounded<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await closed;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

test("startReview is ended-only, requester-scoped, and single-flight for one canonical version", async () => {
  const attendees = await send(owner, {
    action: "setAttendees", attendees: [{ attendeeId: "alice", name: "Alice" }],
  }, (message) => message.type === "attendees");
  const meetingId = attendees.meeting_id as number;

  const preparedFailure = await send(owner, { action: "startReview", meeting_id: 999, reviewId: "untrusted" },
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
  owner.send(JSON.stringify({ action: "startReview", transcriptVersionId: "attacker-version" }));
  observer.send(JSON.stringify({ action: "startReview" }));
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
    transcript: { lines: [{
      seq: 1,
      speakerTurn: 7,
      text: "Ship Friday was confirmed. Alice will publish by 2026-08-07. Budget remains open.",
    }] },
  });
  expect(readFileSync(callsPath, "utf8").trim().split("\n")).toHaveLength(1);

  const reviewId = first.reviewId as string;
  const items = first.items as Array<{ id: string; kind: "decision" | "action_item" | "open_item" }>;
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
