import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../../../..");
const port = 20_100 + (process.pid % 400);
const temp = mkdtempSync(join(tmpdir(), "meeting-slides-manual-"));
const fakeCli = join(temp, "fake-cli");
const fakeWhisper = join(temp, "fake-whisper");
const artifactReceipt = join(import.meta.dir, "manual-export.json");
let server: ChildProcess | undefined;
let ws: WebSocket | undefined;
const messages: Record<string, unknown>[] = [];
const timeoutMs = 10_000;

function bounded<T>(setup: (resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    setup(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function waitForMessage(start: number, predicate: (message: Record<string, unknown>) => boolean) {
  const existing = messages.slice(start).find(predicate);
  if (existing) return Promise.resolve(existing);
  return bounded<Record<string, unknown>>((resolve) => {
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (predicate(message)) {
        ws!.removeEventListener("message", listener);
        resolve(message);
      }
    };
    ws!.addEventListener("message", listener);
  });
}

async function send(payload: string | Record<string, unknown>, predicate: (message: Record<string, unknown>) => boolean) {
  const start = messages.length;
  const pending = waitForMessage(start, predicate);
  ws!.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  return pending;
}

function removeRuntimeState() {
  rmSync(join(root, "exports"), { recursive: true, force: true });
  for (const suffix of ["", "-shm", "-wal"]) rmSync(join(root, `meetings.db${suffix}`), { force: true });
}

try {
  removeRuntimeState();
  rmSync(artifactReceipt, { force: true });
  writeFileSync(fakeCli, "#!/bin/sh\necho fake-cli-1.0\n");
  writeFileSync(fakeWhisper, `#!/usr/bin/env bun\nprocess.on("SIGTERM", () => process.exit(0));\nconsole.log("[00:00:00.000 --> 00:00:01.000] 수동 QA 발화입니다.");\nawait new Promise(() => {});\n`);
  chmodSync(fakeCli, 0o755);
  chmodSync(fakeWhisper, 0o755);

  server = spawn(process.execPath, ["run", "server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      HTTP_PORT: String(port),
      OPEN_BROWSER: "false",
      LLM_PROVIDER: "cli",
      LLM_CLI_BIN: fakeCli,
      LLM_CLI_PRESET: "claude",
      WHISPER_INPUT_MODE: "mic",
      WHISPER_STREAM_BIN: fakeWhisper,
      WHISPER_MODEL_PATH: join(temp, "model.bin"),
      BLOCK_DETECT_SENTENCE_INTERVAL: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await bounded<void>((resolve, reject) => {
    let output = "";
    const inspect = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stdout.write(`[server] ${text}`);
      if (output.includes(`HTTP: http://localhost:${port}`)) resolve();
    };
    server!.stdout!.on("data", inspect);
    server!.stderr!.on("data", inspect);
    server!.once("error", reject);
  });

  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    messages.push(message);
    console.log(`[ws] ${JSON.stringify(message)}`);
  });
  await bounded<void>((resolve, reject) => {
    ws!.addEventListener("open", () => resolve(), { once: true });
    ws!.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
  });

  await send({ action: "status" }, (m) => m.type === "status" && m.text === "서버 정상");
  await send({ action: "startCapture" }, (m) => m.type === "capture" && m.capturing === true);
  await send({ action: "reset" }, (m) => m.type === "transcript" && m.reason === "snapshot");
  const saved = await send({ action: "saveJson" }, (m) => m.type === "saved" && String(m.path).endsWith(".json"));
  const exportPath = join(root, String(saved.path));
  if (!existsSync(exportPath)) throw new Error(`missing exported file: ${exportPath}`);
  const exportPayload = JSON.parse(readFileSync(exportPath, "utf8")) as { provider?: unknown; lines?: unknown[] };
  if (exportPayload.provider !== "cli:claude" || !Array.isArray(exportPayload.lines)) throw new Error("export content assertion failed");
  mkdirSync(import.meta.dir, { recursive: true });
  copyFileSync(exportPath, artifactReceipt);

  await send({ action: "stopCapture" }, (m) => m.type === "capture" && m.capturing === false);
  await waitForMessage(0, (m) => m.type === "status" && String(m.text).includes("녹음 중지"));

  const unknownStart = messages.length;
  const sentinel = waitForMessage(unknownStart, (m) => m.type === "status" && m.text === "서버 정상");
  ws.send(JSON.stringify({ action: "unknownAction" }));
  ws.send(JSON.stringify({ action: "status" }));
  await sentinel;
  const sentinelIndex = messages.findIndex((m, index) => index >= unknownStart && m.type === "status" && m.text === "서버 정상");
  if (messages.slice(unknownStart, sentinelIndex).length !== 0) throw new Error("unknown action emitted a message");

  await send("{", (m) => m.type === "status" && String(m.text).startsWith("요청 처리 실패:"));
  console.log(`[assert] capture/status/export/reset/unknown/malformed PASS artifact=${artifactReceipt}`);
} finally {
  ws?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await bounded<void>((resolve) => server!.once("close", () => resolve())).catch(() => server?.kill("SIGKILL"));
  }
  removeRuntimeState();
  rmSync(temp, { recursive: true, force: true });
  console.log(`[cleanup] server_exited=${server?.exitCode !== null || server?.signalCode !== null} port=${port} db_removed=${!existsSync(join(root, "meetings.db"))} exports_removed=${!existsSync(join(root, "exports"))} temp_removed=${!existsSync(temp)}`);
}
