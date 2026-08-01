import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function waitFor<T>(
  subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    subscribe(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function waitForOutput(child: ChildProcessWithoutNullStreams, fragment: string): Promise<void> {
  return waitFor<void>((resolve, reject) => {
    let output = "";
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(fragment)) return;
      child.stdout.off("data", receive);
      child.stderr.off("data", receive);
      resolve();
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited before ready (${code}): ${output}`)));
  });
}

test("recorder startup failure leaves capture stopped and never launches whisper", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meeting-recorder-server-"));
  const dbPath = join(directory, "meetings.db");
  const fakeCli = join(directory, "fake-cli");
  const failedRecorder = join(directory, "ffmpeg-startup-failure");
  const fakeWhisper = join(directory, "fake-whisper");
  const whisperMarker = join(directory, "whisper-started");
  writeFileSync(fakeCli, "#!/bin/sh\necho fake-cli-1.0\n");
  writeFileSync(failedRecorder, "#!/bin/sh\nexit 23\n");
  writeFileSync(fakeWhisper, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(whisperMarker)}, "started");\nawait new Promise(() => {});\n`);
  for (const path of [fakeCli, failedRecorder, fakeWhisper]) chmodSync(path, 0o755);
  const port = 22_000 + (process.pid % 1000);
  const child = spawn(process.execPath, ["server.ts"], {
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
      WHISPER_MODEL_PATH: join(directory, "model.bin"),
      AUDIO_RECORDER_BIN: failedRecorder,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let socket: WebSocket | null = null;
  try {
    await waitForOutput(child, `HTTP: http://localhost:${port}`);
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
    await waitFor<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
    });
    const failed = waitFor<Record<string, unknown>>((resolve) => {
      socket!.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type === "status" && String(message.text).includes("audio recorder exited")) resolve(message);
      });
    });
    socket.send(JSON.stringify({ action: "startCapture" }));
    expect(await failed).toMatchObject({ type: "status" });

    const settled = waitFor<Record<string, unknown>>((resolve) => {
      socket!.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type === "status" && message.text === "서버 정상") resolve(message);
      });
    });
    socket.send(JSON.stringify({ action: "status" }));
    await settled;
    expect(messages.some((message) => message.type === "capture" && message.capturing === true)).toBe(false);
    expect(existsSync(whisperMarker)).toBe(false);

    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT phase FROM meeting_meta ORDER BY meeting_id DESC LIMIT 1").get()).toEqual({ phase: "ended" });
    expect(db.query("SELECT COUNT(*) AS count FROM transcript_versions").get()).toEqual({ count: 0 });
    db.close();
  } finally {
    socket?.close();
    if (child.exitCode === null) {
      const closed = waitFor<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await closed;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
