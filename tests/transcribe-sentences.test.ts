import { describe, expect, mock, test } from "bun:test";

import type { TranscribeConfig } from "../src/transcribe.ts";
import type { TranscriptChunk } from "../src/whisper.js";

// transcribe.ts가 native 바인딩을 로드하기 전에 모듈을 가짜로 바꿔준다.
// (test 본문에서 transcribe.ts를 dynamic import하는 이유)
mock.module("transcribe-cpp", () => {
  let committed = "";
  let tentative = "";

  const fakeStream = {
    get text() {
      return { full: committed + tentative, committed, tentative };
    },
    async feed() {
      return {
        resultChanged: false,
        isFinal: false,
        revision: 0,
        inputReceivedMs: 0,
        audioCommittedMs: 0,
        bufferedMs: 0,
        committedChanged: false,
        tentativeChanged: false,
      };
    },
    async finalize() {
      committed = "안녕하세요";
      tentative = " 여러분";
      return {
        resultChanged: false,
        isFinal: true,
        revision: 1,
        inputReceivedMs: 0,
        audioCommittedMs: 0,
        bufferedMs: 0,
        committedChanged: true,
        tentativeChanged: true,
      };
    },
    reset() {},
  };

  const fakeSession = {
    limits: { effectiveNCtx: 0, effectiveMaxAudioMs: 0, maxKvBytes: 0 },
    async stream() {
      return fakeStream;
    },
    dispose() {},
  };

  const fakeModel = {
    capabilities: {
      nativeSampleRate: 16_000,
      languages: ["ko"],
      translateTargetLanguages: [],
      maxTimestampKind: "segment",
      supportsLanguageDetect: false,
      supportsTranslate: false,
      supportsStreaming: true,
      supportsSpecDecode: false,
      maxAudioMs: 0,
    },
    variant: "fake-variant",
    backend: "cpu",
    createSession() {
      return fakeSession;
    },
    dispose() {},
  };

  return {
    TranscribeModel: class {
      static async load(): Promise<typeof fakeModel> {
        return fakeModel;
      }
    },
  };
});

const config: TranscribeConfig = {
  modelPath: "models/fake.bin",
  captureId: -1,
  threads: 1,
  gpu: false,
  // stdout을 즉시 닫고 종료하는 무해한 바이너리 → PcmReader가 null을 반환.
  ffmpegBin: "/usr/bin/true",
};

describe("transcribe.cpp 문장 분할", () => {
  test("감사합니다 여러분 stays one sentence while 끝났습니다. 다음은 splits at the period", async () => {
    const { TranscribeStream } = await import("../src/transcribe.ts");
    class Probe extends TranscribeStream {
      readonly emitted: TranscriptChunk[] = [];
      split(text: string): void {
        this.emitSentences(text, (chunk) => this.emitted.push(chunk));
      }
    }

    // Given: 어미가 종결부호처럼 보이는 한국어 문장과, 마침표로 끝난 문장 뒤 새 문장
    const probe = new Probe(config);

    // When: 두 텍스트를 문장 분할기에 넣는다
    probe.split("감사합니다 여러분");
    probe.split("끝났습니다. 다음은");

    // Then: '감사합니다 여러분'은 한 문장이고, 마침표 경계에서만 나뉜다
    expect(probe.emitted.map((c) => c.text)).toEqual([
      "감사합니다 여러분",
      "끝났습니다.",
      "다음은",
    ]);
  });

  test("finalize emits only committed text", async () => {
    const { TranscribeStream } = await import("../src/transcribe.ts");
    const chunks: TranscriptChunk[] = [];

    // Given: finalize 시점에 committed='안녕하세요', tentative=' 여러분'이 남아 있는 스트림
    // When: 스트리밍을 시작했다가 중단한다 (finalize까지 수행)
    await new TranscribeStream(config).start({
      onChunk: (chunk) => chunks.push(chunk),
    });

    // Then: 확정(committed) 텍스트만 방출되고, tentative 꼬리는 버려진다
    expect(chunks.map((c) => c.text)).toEqual(["안녕하세요"]);
  });
});
