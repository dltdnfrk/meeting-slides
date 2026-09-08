import { describe, expect, test } from "bun:test";

import { whisperCliArgv, whisperVocabularyPrompt } from "../src/whisper.ts";

describe("whisperVocabularyPrompt", () => {
  test("returns null when every name is blank", () => {
    expect(whisperVocabularyPrompt(["", "  "])).toBeNull();
  });

  test("joins unique trimmed attendee names for the whisper.cpp initial prompt", () => {
    expect(whisperVocabularyPrompt(["  김민아  ", "김민아", "Mina Kim"])).toBe("김민아, Mina Kim");
  });
});

describe("whisperCliArgv", () => {
  const base = {
    modelPath: "model.bin",
    filePath: "/tmp/meeting.wav",
    threads: 4,
    gpu: true,
    diarize: false,
    initialPrompt: null as string | null,
  };

  test("keeps the existing file-transcription flags when no vocabulary is supplied", () => {
    expect(whisperCliArgv(base)).toEqual([
      "-m", "model.bin",
      "-l", "ko",
      "-t", "4",
      "-f", "/tmp/meeting.wav",
    ]);
  });

  test("passes --prompt only when the vocabulary string is non-blank", () => {
    expect(whisperCliArgv({ ...base, initialPrompt: "김민아, Mina Kim" })).toEqual([
      "-m", "model.bin",
      "-l", "ko",
      "-t", "4",
      "-f", "/tmp/meeting.wav",
      "--prompt", "김민아, Mina Kim",
    ]);
    expect(whisperCliArgv({ ...base, initialPrompt: "  " }).includes("--prompt")).toBe(false);
  });

  test("disables GPU and enables tinydiarize with the same flags as WhisperCLI.start", () => {
    expect(whisperCliArgv({ ...base, gpu: false, diarize: true })).toEqual([
      "-m", "model.bin",
      "-l", "ko",
      "-t", "4",
      "-f", "/tmp/meeting.wav",
      "-ng",
      "-tdrz",
    ]);
  });
});
