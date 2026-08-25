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
  restartParser(): void { this.resetRunState(); }
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

  test("a new capture resets duplicate and speaker parser state", () => {
    const whisper = new FilterHarness({ ...config, diarize: true });
    expect(whisper.feed("첫 회의 문장입니다. [SPEAKER_TURN]")[0]).toMatchObject({ speaker: 1 });
    expect(whisper.feed("두 번째 화자입니다.")[0]).toMatchObject({ speaker: 2 });
    whisper.restartParser();
    expect(whisper.feed("첫 회의 문장입니다.")[0]).toMatchObject({ speaker: 1, text: "첫 회의 문장입니다." });
  });
});
