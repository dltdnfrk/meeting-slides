import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PCM_CHUNK_SAMPLES, PCM_SAMPLE_RATE, PcmIngest, writeMonoWav } from "../src/pcm-ingest.ts";

function float32Chunk(value: number, samples = PCM_CHUNK_SAMPLES): Float32Array {
  return Float32Array.from({ length: samples }, () => value);
}

function encode(samples: Float32Array): string {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
}

describe("PcmIngest", () => {
  test("Given float32 PCM, When a full chunk arrives, Then next yields those samples", async () => {
    const ingest = new PcmIngest();
    const samples = float32Chunk(0.25);
    ingest.appendBase64(encode(samples));
    const chunk = await ingest.next();
    expect(chunk).toEqual(samples);
  });

  test("Given a short tail, When finished, Then the aligned remainder is emitted once", async () => {
    const ingest = new PcmIngest();
    ingest.appendBase64(encode(float32Chunk(0.5, 4)));
    ingest.finish();
    expect((await ingest.next())?.length).toBe(4);
    expect(await ingest.next()).toBeNull();
  });

  test("Given invalid or oversized audio, When appended, Then it is rejected", () => {
    const ingest = new PcmIngest();
    expect(() => ingest.appendBase64("@@@")).toThrow("Invalid PCM payload");
    expect(() => ingest.appendBase64(Buffer.alloc(3).toString("base64"))).toThrow("Invalid PCM payload");
    const huge = Buffer.alloc(16_000 * 4 * 3).toString("base64");
    expect(() => ingest.appendBase64(huge)).toThrow("PCM payload too large");
  });

  test("Given ingested samples, When finished to a wav path, Then the file is a mono 16 kHz WAV", async () => {
    const root = mkdtempSync(join(tmpdir(), "pcm-wav-"));
    const outputPath = join(root, "meeting.wav");
    try {
      const ingest = new PcmIngest({ outputPath });
      ingest.appendBase64(encode(float32Chunk(0.5, 16_000)));
      ingest.finish();
      while (await ingest.next() !== null) { /* drain live queue */ }
      await ingest.finalizeWav();
      const bytes = readFileSync(outputPath);
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(bytes.readUInt16LE(22)).toBe(1);
      expect(bytes.readUInt32LE(24)).toBe(16_000);
      expect(bytes.byteLength).toBeGreaterThan(44);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("Given a transcription window longer than one frame, When written, Then the WAV holds every sample", () => {
    const root = mkdtempSync(join(tmpdir(), "pcm-window-"));
    const outputPath = join(root, "window.wav");
    try {
      const window = float32Chunk(0.5, PCM_SAMPLE_RATE * 5);
      writeMonoWav(outputPath, window);
      const bytes = readFileSync(outputPath);
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(bytes.readUInt32LE(24)).toBe(PCM_SAMPLE_RATE);
      expect(bytes.readUInt32LE(40)).toBe(window.length * 2);
      expect(bytes.byteLength).toBe(44 + window.length * 2);
      expect(bytes.readInt16LE(44)).toBe(Math.round(0.5 * 32767));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
