import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { localWebSocket } from "./helpers/meeting-server.ts";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function waitFor<T>(
  subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void,
  timeoutMs = 30_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    subscribe(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function waitForPort(child: ChildProcessByStdio<null, Readable, Readable>): Promise<number> {
  return waitFor<number>((resolve, reject) => {
    let output = "";
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/HTTP: http:\/\/localhost:(\d+)/);
      if (!match) return;
      child.stdout.off("data", receive);
      child.stderr.off("data", receive);
      resolve(Number(match[1]));
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited before ready (${code}): ${output}`)));
  });
}

test("legacy AUDIO_RECORDER_BIN cannot launch a second device capture", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meeting-recorder-server-"));
  const dbPath = join(directory, "meetings.db");
  const fakeCli = join(directory, "fake-cli");
  const failedRecorder = join(directory, "ffmpeg-startup-failure");
  const fakeWhisper = join(directory, "fake-whisper");
  const fakeWhisperCli = join(directory, "fake-whisper-cli");
  const recorderMarker = join(directory, "recorder-started");
  const whisperMarker = join(directory, "whisper-started");
  writeFileSync(fakeCli, "#!/bin/sh\necho fake-cli-1.0\n");
  writeFileSync(failedRecorder, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(recorderMarker)}, "started");\nprocess.exit(23);\n`);
  writeFileSync(fakeWhisper, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { join } from "node:path";
await Bun.write(${JSON.stringify(whisperMarker)}, "started");
if (process.argv.includes("-sa")) writeFileSync(join(process.cwd(), "saved.wav"), Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(44), Buffer.from("pcm")]));
console.log("[00:00:00.000 --> 00:00:01.000] 라이브 문장입니다.");
process.on("SIGTERM", () => process.exit(0));
await new Promise(() => {});
`);
  writeFileSync(fakeWhisperCli, `#!/bin/sh
echo "[00:00:00.000 --> 00:00:01.000] 확정 문장입니다."
`);
  for (const path of [fakeCli, failedRecorder, fakeWhisper, fakeWhisperCli]) chmodSync(path, 0o755);
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() { } } });
  const port = reservation.port;
  reservation.stop();
  const child = spawn(process.execPath, ["server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      MEETINGS_DB_PATH: dbPath,
      MEETING_SLIDES_SETTINGS_ROOT: directory,
      MEETING_BUNDLE_OUTPUT_ROOT: join(directory, "exports"),
      MEETING_SLIDES_EXPORT_ROOT: join(directory, "exports"),
      HTTP_PORT: String(port),
      OPEN_BROWSER: "false",
      LLM_PROVIDER: "cli",
      LLM_CLI_BIN: fakeCli,
      LLM_CLI_PRESET: "claude",
      WHISPER_INPUT_MODE: "mic",
      WHISPER_STREAM_BIN: fakeWhisper,
      WHISPER_CLI_BIN: fakeWhisperCli,
      WHISPER_MODEL_PATH: join(directory, "model.bin"),
      AUDIO_RECORDER_BIN: failedRecorder,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(`[resource] recorder CLI server pid=${child.pid}`);
  let socket: WebSocket | null = null;
  try {
    const actualPort = await waitForPort(child);
    socket = localWebSocket(actualPort);
    const messages: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
    await waitFor<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
    });
    const started = waitFor<Record<string, unknown>>((resolve) => {
      socket!.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type === "line" && message.text === "라이브 문장입니다.") resolve(message);
      });
    });
    socket.send(JSON.stringify({ action: "startCapture" }));
    expect(await started).toMatchObject({ type: "line", text: "라이브 문장입니다." });
    expect(existsSync(whisperMarker)).toBe(true);
    expect(existsSync(recorderMarker)).toBe(false);

    const settled = waitFor<Record<string, unknown>>((resolve) => {
      socket!.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type === "capture" && message.phase === "idle") resolve(message);
      });
    });
    socket.send(JSON.stringify({ action: "stopCapture" }));
    await settled;
    expect(messages.some((message) => message.type === "capture" && message.capturing === true)).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT phase FROM meeting_meta ORDER BY meeting_id DESC LIMIT 1").get()).toEqual({ phase: "ended" });
    expect(db.query("SELECT version_no, source_kind FROM transcript_versions ORDER BY version_no").all()).toEqual([
      { version_no: 1, source_kind: "live_capture" },
      { version_no: 2, source_kind: "retranscription" },
    ]);
    const audio = db.query(
      "SELECT original_audio_path FROM meeting_audio_sources ORDER BY meeting_id DESC LIMIT 1",
    ).get() as { original_audio_path: string; } | null;
    db.close();
    if (audio?.original_audio_path) rmSync(audio.original_audio_path, { force: true });
  } finally {
    socket?.close();
    if (child.exitCode === null) {
      const closed = waitFor<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGTERM");
      await closed;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
