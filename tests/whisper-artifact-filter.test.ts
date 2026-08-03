import { describe, expect, test } from "bun:test";

import { WhisperStream, type TranscriptChunk } from "../src/whisper.ts";
import type { WhisperConfig } from "../src/config.ts";

class FilterHarness extends WhisperStream {
  feed(text: string): TranscriptChunk[] {
    const chunks: TranscriptChunk[] = [];
    this.buf += `${text}\n`;
    this.drain((chunk) => chunks.push(chunk));
    return chunks;
  }
}

const config: WhisperConfig = {
  streamBin: "whisper-stream",
  cliBin: "whisper-cli",
  modelPath: "model.bin",
  captureId: 0,
  threads: 1,
  stepMs: 3000,
  diarize: false,
  tdrzModelPath: "tdrz.bin",
};

describe("existing Whisper artifact filters", () => {
  test("metadata and runtime banners never become transcript chunks", () => {
    const whisper = new FilterHarness(config);
    const artifacts = [
      "[Start speaking]", "[BLANK_AUDIO]", "(silence)", "[잡음]",
      "ggml_metal_init: GPU device", "whisper_init_from_file: loading model",
      "system_info: n_threads = 8", "main: processing audio", "Loading model.bin",
    ];
    expect(artifacts.flatMap((line) => whisper.feed(line))).toEqual([]);
  });

  test("timestamp wrappers are stripped while actual speech remains", () => {
    const whisper = new FilterHarness(config);
    expect(whisper.feed("[00:00:00.000 --> 00:00:02.000] 실제 회의 발언입니다.")).toEqual([
      expect.objectContaining({ text: "실제 회의 발언입니다." }),
    ]);
  });
});
