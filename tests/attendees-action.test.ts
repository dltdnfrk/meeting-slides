import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const timeoutMs = 10_000;
let child: ChildProcessWithoutNullStreams;
let socket: WebSocket;
let tempDir: string;
let dbPath: string;
let port: number;
let fakeWhisperPidPath: string;
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

function waitForMessageAfter(
  start: number,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
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

async function sendAndWait(
  payload: Record<string, unknown>,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const start = messages.length;
  const pending = waitForMessageAfter(start, predicate);
  socket.send(JSON.stringify(payload));
  return pending;
}

function errorFor(payload: Record<string, unknown>, fragment: string): Promise<Record<string, unknown>> {
  return sendAndWait(payload, (message) =>
    message.type === "status" && String(message.text).startsWith("요청 처리 실패:") && String(message.text).includes(fragment));
}

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

function waitForProcessExit(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return waitFor<void>((done) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return done();
    proc.once("close", () => done());
  });
}

async function teardownChildTree(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  killProcessTree(proc.pid!, "SIGTERM");
  try {
    await Promise.race([
      waitForProcessExit(proc),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("server teardown timed out")), 2_000)),
    ]);
  } catch {
    killProcessTree(proc.pid!, "SIGKILL");
    await waitForProcessExit(proc);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "meeting-slides-attendees-"));
  dbPath = join(tempDir, "attendees.db");
  fakeWhisperPidPath = join(tempDir, "fake-whisper.pid");
  const fakeCli = join(tempDir, "fake-cli");
  const fakeWhisper = join(tempDir, "fake-whisper");
  writeFileSync(fakeCli, "#!/bin/sh\necho fake-cli-1.0\n");
  writeFileSync(fakeWhisper, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(fakeWhisperPidPath)}, String(process.pid));
process.on('SIGTERM', () => process.exit(0));
await new Promise(() => {});
`);
  chmodSync(fakeCli, 0o755);
  chmodSync(fakeWhisper, 0o755);

  port = 19_800 + (process.pid % 500);
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
      BLOCK_DETECT_SENTENCE_INTERVAL: "100",
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
});

afterAll(async () => {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  if (child) await teardownChildTree(child);
  if (readFileSync && fakeWhisperPidPath) {
    try {
      const fakeWhisperPid = Number(readFileSync(fakeWhisperPidPath, "utf8"));
      if (Number.isInteger(fakeWhisperPid) && processExists(fakeWhisperPid)) {
        throw new Error("fake-whisper orphan survived teardown");
      }
    } catch (error) {
      if (!(error instanceof Error) || !String(error.message).includes("ENOENT")) throw error;
    }
  }
  rmSync(tempDir, { recursive: true, force: true });
});

test("setAttendees replaces a prepared roster and rejects capturing or ended meetings", async () => {
  await errorFor({ action: "startCapture", meeting_id: 1 }, "does not match the current prepared meeting");
  await errorFor({ action: "setAttendees", attendees: [] }, "attendees must contain at least one attendee");
  await errorFor({ action: "setAttendees", attendees: [{ name: " " }] }, "attendees[0].name must be a non-blank string");
  await errorFor({
    action: "setAttendees",
    attendees: [{ attendeeId: "same", name: "Alice" }, { attendeeId: "same", name: "Bob" }],
  }, "duplicate attendeeId");
  await errorFor({
    action: "setAttendees",
    attendees: [{ name: "Alice", crmPersonId: "crm-same" }, { name: "Bob", crmPersonId: "crm-same" }],
  }, "duplicate crmPersonId");

  const first = await sendAndWait({
    action: "setAttendees",
    purpose: "Launch review",
    attendees: [
      { name: " Alice ", crmPersonId: "crm-alice" },
      { attendeeId: "bob-local", name: "Bob" },
      { attendeeId: "carol-local", name: "Carol", crmPersonId: null },
    ],
  }, (message) => message.type === "attendees");
  const meetingId = first.meeting_id as number;
  const firstAttendees = first.attendees as Array<Record<string, unknown>>;
  expect(Number.isInteger(meetingId)).toBe(true);
  expect(firstAttendees).toHaveLength(3);
  expect(firstAttendees[0]).toMatchObject({ display_name: "Alice", crm_person_entity_id: "crm-alice" });
  expect(typeof firstAttendees[0]!.attendee_id).toBe("string");
  expect(firstAttendees[1]).toEqual({ attendee_id: "bob-local", display_name: "Bob" });

  const replaced = await sendAndWait({
    action: "setAttendees",
    purpose: "Launch decision",
    attendees: [
      { attendeeId: firstAttendees[0]!.attendee_id, name: "Alice Kim" },
      { attendeeId: "dana-local", name: "Dana" },
    ],
  }, (message) => message.type === "attendees" && message.meeting_id === meetingId &&
    Array.isArray(message.attendees) && message.attendees.length === 2);
  expect(replaced.attendees).toEqual([
    { attendee_id: firstAttendees[0]!.attendee_id, display_name: "Alice Kim" },
    { attendee_id: "dana-local", display_name: "Dana" },
  ]);

  const db = new Database(dbPath, { readonly: true });
  expect(db.query("SELECT COUNT(*) AS count FROM meetings").get()).toEqual({ count: 1 });
  expect(db.query("SELECT purpose, phase FROM meeting_meta WHERE meeting_id = ?").get(meetingId)).toEqual({
    purpose: "Launch decision", phase: "prepared",
  });
  expect(db.query("SELECT COUNT(*) AS count FROM attendees WHERE meeting_id = ?").get(meetingId)).toEqual({ count: 2 });

  await errorFor({ action: "startCapture", meeting_id: meetingId + 1 }, "does not match the current prepared meeting");
  expect(db.query("SELECT COUNT(*) AS count FROM meetings").get()).toEqual({ count: 1 });

  const started = await sendAndWait(
    { action: "startCapture", meeting_id: meetingId },
    (message) => message.type === "capture" && message.capturing === true,
  );
  expect(started).toEqual({ type: "capture", capturing: true, mode: "mic" });
  expect(db.query("SELECT phase FROM meeting_meta WHERE meeting_id = ?").get(meetingId)).toEqual({ phase: "capturing" });

  await errorFor({
    action: "setAttendees",
    attendees: [{ attendeeId: "dana-local", name: "Dana Park", crmPersonId: "crm-dana" }],
  }, `meeting ${meetingId} is not prepared`);
  expect(db.query("SELECT display_name, crm_person_entity_id FROM attendees WHERE meeting_id = ? AND attendee_id = ?")
    .get(meetingId, "dana-local")).toEqual({ display_name: "Dana", crm_person_entity_id: null });

  await sendAndWait(
    { action: "stopCapture" },
    (message) => message.type === "status" && String(message.text).includes("녹음 중지"),
  );
  expect(db.query("SELECT phase FROM meeting_meta WHERE meeting_id = ?").get(meetingId)).toEqual({ phase: "ended" });

  await errorFor({
    action: "setAttendees",
    attendees: [{ attendeeId: "dana-local", name: "Dana Final" }],
  }, `meeting ${meetingId} is not prepared`);
  await errorFor({ action: "startCapture", meeting_id: meetingId }, "is not prepared");
  expect(db.query("SELECT COUNT(*) AS count FROM meetings").get()).toEqual({ count: 1 });
  expect(db.query("SELECT display_name FROM attendees WHERE meeting_id = ? AND attendee_id = ?")
    .get(meetingId, "dana-local")).toEqual({ display_name: "Dana" });
  db.close();
}, 20_000);
