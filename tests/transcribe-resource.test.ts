import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  PCM_READER_HIGH_WATER_CHUNKS,
  PCM_READER_LOW_WATER_CHUNKS,
  PcmReader,
} from "../src/transcribe.ts";

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
}

describe("PcmReader resource bounds", () => {
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
    proc.stdout.end(Buffer.from([1, 2, 3, 4, 5, 6]));
    await new Promise((resolve) => proc.stdout.once("end", resolve));
    proc.emit("error", new Error("duplicate terminal event"));
    expect((await reader.next())?.length).toBe(1);
    expect(await reader.next()).toBeNull();
  });
});
