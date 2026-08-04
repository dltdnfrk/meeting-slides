import { Database } from "bun:sqlite";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { MinutesStore } from "../../../../../src/minutes-store.ts";
import { transcriptContentSha256 } from "../../../../../src/transcript-versioning.ts";

const root = join(import.meta.dir, "../../../../..");
const targetCommit = "c2736c81fe6ca04167b4f2ded7e67804226471ce";
const timeoutMs = 60_000;

function bounded<T>(label: string, subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timeout after ${timeoutMs}ms`)), timeoutMs);
    subscribe(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function next(socket: WebSocket, predicate: (message: Record<string, any>) => boolean, label: string) {
  return bounded<Record<string, any>>(label, (resolve, reject) => {
    const listener = (event: MessageEvent) => {
      try {
        const message = JSON.parse(String(event.data));
        if (predicate(message)) {
          socket.removeEventListener("message", listener);
          resolve(message);
        }
      } catch (error) {
        socket.removeEventListener("message", listener);
        reject(error as Error);
      }
    };
    socket.addEventListener("message", listener);
  });
}

async function waitForServer(child: ChildProcessWithoutNullStreams, fragment: string): Promise<void> {
  await bounded<void>("server readiness", (resolve, reject) => {
    let output = "";
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(fragment)) {
        child.stdout.off("data", receive);
        child.stderr.off("data", receive);
        resolve();
      }
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited before ready (${code}): ${output}`)));
  });
}

async function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await bounded<void>("websocket open", (resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
  });
  return socket;
}

const runDir = mkdtempSync(join(tmpdir(), "review-flow-remediation-"));
const dbPath = join(runDir, "meeting.db");
const fakeCli = join(runDir, "fake-cli");
const fakeWhisper = join(runDir, "fake-whisper");
writeFileSync(fakeCli, `#!/usr/bin/env bun\nif (process.argv.includes("--version")) { console.log("fake 1.0"); process.exit(0); }\nconsole.log(JSON.stringify({ transcriptVersionId: "flow-v1", decisions: [{ description: "Ship Friday", sourceSegment: { transcript_version_id: "flow-v1", start_seq: 1, end_seq: 1 }, evidenceQuote: "Ship Friday was confirmed.", suggestedAttributionAttendeeId: null }], actionItems: [], openItems: [] }));\n`);
writeFileSync(fakeWhisper, "#!/usr/bin/env bun\nawait new Promise(() => {});\n");
chmodSync(fakeCli, 0o755);
chmodSync(fakeWhisper, 0o755);
const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = reservation.port;
reservation.stop();
const child = spawn(process.execPath, ["server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    MEETINGS_DB_PATH: dbPath,
    MEETING_BUNDLE_OUTPUT_ROOT: join(runDir, "exports"),
    MEETING_BUNDLE_TARGET_COMMIT: targetCommit,
    HTTP_PORT: String(port),
    OPEN_BROWSER: "false",
    LLM_PROVIDER: "cli",
    LLM_CLI_BIN: fakeCli,
    LLM_CLI_PRESET: "claude",
    WHISPER_INPUT_MODE: "mic",
    WHISPER_STREAM_BIN: fakeWhisper,
    WHISPER_MODEL_PATH: join(runDir, "model.bin"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let browser: Browser | undefined;
let socket: WebSocket | undefined;
try {
  await waitForServer(child, `HTTP: http://localhost:${port}`);
  socket = await connect(port);
  browser = await puppeteer.launch({ headless: true });
  const page: Page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });

  const attendeeEvent = next(socket, (message) => message.type === "attendees" && message.attendees?.length === 1, "attendee event");
  socket.send(JSON.stringify({ action: "setAttendees", attendees: [{ attendeeId: "alice", name: "Alice" }] }));
  const attendee = await attendeeEvent;
  const meetingId = attendee.meeting_id as number;

  const db = new Database(dbPath);
  const store = new MinutesStore(db);
  const version = store.addTranscriptVersion(meetingId, { transcriptVersionId: "flow-v1", sourceKind: "import" });
  store.addTranscriptVersionLines(version.transcriptVersionId, [{ seq: 1, text: "Ship Friday was confirmed." }]);
  store.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(store, version.transcriptVersionId));
  store.setCanonical(meetingId, version.transcriptVersionId);
  store.endMeeting(meetingId);

  const reviewEvent = next(socket, (message) => message.type === "review", "review event");
  socket.send(JSON.stringify({ action: "startReview" }));
  const review = await reviewEvent;
  await page.waitForSelector(`.review-item[data-item-id="${review.items[0].id}"] .review-item__confirm`);

  const persistedBeforeBroadcastUse = db.query(`
    SELECT mr.review_id, mr.status, d.decision_id, d.review_state
    FROM meeting_reviews mr JOIN decisions d ON d.review_id = mr.review_id
    WHERE mr.review_id = ?
  `).get(review.reviewId) as Record<string, unknown> | null;
  if (!persistedBeforeBroadcastUse || persistedBeforeBroadcastUse.decision_id !== review.items[0].id) {
    throw new Error("broadcast review/item IDs do not match persisted rows");
  }

  const attributionAck = next(socket, (message) => message.type === "reviewItemUpdated" && message.itemId === review.items[0].id, "attribution ack");
  await page.select(`.review-item[data-item-id="${review.items[0].id}"] .review-item__attribution`, "alice");
  await attributionAck;

  const itemConfirmAck = next(socket, (message) => message.type === "reviewItemUpdated" && message.itemId === review.items[0].id, "item confirm ack");
  await page.click(`.review-item[data-item-id="${review.items[0].id}"] .review-item__confirm`);
  await itemConfirmAck;
  await page.waitForFunction(() => !(document.getElementById("btn-review-confirm") as HTMLButtonElement).disabled);

  const conclusionEvent = next(socket, (message) => message.type === "meetingConcluded" && message.reviewId === review.reviewId, "conclusion event");
  await page.click("#btn-review-confirm");
  const conclusion = await conclusionEvent;
  const persistedAfter = db.query(`
    SELECT mr.status, d.review_state, d.attributed_attendee_id,
      (SELECT COUNT(*) FROM meeting_conclusions mc WHERE mc.review_id = mr.review_id) AS conclusions
    FROM meeting_reviews mr JOIN decisions d ON d.review_id = mr.review_id
    WHERE mr.review_id = ?
  `).get(review.reviewId);

  console.log(JSON.stringify({
    targetCommit,
    meetingId,
    reviewId: review.reviewId,
    itemId: review.items[0].id,
    persistedBeforeBroadcastUse,
    persistedAfter,
    concluded: conclusion.concluded,
    uiState: await page.$eval(`.review-item[data-item-id="${review.items[0].id}"]`, (row) => (row as HTMLElement).dataset.reviewState),
  }, null, 2));
  db.close();
} finally {
  socket?.close();
  await browser?.close();
  if (child.exitCode === null) {
    const closed = bounded<void>("server cleanup", (resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await closed;
  }
  rmSync(runDir, { recursive: true, force: true });
}
