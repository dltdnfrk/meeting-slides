import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const timeoutMs = 10_000;
let child: ChildProcessWithoutNullStreams;
let socket: WebSocket;
let tempDir: string;
let port: number;
const messages: Record<string, unknown>[] = [];
const createdArtifacts: string[] = [];

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

function waitForMessageAfter(start: number, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
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
  payload: string | Record<string, unknown>,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const start = messages.length;
  const pending = waitForMessageAfter(start, predicate);
  socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  return pending;
}

async function connect(onMessage?: (message: Record<string, unknown>) => void): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  if (onMessage) {
    ws.addEventListener("message", (event) => onMessage(JSON.parse(String(event.data)) as Record<string, unknown>));
  }
  await waitFor<void>((done, fail) => {
    ws.addEventListener("open", () => done(), { once: true });
    ws.addEventListener("error", () => fail(new Error("websocket connection failed")), { once: true });
  });
  return ws;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "meeting-slides-ws-"));
  const fakeCli = join(tempDir, "fake-cli");
  const fakeWhisper = join(tempDir, "fake-whisper");
  writeFileSync(fakeCli, "#!/bin/sh\necho fake-cli-1.0\n");
  writeFileSync(fakeWhisper, `#!/usr/bin/env bun\nprocess.on("SIGTERM", () => process.exit(0));\nconsole.log("[00:00:00.000 --> 00:00:01.000] 기준선 발화입니다.");\nawait new Promise(() => {});\n`);
  chmodSync(fakeCli, 0o755);
  chmodSync(fakeWhisper, 0o755);

  port = 18_700 + (process.pid % 500);
  child = spawn(process.execPath, ["server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      HTTP_PORT: String(port),
      OPEN_BROWSER: "false",
      MEETINGS_DB_PATH: join(tempDir, "meetings.db"),
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
  socket = await connect();
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
  await sendAndWait({ action: "status" }, (message) => message.type === "status" && message.text === "서버 정상");
});

afterAll(async () => {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  if (child && child.exitCode === null) {
    const closed = waitFor<void>((done) => child.once("close", () => done()));
    child.kill("SIGKILL");
    await closed;
  }
  for (const artifact of createdArtifacts) rmSync(join(root, artifact), { recursive: true, force: true });
  rmSync(tempDir, { recursive: true, force: true });
});

test("characterizes existing WS responses, broadcasts, saved path, active reset, and malformed input", async () => {
  const transcript = await sendAndWait(
    { action: "transcript" },
    (message) => message.type === "transcript" && message.reason === "export",
  );
  expect(transcript).toMatchObject({ type: "transcript", entries: [], reason: "export", truncated: false });

  const started = await sendAndWait(
    { action: "startCapture" },
    (message) => message.type === "capture" && message.capturing === true,
  );
  expect(started).toMatchObject({ type: "capture", capturing: true, mode: "mic" });
  expect(typeof started.startedAt).toBe("number");

  const resetBlocked = await sendAndWait(
    { action: "reset" },
    (message) => message.type === "status" && String(message.text).includes("capture must be stopped before reset"),
  );
  expect(String(resetBlocked.text)).toContain("요청 처리 실패");

  const stopped = await sendAndWait(
    { action: "stopCapture" },
    (message) => message.type === "capture" && message.capturing === false,
  );
  expect(stopped).toEqual({ type: "capture", capturing: false, mode: "mic" });
  await waitForMessageAfter(0, (message) => message.type === "status" && String(message.text).includes("녹음 중지"));

  const reset = await sendAndWait(
    { action: "reset" },
    (message) => message.type === "transcript" && message.reason === "snapshot",
  );
  expect(reset).toMatchObject({ type: "transcript", entries: [], reason: "snapshot", truncated: false });

  const markdownSaved = await sendAndWait(
    { action: "saveNotes" },
    (message) => message.type === "saved" && String(message.path).endsWith(".md"),
  );
  const markdownPath = String(markdownSaved.path);
  createdArtifacts.push(markdownPath);
  expect(existsSync(join(root, markdownPath))).toBe(true);
  expect(readFileSync(join(root, markdownPath), "utf8")).toContain("# Meeting Notes");

  const jsonSaved = await sendAndWait(
    { action: "saveJson" },
    (message) => message.type === "saved" && String(message.path).endsWith(".json"),
  );
  const jsonPath = String(jsonSaved.path);
  createdArtifacts.push(jsonPath);
  const json = JSON.parse(readFileSync(join(root, jsonPath), "utf8")) as Record<string, unknown>;
  expect(typeof json.provider).toBe("string");
  expect(Array.isArray(json.lines)).toBe(true);

  const deckSaved = await sendAndWait(
    { action: "exportDeck" },
    (message) => message.type === "saved" && String(message.path).endsWith("/index.html"),
  );
  const deckPath = String(deckSaved.path);
  createdArtifacts.push(deckPath.split("/index.html")[0]!);
  expect(existsSync(join(root, deckPath))).toBe(true);

  const reconnectMessages: Record<string, unknown>[] = [];
  let reconnect: WebSocket | undefined;
  const latestSavedPending = waitFor<Record<string, unknown>>((done, fail) => {
    void connect((message) => {
      reconnectMessages.push(message);
      if (message.type === "saved") done(message);
    }).then((ws) => { reconnect = ws; }, fail);
  });
  const latestSaved = await latestSavedPending;
  expect(latestSaved).toEqual({ type: "saved", path: deckPath });
  reconnect?.close();

  const unknownStart = messages.length;
  const sentinelPending = waitForMessageAfter(
    unknownStart,
    (message) => message.type === "status" && message.text === "서버 정상",
  );
  socket.send(JSON.stringify({ action: "unknownAction" }));
  socket.send(JSON.stringify({ action: "status" }));
  const sentinel = await sentinelPending;
  expect(sentinel.text).toBe("서버 정상");
  const sentinelIndex = messages.findIndex((message, index) => index >= unknownStart && message === sentinel);
  expect(messages.slice(unknownStart, sentinelIndex)).toEqual([]);

  const malformed = await sendAndWait("{", (message) => message.type === "status" && String(message.text).startsWith("요청 처리 실패:"));
  expect(String(malformed.text)).toContain("JSON");
}, 20_000);
