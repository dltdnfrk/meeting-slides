import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  PCM_READER_HIGH_WATER_CHUNKS,
  PCM_READER_LOW_WATER_CHUNKS,
  PcmReader,
  transcribePcmArgs,
} from "../src/transcribe.ts";

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
}

describe("PcmReader resource bounds", () => {
  test("one ffmpeg input tees the mic PCM to live STT and the canonical WAV", () => {
    const args = transcribePcmArgs({
      modelPath: "/models/qwen.gguf",
      captureId: 4,
      threads: 4,
      gpu: true,
      ffmpegBin: "ffmpeg",
      audioOutputPath: "/archive/meeting.wav",
    }, null);
    expect(args.filter((value) => value === "avfoundation")).toHaveLength(1);
    expect(args.filter((value) => value === "[0:a]asplit=2[stt][archive]")).toHaveLength(1);
    expect(args).toContain("pipe:1");
    expect(args.at(-1)).toBe("/archive/meeting.wav");
  });

  test("pauses at the high-water mark, resumes at low water, and preserves every sample", async () => {
    const proc = new FakeProcess();
    const errors: Error[] = [];
    const reader = new PcmReader(proc as unknown as ChildProcess, (error) => errors.push(error));
    const input = new Float32Array(PCM_READER_HIGH_WATER_CHUNKS * 8_000 + 4 * 8_000);
    for (let chunk = 0; chunk < 20; chunk += 1) input.fill(chunk, chunk * 8_000, (chunk + 1) * 8_000);
    proc.stdout.end(Buffer.from(input.buffer));
    expect(proc.stdout.isPaused()).toBe(true);

    const first: Float32Array[] = [];
    for (let index = 0; index < PCM_READER_HIGH_WATER_CHUNKS - PCM_READER_LOW_WATER_CHUNKS; index += 1) {
      first.push((await reader.next())!);
    }
    const chunks = [...first];
    for (;;) {
      const chunk = await reader.next();
      if (chunk === null) break;
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(20);
    expect(chunks.map((chunk) => chunk[0])).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(chunks.every((chunk) => chunk.length === 8_000)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("emits an aligned tail once when error and stream end both fire", async () => {
    const proc = new FakeProcess();
    const reader = new PcmReader(proc as unknown as ChildProcess, () => {});
    const ended = new Promise((resolve) => proc.stdout.once("end", resolve));
    proc.stdout.end(Buffer.from([1, 2, 3, 4, 5, 6]));
    await ended;
    proc.emit("error", new Error("duplicate terminal event"));
    expect((await reader.next())?.length).toBe(1);
    expect(await reader.next()).toBeNull();
  });
});

describe("TranscribeCLI public runtime", () => {
  test("imports the installed binding without mocks", async () => {
    const proc = Bun.spawn([process.execPath, "-e",
      'await import("./src/transcribe.ts"); console.log("TRANSCRIBE_IMPORT_OK")'],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout.trim()).toBe("TRANSCRIBE_IMPORT_OK");
  });

  test.each(["overflow", "tail-overflow", "exact", "unlimited", "empty", "run-error", "fallback"])(
    "bounds batch input and disposes resources: %s", async (scenario) => {
      const proc = Bun.spawn([process.execPath, new URL("./transcribe-batch-scenario.ts", import.meta.url).pathname, scenario],
        { stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout.trim()).toBe(`TRANSCRIBE_SCENARIO_OK ${scenario}`);
    }, 10_000,
  );
});
