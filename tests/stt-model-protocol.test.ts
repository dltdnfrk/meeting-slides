import { describe, expect, test } from "bun:test";

import { sttModelsMessage, toSttModelInfo } from "../src/stt-model-protocol.ts";
import type { SttModelState } from "../src/stt-model-downloader.ts";
import { STT_MODEL_CATALOG } from "../src/stt-model-catalog.ts";

describe("STT protocol", () => {
  test("projects model manager states into a deterministic typed payload", () => {
    const small = STT_MODEL_CATALOG.find((model) => model.id === "small")!;
    const medium = STT_MODEL_CATALOG.find((model) => model.id === "medium")!;
    const states: SttModelState[] = [
      { status: "selected", model: small, path: "/models/stt/small.bin" },
      { status: "downloading", model: medium, receivedBytes: 10, totalBytes: 100 },
      { status: "failed", model: STT_MODEL_CATALOG.find((model) => model.id === "large-v3")!, error: "boom" },
      { status: "absent", model: STT_MODEL_CATALOG.find((model) => model.id === "large-v3-turbo")! },
    ];

    expect(toSttModelInfo(states[0])).toEqual({
      id: "small",
      label: small.label,
      sizeBytes: small.sizeBytes,
      license: "MIT",
      status: "selected",
      path: "/models/stt/small.bin",
    });

    expect(sttModelsMessage(states)).toEqual({
      type: "sttModels",
      selectedModelId: "small",
      models: [
        { id: "small", label: small.label, sizeBytes: small.sizeBytes, license: "MIT", status: "selected", path: "/models/stt/small.bin" },
        { id: "medium", label: medium.label, sizeBytes: medium.sizeBytes, license: "MIT", status: "downloading", receivedBytes: 10, totalBytes: 100 },
        { id: "large-v3-turbo", label: "Large v3 Turbo (Q8_0)", sizeBytes: 874_188_075, license: "MIT", status: "absent" },
        { id: "large-v3", label: "Large v3 (Q8_0)", sizeBytes: 1_656_538_283, license: "Apache-2.0", status: "failed", error: "boom" },
      ],
    });
  });

  test("emits null selectedModelId when nothing is selected", () => {
    const states = STT_MODEL_CATALOG.map((model) => ({ status: "absent", model } as const));
    expect(sttModelsMessage(states).selectedModelId).toBeNull();
  });
});
