// Isolated process: native/model mocks must not replace imports in other tests.
import { mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";
import { CaptureFinalizer, TranscriptVersionWriter } from "../src/transcript-versioning.ts";
import type { TranscriptChunk } from "../src/whisper.ts";

const scenario = process.argv[2];
const maxAudioMs = scenario === "unlimited" ? 0 : 500;
const sampleCount = scenario === "empty" ? 0
  : scenario === "overflow" || scenario === "fallback" ? 24_000
  : scenario === "tail-overflow" ? 8_001
  : scenario === "unlimited" ? 24_000 : 8_000;
const input = Float32Array.from({ length: sampleCount }, (_, index) => index / 32_000);
let sessionDisposals = 0;
let modelDisposals = 0;
let runCalls = 0;
let reads = 0;
let kills = 0;
let sessionCreated = false;
let sessionReadyAtSpawn = false;
const nativeFailure = new Error("NATIVE_RUN_FAILURE");

mock.module("transcribe-cpp", () => ({
  TranscribeModel: class {
    static async load() {
      return {
        capabilities: { languages: ["ko"], supportsStreaming: true },
        backend: "cpu",
        createSession() {
          sessionCreated = true;
          return {
            limits: { effectiveMaxAudioMs: maxAudioMs },
            async run(pcm: Float32Array) {
              runCalls += 1;
              assert.deepEqual(pcm, input);
              if (scenario === "run-error") throw nativeFailure;
              return { text: "batch-result", segments: [] };
            },
            dispose() { sessionDisposals += 1; },
          };
        },
        dispose() { modelDisposals += 1; },
      };
    }
  },
}));

class DecoderProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exitCode = null;
  signalCode: NodeJS.Signals | null = null;
  kill() {
    kills += 1;
    this.signalCode = "SIGTERM";
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}
const proc = new DecoderProcess();
mock.module("node:child_process", () => ({
  ...childProcess,
  spawn() {
    sessionReadyAtSpawn = sessionCreated;
    queueMicrotask(() => proc.stdout.end(Buffer.from(input.buffer)));
    return proc;
  },
}));
const { TranscribeCLI, TranscribeStream, PcmReader, disposeTranscribeModelCache } =
  await import("../src/transcribe.ts");
const originalNext = PcmReader.prototype.next;
const next = spyOn(PcmReader.prototype, "next").mockImplementation(function (this: InstanceType<typeof PcmReader>) {
  reads += 1;
  return originalNext.call(this);
});
const config = { modelPath: "fake.gguf", captureId: -1, threads: 1, gpu: false, ffmpegBin: "fake-ffmpeg" };
const chunks: TranscriptChunk[] = [];
const cli = new TranscribeCLI(config, "preserved.wav");

try {
  if (scenario === "fallback") {
    // Real finalization/store integration: over-limit second pass retains live canonical text.
    const legacy = new MeetingStore(":memory:");
    try {
      const store = new MinutesStore(legacy.databaseHandle());
      const meetingId = legacy.startMeeting("bounded-transcription");
      store.registerCapturingMeeting(meetingId);
      const writer = new TranscriptVersionWriter(store);
      const live = writer.begin(meetingId, { sourceKind: "live_capture" });
      writer.append({ ts: 1_000, text: "preserved-live-text" });
      const recording = { path: "preserved.wav", sha256: "a".repeat(64), byteLength: 48_044 };
      const stream = new TranscribeStream(config);
      const result = await new CaptureFinalizer(store, writer, meetingId, {
        stop: async () => recording,
        retranscribe: (audio) => stream.retranscribe(audio),
      }).finish();
      assert.equal(result.retranscription.status, "failed");
      assert.equal(result.audio.status, "available");
      assert.equal(store.canonicalVersion(meetingId)?.transcriptVersionId, live.transcriptVersionId);
      assert.equal(store.transcriptVersionLines(live.transcriptVersionId)[0]?.text, "preserved-live-text");
      assert.equal(reads, 2, "second pass must stop at the first overflowing chunk, not EOF");
      assert.equal(runCalls, 0);
    } finally {
      legacy.close();
    }
  } else if (scenario === "overflow" || scenario === "tail-overflow") {
    await assert.rejects(cli.start({ onChunk: (chunk) => chunks.push(chunk) }));
    assert.equal(reads, 2, "batch must stop at the first overflowing chunk, not EOF");
    assert.equal(runCalls, 0);
    assert.deepEqual(chunks, []);
  } else if (scenario === "empty" || scenario === "run-error") {
    await assert.rejects(cli.start({ onChunk: (chunk) => chunks.push(chunk) }),
      (error: unknown) => scenario === "run-error" ? error === nativeFailure : error instanceof Error);
    assert.equal(runCalls, scenario === "run-error" ? 1 : 0);
  } else {
    await cli.start({ onChunk: (chunk) => chunks.push(chunk) });
    assert.equal(runCalls, 1);
    assert.deepEqual(chunks.map(({ text, audioStartMs, audioEndMs }) => ({ text, audioStartMs, audioEndMs })),
      [{ text: "batch-result", audioStartMs: 0, audioEndMs: sampleCount / 16 }]);
  }
  assert.equal(sessionReadyAtSpawn, true, "session limits must be available before decoding");
  assert.equal(sessionDisposals, 1);
  assert.equal(kills, 1, "owned decoder must be stopped on success and failure");
  disposeTranscribeModelCache();
  await Promise.resolve();
  assert.equal(modelDisposals, 1, "batch must release its model lease");
  console.log(`TRANSCRIBE_SCENARIO_OK ${scenario}`);
} finally {
  next.mockRestore();
}
