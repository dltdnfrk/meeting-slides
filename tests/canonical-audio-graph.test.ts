import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";
import { localWebSocket } from "./helpers/meeting-server.ts";
import {
  CaptureFinalizer,
  TranscriptVersionWriter,
} from "../src/transcript-versioning.ts";

const root = join(import.meta.dir, "..");

function stores() {
  const legacy = new MeetingStore(":memory:");
  const minutes = new MinutesStore(legacy.databaseHandle());
  const meetingId = legacy.startMeeting("capture-graph-test");
  minutes.registerCapturingMeeting(meetingId);
  return { legacy, minutes, meetingId };
}

function waitFor<T>(
  subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void,
  timeoutMs = 20_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    subscribe(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function waitForOutput(child: ChildProcessByStdio<null, Readable, Readable>, fragment: string): Promise<void> {
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

function waitForMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return waitFor<Record<string, unknown>>((resolve) => {
    const receive = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (!predicate(message)) return;
      socket.removeEventListener("message", receive);
      resolve(message);
    };
    socket.addEventListener("message", receive);
  });
}

describe("canonical audio graph contract", () => {
  test("writer persists audio-relative start and end coordinates", () => {
    const { legacy, minutes, meetingId } = stores();
    const writer = new TranscriptVersionWriter(minutes);
    const version = writer.begin(meetingId, { sourceKind: "retranscription" });
    writer.append({
      ts: 1_786_000_000_000,
      audioStartMs: 250,
      audioEndMs: 1_450,
      text: "오디오 좌표가 있는 확정 문장",
    } as Parameters<typeof writer.append>[0]);
    writer.finalize({ selectCanonical: true });

    expect(minutes.transcriptVersionLines(version.transcriptVersionId)).toEqual([{
      seq: 1,
      capturedAtMs: 1_786_000_000_000,
      audioStartMs: 250,
      audioEndMs: 1_450,
      speakerTurn: null,
      text: "오디오 좌표가 있는 확정 문장",
    }]);
    legacy.close();
  });

  test("capture finalizer promotes a second pass from the exact stopped recording", async () => {
    const { legacy, minutes, meetingId } = stores();
    const writer = new TranscriptVersionWriter(minutes);
    const live = writer.begin(meetingId, {
      sourceKind: "live_capture",
      engine: "whisper.cpp",
      engineModel: "/models/live.bin",
      dualWriteLegacy: true,
    });
    writer.append({ ts: 1_786_000_000_000, text: "라이브 임시 문장" });
    const recording = {
      path: "/preserved/meeting.wav",
      sha256: "a".repeat(64),
      byteLength: 4_096,
    };
    let retranscriptions = 0;
    const graph = {
      stop: async () => recording,
      retranscribe: async (stopped: typeof recording) => {
        retranscriptions += 1;
        expect(stopped).toBe(recording);
        return {
          engine: "whisper.cpp",
          engineModel: "/models/final.bin",
          lines: [{
            capturedAtMs: null,
            audioStartMs: 0,
            audioEndMs: 1_200,
            speakerTurn: null,
            text: "보존 오디오에서 다시 전사한 확정 문장",
          }],
        };
      },
    };

    const result = await new CaptureFinalizer(minutes, writer, meetingId, graph).finish();
    const canonical = minutes.canonicalVersion(meetingId);

    expect(retranscriptions).toBe(1);
    expect(canonical).toMatchObject({
      transcriptVersionId: result.transcriptVersionId,
      versionNo: 2,
      sourceKind: "retranscription",
      engine: "whisper.cpp",
      engineModel: "/models/final.bin",
    });
    expect(canonical?.transcriptVersionId).not.toBe(live.transcriptVersionId);
    expect(minutes.transcriptVersionLines(canonical!.transcriptVersionId)).toEqual([{
      seq: 1,
      capturedAtMs: null,
      audioStartMs: 0,
      audioEndMs: 1_200,
      speakerTurn: null,
      text: "보존 오디오에서 다시 전사한 확정 문장",
    }]);
    legacy.close();
  });

  test("production mic capture opens the device once and reuses its WAV for final STT", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "meeting-capture-graph-")));
    const dbPath = join(directory, "meetings.db");
    const logPath = join(directory, "graph.jsonl");
    const fakeLlm = join(directory, "fake-llm");
    const fakeRecorder = join(directory, "ffmpeg-capture");
    const fakeStream = join(directory, "fake-whisper-stream");
    const fakeCli = join(directory, "fake-whisper-cli");
    writeFileSync(fakeLlm, "#!/bin/sh\necho fake-llm-1.0\n");
    writeFileSync(fakeRecorder, `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
const output = process.argv.at(-1);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ kind: "device", owner: "recorder", output, args: process.argv.slice(2) }) + "\\n");
writeFileSync(output, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(44), Buffer.from("pcm")]));
process.stderr.write("progress=continue\\n");
process.on("SIGTERM", () => process.exit(0));
await new Promise(() => {});
`);
    writeFileSync(fakeStream, `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const working = process.cwd();
const output = working.endsWith(".capture") ? working.slice(0, -".capture".length) : null;
if (args.includes("-sa")) writeFileSync(join(working, "saved.wav"), Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(44), Buffer.from("pcm")]));
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ kind: args.includes("-c") ? "device" : "stream", owner: "live-stt", output, args }) + "\\n");
console.log("[00:00:00.000 --> 00:00:01.000] 라이브 미리보기 문장입니다.");
process.on("SIGTERM", () => process.exit(0));
await new Promise(() => {});
`);
    writeFileSync(fakeCli, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const file = args[args.indexOf("-f") + 1];
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ kind: "file-stt", file, args }) + "\\n");
console.log("[00:00:00.250 --> 00:00:01.450] 보존 오디오 확정 문장입니다.");
`);
    for (const path of [fakeLlm, fakeRecorder, fakeStream, fakeCli]) chmodSync(path, 0o755);

    const port = 23_000 + (process.pid % 1_000);
    const child = spawn(process.execPath, ["server.ts"], {
      cwd: root,
      env: {
        ...process.env,
        MEETINGS_DB_PATH: dbPath,
        MEETING_SLIDES_SETTINGS_ROOT: directory,
        MEETING_SLIDES_EXPORT_ROOT: join(directory, "exports"),
        MEETING_BUNDLE_OUTPUT_ROOT: join(directory, "exports"),
        HTTP_PORT: String(port),
        OPEN_BROWSER: "false",
        LLM_PROVIDER: "cli",
        LLM_CLI_BIN: fakeLlm,
        LLM_CLI_PRESET: "claude",
        WHISPER_INPUT_MODE: "mic",
        WHISPER_STREAM_BIN: fakeStream,
        WHISPER_CLI_BIN: fakeCli,
        WHISPER_MODEL_PATH: join(directory, "model.bin"),
        AUDIO_RECORDER_BIN: fakeRecorder,
        BLOCK_DETECT_SENTENCE_INTERVAL: "100",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let socket: WebSocket | null = null;
    try {
      await waitForOutput(child, `HTTP: http://localhost:${port}`);
      socket = localWebSocket(port);
      await waitFor<void>((resolve, reject) => {
        socket!.addEventListener("open", () => resolve(), { once: true });
        socket!.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
      });
      const started = waitForMessage(socket, (message) =>
        message.type === "capture" && message.capturing === true);
      const liveLine = waitForMessage(socket, (message) =>
        message.type === "line" && message.text === "라이브 미리보기 문장입니다.");
      socket.send(JSON.stringify({ action: "startCapture" }));
      await Promise.all([started, liveLine]);
      const stopped = waitForMessage(socket, (message) =>
        message.type === "capture" && message.phase === "idle");
      socket.send(JSON.stringify({ action: "stopCapture" }));
      await stopped;

      const events = readFileSync(logPath, "utf8").trim().split("\n").map(
        (line) => JSON.parse(line) as { kind: string; owner?: string; output?: string; file?: string },
      );
      expect(events.filter((event) => event.kind === "device")).toHaveLength(1);
      const recorder = events.find((event) => event.kind === "device")!;
      const finalStt = events.find((event) => event.kind === "file-stt");
      expect(finalStt?.file).toBe(recorder.output);

      const db = new Database(dbPath, { readonly: true });
      expect(db.query(
        "SELECT version_no, source_kind FROM transcript_versions ORDER BY version_no",
      ).all()).toEqual([
        { version_no: 1, source_kind: "live_capture" },
        { version_no: 2, source_kind: "retranscription" },
      ]);
      const canonical = db.query(`
        SELECT tv.version_no, tv.source_kind
        FROM meeting_transcript_state mts
        JOIN transcript_versions tv
          ON tv.transcript_version_id = mts.canonical_transcript_version_id
      `).get();
      expect(canonical).toEqual({ version_no: 2, source_kind: "retranscription" });
      expect(db.query(`
        SELECT tvl.audio_start_ms, tvl.audio_end_ms, tvl.text
        FROM meeting_transcript_state mts
        JOIN transcript_version_lines tvl
          ON tvl.transcript_version_id = mts.canonical_transcript_version_id
      `).get()).toEqual({
        audio_start_ms: 250,
        audio_end_ms: 1_450,
        text: "보존 오디오 확정 문장입니다.",
      });
      db.close();
    } finally {
      socket?.close();
      if (child.exitCode === null) {
        const closed = waitFor<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGKILL");
        await closed;
      }
      if (existsSync(logPath)) {
        for (const line of readFileSync(logPath, "utf8").trim().split("\n")) {
          if (!line) continue;
          const output = (JSON.parse(line) as { output?: string }).output;
          if (output) rmSync(output, { force: true });
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);
});
