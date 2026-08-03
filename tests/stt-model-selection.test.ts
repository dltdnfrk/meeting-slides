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
  test("serializes concurrent selects, persists the installed model, and restarts active capture once per change", async () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-stt-select-"));
    const modelDir = join(root, "models", "stt");
    const settings = new SttModelSettingsStore(root);
    const small = artifact("small", "small.bin");
    const medium = artifact("medium", "medium.bin");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, small.fileName), "small");
    writeFileSync(join(modelDir, medium.fileName), "mediu");
    const manager = new SttModelManager(modelDir, settings, [small, medium]);

    const releases: Array<() => void> = [];
    let resolveStopInvocation: ((value: void | PromiseLike<void>) => void) | null = null;
    let concurrentStops = 0;
    let maxConcurrentStops = 0;
    const events: string[] = [];
    const selectSttModel = createSelectSttModel(manager, {
      isCapturing: () => true,
      stopCapture: async () => {
        events.push("stop");
        concurrentStops += 1;
        maxConcurrentStops = Math.max(maxConcurrentStops, concurrentStops);
        resolveStopInvocation?.();
        await new Promise<void>((resolve) => { releases.push(resolve); });
        concurrentStops -= 1;
      },
      startCapture: async () => {
        events.push("start");
      },
      rebuildCapture: () => {
        events.push("rebuild");
      },
    });

    const waitForNextStopInvocation = async () =>
      await Promise.race([
        new Promise<void>((resolve) => {
          resolveStopInvocation = resolve;
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("stopCapture invocation timeout")), 5_000);
        }),
      ]);

    const firstStopInvoked = waitForNextStopInvocation();
    const first = selectSttModel("medium");
    await firstStopInvoked;
    releases.shift()?.();

    const secondStopInvoked = waitForNextStopInvocation();
    const second = selectSttModel("small");
    await secondStopInvoked;
    releases.shift()?.();

    await first;
    await second;

    expect(maxConcurrentStops).toBe(1);
    expect(settings.load()).toEqual({ version: 1, selectedModelId: "small" });
    expect(manager.selectedPath()).toBe(join(modelDir, small.fileName));
    expect(events).toEqual(["stop", "rebuild", "start", "stop", "rebuild", "start"]);
    rmSync(root, { recursive: true, force: true });
  });
});
