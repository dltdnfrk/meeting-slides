import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SttModelManager } from "../src/stt-model-downloader.ts";
import { createSelectSttModel } from "../src/stt-model-selection.ts";
import { SttModelSettingsStore } from "../src/stt-model-settings.ts";
import type { SttModelArtifact } from "../src/stt-model-catalog.ts";

function artifact(id: "small" | "medium", fileName: `${string}.bin`): SttModelArtifact {
  return {
    id,
    label: id,
    fileName,
    url: "http://127.0.0.1/model",
    sizeBytes: 5,
    sha256: "0".repeat(64),
    xetEtag: "0".repeat(64),
    license: "MIT",
  };
}

describe("STT selection controller", () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "meeting-stt-select-"));
    const modelDir = join(root, "models", "stt");
    const settings = new SttModelSettingsStore(root);
    const small = artifact("small", "small.bin");
    const medium = artifact("medium", "medium.bin");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, small.fileName), "small");
    writeFileSync(join(modelDir, medium.fileName), "mediu");
    return { root, modelDir, settings, manager: new SttModelManager(modelDir, settings, [small, medium]) };
  }

  test("rejects model changes during capture without splitting the meeting", async () => {
    const value = fixture();
    const events: string[] = [];
    const select = createSelectSttModel(value.manager, {
      isCapturing: () => true,
      stopCapture: async () => { events.push("stop"); },
      startCapture: async () => { events.push("start"); },
      rebuildCapture: () => { events.push("rebuild"); },
    });
    await expect(select("medium")).rejects.toThrow("녹음을 중지");
    expect(events).toEqual([]);
    expect(value.settings.load()).toBeNull();
    rmSync(value.root, { recursive: true, force: true });
  });

  test("serializes idle selections and persists the latest installed model", async () => {
    const value = fixture();
    const events: string[] = [];
    const select = createSelectSttModel(value.manager, {
      isCapturing: () => false,
      stopCapture: async () => { events.push("stop"); },
      startCapture: async () => { events.push("start"); },
      rebuildCapture: () => { events.push("rebuild"); },
    });
    await Promise.all([select("medium"), select("small")]);
    expect(value.settings.load()).toEqual({ version: 1, selectedModelId: "small" });
    expect(value.manager.selectedPath()).toBe(join(value.modelDir, "small.bin"));
    expect(events).toEqual(["rebuild", "rebuild"]);
    rmSync(value.root, { recursive: true, force: true });
  });
});
