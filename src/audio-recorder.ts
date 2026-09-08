import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";

import type { MinutesStore } from "./minutes-store.ts";

export interface StoppedAudioRecording {
  path: string;
  sha256: string;
  byteLength: number;
}

export interface AudioRecorderHandle {
  stop(): Promise<StoppedAudioRecording>;
}

export interface AudioRetranscriptionLine {
  capturedAtMs: number | null;
  audioStartMs: number;
  audioEndMs: number;
  speakerTurn: number | null;
  text: string;
}

export interface AudioRetranscription {
  engine: string;
  engineModel: string;
  lines: readonly AudioRetranscriptionLine[];
}

export interface CanonicalAudioCaptureHandle extends AudioRecorderHandle {
  retranscribe(recording: StoppedAudioRecording): Promise<AudioRetranscription>;
}

export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function claimFileAudioSource(store: MinutesStore, meetingId: number, path: string): {
  duplicateMeetingId: number | null;
  sha256: string;
  byteLength: number;
} {
  const byteLength = statSync(path).size;
  const sha256 = sha256File(path);
  const existing = store.findMeetingByAudioHash(sha256);
  if (existing !== null) return { duplicateMeetingId: existing, sha256, byteLength };
  try {
    store.addAudioSource(meetingId, { originalAudioSha256: sha256, originalAudioPath: path, byteLength });
    return { duplicateMeetingId: null, sha256, byteLength };
  } catch (error) {
    const collision = store.findMeetingByAudioHash(sha256);
    if (collision !== null) return { duplicateMeetingId: collision, sha256, byteLength };
    throw error;
  }
}

function recorderArgs(bin: string, captureId: number, outputPath: string): string[] {
  const name = basename(bin).toLowerCase();
  if (name.includes("ffmpeg")) {
    const input = captureId < 0 ? ":default" : `:${captureId}`;
    return ["-nostdin", "-hide_banner", "-loglevel", "error", "-progress", "pipe:2", "-nostats",
      "-f", "avfoundation", "-i", input,
      "-acodec", "pcm_s16le", "-y", outputPath];
  }
  if (name === "rec" || name.includes("sox")) return ["-q", "-d", outputPath];
  throw new Error(`unsupported audio recorder: ${bin}`);
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
}

export function describeStoppedAudio(path: string): StoppedAudioRecording {
  if (!existsSync(path)) throw new Error("audio recorder did not create output");
  const stat = statSync(path);
  const header = Buffer.alloc(4);
  const fd = openSync(path, "r");
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  if (stat.size <= 44 || header.toString("ascii") !== "RIFF") {
    throw new Error("audio recorder output is not a valid WAV");
  }
  return { path, sha256: sha256File(path), byteLength: stat.size };
}

async function terminateRecorder(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let settleTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      proc.off("close", finish);
      proc.off("error", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      settleTimer = setTimeout(finish, 250);
    }, 5_000);
    proc.once("close", finish);
    proc.once("error", finish);
    proc.kill("SIGTERM");
  });
}

export class RawAudioRecorder implements AudioRecorderHandle {
  private constructor(private readonly proc: ChildProcess, private readonly outputPath: string) {}

  static async start(input: {
    bin: string; captureId: number; outputPath: string; startupTimeoutMs?: number;
  }): Promise<RawAudioRecorder> {
    removeIfPresent(input.outputPath);
    const targetName = basename(input.outputPath);
    const { promise: outputCreated, resolve: created } = Promise.withResolvers<void>();
    // fs.watch(FSEvents).close()가 macOS/bun에서 이벤트 루프를 5-10초 블록하는
    // 스톨이 있어 폴링으로 대체한다. clearInterval은 항상 O(1)이라 종료 경로를
    // 막지 않는다. stderr의 progress 라인이 1차 신호이고 폴링은 보조 신호다.
    const pollTimer = setInterval(() => {
      if (existsSync(input.outputPath)) created();
    }, 150);
    let watcherClosed = false;
    const closeWatcher = () => {
      if (watcherClosed) return;
      watcherClosed = true;
      clearInterval(pollTimer);
    };
    const proc = spawn(input.bin, recorderArgs(input.bin, input.captureId, input.outputPath), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderrTail = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrTail = `${stderrTail}${text}`.slice(-2_000);
      if (/^progress=(?:continue|end)$/m.test(text)
          && existsSync(input.outputPath)
          && statSync(input.outputPath).size > 0) {
        created();
      }
    });
    const stderrReason = () => stderrTail.trim() ? `: ${stderrTail.trim()}` : "";
    const outputState = () => existsSync(input.outputPath)
      ? `output exists (${statSync(input.outputPath).size} bytes)`
      : "output missing";
    try {
      await new Promise<void>((resolve, reject) => {
        const timeoutMs = input.startupTimeoutMs ?? 5_000;
        const timer = setTimeout(() => reject(
          new Error(`audio recorder did not create output within ${timeoutMs}ms; ${outputState()}${stderrReason()}`),
        ), timeoutMs);
        const finish = (fn: () => void) => {
          clearTimeout(timer);
          proc.off("error", onError);
          proc.off("close", onClose);
          closeWatcher();
          fn();
        };
        const onError = (error: Error) => finish(() => reject(error));
        const onClose = () => finish(() => reject(
          new Error(`audio recorder exited before creating output${stderrReason()}`),
        ));
        proc.once("error", onError);
        proc.once("close", onClose);
        outputCreated.then(() => finish(resolve), (error) => finish(() => reject(error)));
      });
      return new RawAudioRecorder(proc, input.outputPath);
    } catch (error) {
      closeWatcher();
      await terminateRecorder(proc);
      removeIfPresent(input.outputPath);
      throw error;
    }
  }

  async stop(): Promise<StoppedAudioRecording> {
    try {
      await terminateRecorder(this.proc);
      return describeStoppedAudio(this.outputPath);
    } catch (error) {
      removeIfPresent(this.outputPath);
      throw error;
    }
  }
}
