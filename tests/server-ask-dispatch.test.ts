import { localWebSocket, startMeetingServer, type RunningMeetingServer } from "./helpers/meeting-server.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const deadlineMs = 15_000;
const hookTimeoutMs = 30_000;
let running: RunningMeetingServer;
let socket: WebSocket;
let temporaryDirectory: string;
let transportLog: string;
let port: number;
const messages: Record<string, unknown>[] = [];

function bounded<T>(subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${deadlineMs}ms`)), deadlineMs);
    subscribe(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function nextMessage(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return bounded<Record<string, unknown>>((resolve) => {
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (!predicate(message)) return;
      socket.removeEventListener("message", listener);
      resolve(message);
    };
    socket.addEventListener("message", listener);
  });
}

async function sendAndWait(
  command: Record<string, unknown>,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const pending = nextMessage(predicate);
  socket.send(JSON.stringify(command));
  return pending;
}

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "meeting-slides-ask-dispatch-"));
  transportLog = join(temporaryDirectory, "transport.jsonl");
  const cli = join(temporaryDirectory, "claude-fixture");
  const whisper = join(temporaryDirectory, "whisper-fixture");
  writeFileSync(cli, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("ask-fixture 1.0"); process.exit(0); }
const promptIndex = args.indexOf("-p");
if (promptIndex < 0 || !args[promptIndex + 1]) process.exit(2);
appendFileSync(${JSON.stringify(transportLog)}, JSON.stringify({ args }) + "\\n");
process.stdout.write("금요일 배포로 결정했고 민수가 릴리스 노트를 담당합니다.");
`);
  writeFileSync(whisper, `#!/usr/bin/env bun
console.log("[00:00:00.000 --> 00:00:01.000] 금요일 배포는 민수가 담당합니다.");
process.on("SIGTERM", () => process.exit(0));
await new Promise(() => {});
`);
  chmodSync(cli, 0o755);
  chmodSync(whisper, 0o755);
  writeFileSync(join(temporaryDirectory, "model.bin"), "fixture");
  port = 19_200 + (process.pid % 400);
  running = startMeetingServer({
    ...process.env,
    HTTP_PORT: String(port), OPEN_BROWSER: "false",
    MEETINGS_DB_PATH: join(temporaryDirectory, "meetings.db"),
    LLM_PROVIDER: "cli", LLM_CLI_BIN: cli, LLM_CLI_PRESET: "claude",
    LLM_CLI_TIMEOUT_MS: "5000", ASK_TRANSPORT_LOG: transportLog,
    WHISPER_INPUT_MODE: "mic", WHISPER_STREAM_BIN: whisper,
    WHISPER_MODEL_PATH: join(temporaryDirectory, "model.bin"),
    BLOCK_DETECT_SENTENCE_INTERVAL: "100",
  });
  port = running.server.port!;

  socket = localWebSocket(port);
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
  await bounded<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
  });
  const started = nextMessage((message) => message.type === "capture" && message.capturing === true);
  const line = nextMessage((message) => message.type === "line");
  socket.send(JSON.stringify({ action: "startCapture" }));
  await Promise.all([started, line]);
  await sendAndWait({ action: "stopCapture" }, (message) => message.type === "capture" && message.phase === "idle");
}, hookTimeoutMs);

afterAll(async () => {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  await running?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}, hookTimeoutMs);

test("real WebSocket ask dispatch invokes transport and returns exactly one terminal response", async () => {
  const requestId = "ask-dispatch-regression";
  const start = messages.length;
  const response = await sendAndWait(
    { action: "ask", meetingId: 1, question: "배포일과 담당자는 누구인가요?", requestId },
    (message) => message.type === "ask" && message.requestId === requestId,
  );
  expect(response).toEqual({
    type: "ask", requestId,
    answer: "금요일 배포로 결정했고 민수가 릴리스 노트를 담당합니다.",
    matchedCount: 1,
  });
  await sendAndWait({ action: "status" }, (message) => message.type === "status" && message.text === "서버 정상");
  expect(messages.slice(start).filter((message) => message.type === "ask" && message.requestId === requestId)).toHaveLength(1);
  const replay = await sendAndWait(
    { action: "ask", meetingId: 1, question: "배포일과 담당자는 누구인가요?", requestId },
    (message) => message.type === "ask" && message.requestId === requestId,
  );
  expect(replay).toEqual(response);
  const calls = readFileSync(transportLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  // Stop flush may independently run the production topic detector. The Ask question itself must still invoke transport exactly once.
  const askCalls = calls.filter((call) => call.args.some((arg: string) => arg.includes("배포일과 담당자는 누구인가요?")));
  expect(askCalls).toHaveLength(1);
  expect(askCalls[0].args).toEqual(expect.arrayContaining(["-p", "--output-format", "text"]));
}, 30_000);
