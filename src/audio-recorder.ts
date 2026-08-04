import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, readFileSync, rmSync, statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

import type { MinutesStore } from "./minutes-store.ts";

export interface StoppedAudioRecording {
  path: string;
  sha256: string;
  byteLength: number;
}

export interface AudioRecorderHandle {
  stop(): Promise<StoppedAudioRecording>;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
    return ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", input,
      "-acodec", "pcm_s16le", "-y", outputPath];
  }
  if (name === "rec" || name.includes("sox")) return ["-q", "-d", outputPath];
  throw new Error(`unsupported audio recorder: ${bin}`);
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
}

async function terminateRecorder(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off("close", finish);
      proc.off("error", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
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
    const { promise: outputCreated, resolve: created, reject: createFailed } = Promise.withResolvers<void>();
    const watcher = watch(dirname(input.outputPath), (_event, filename) => {
      if (filename === targetName && existsSync(input.outputPath)) created();
    });
    watcher.once("error", createFailed);
    let watcherClosed = false;
    const closeWatcher = () => {
      if (watcherClosed) return;
      watcherClosed = true;
      watcher.close();
    };
    const proc = spawn(input.bin, recorderArgs(input.bin, input.captureId, input.outputPath), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeoutMs = input.startupTimeoutMs ?? 5_000;
        const timer = setTimeout(() => reject(
          new Error(`audio recorder did not create output within ${timeoutMs}ms`),
        ), timeoutMs);
        const finish = (fn: () => void) => {
          clearTimeout(timer);
          proc.off("error", onError);
          proc.off("close", onClose);
          closeWatcher();
          fn();
        };
        const onError = (error: Error) => finish(() => reject(error));
        const onClose = () => finish(() => reject(new Error("audio recorder exited before creating output")));
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
      if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGTERM");
      await new Promise<void>((resolve, reject) => {
        if (this.proc.exitCode !== null || this.proc.signalCode !== null) return resolve();
        const timer = setTimeout(() => {
          this.proc.kill("SIGKILL");
          reject(new Error("audio recorder did not stop within 5 seconds"));
        }, 5_000);
        this.proc.once("close", () => { clearTimeout(timer); resolve(); });
        this.proc.once("error", (error) => { clearTimeout(timer); reject(error); });
      });
      if (!existsSync(this.outputPath)) throw new Error("audio recorder did not create output");
      const stat = statSync(this.outputPath);
      const header = Buffer.alloc(4);
      const stream = createReadStream(this.outputPath, { start: 0, end: 3 });
      let offset = 0;
      for await (const chunk of stream) offset += (chunk as Buffer).copy(header, offset);
      if (stat.size <= 44 || header.toString("ascii") !== "RIFF") {
        throw new Error("audio recorder output is not a valid WAV");
      }
      return { path: this.outputPath, sha256: sha256File(this.outputPath), byteLength: stat.size };
    } catch (error) {
      removeIfPresent(this.outputPath);
      throw error;
    }
  }
}
