import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STT_MODEL_CATALOG, type SttModelArtifact } from "../src/stt-model-catalog.ts";
import { downloadSttModel, SttModelManager } from "../src/stt-model-downloader.ts";
import { SttModelSettingsStore } from "../src/stt-model-settings.ts";

const payload = new TextEncoder().encode("verified whisper payload");
const payloadSha256 = createHash("sha256").update(payload).digest("hex");

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/redirect") return Response.redirect(new URL("/model", request.url), 307);
    if (path === "/model") {
      let offset = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= payload.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 5, payload.length);
          controller.enqueue(payload.slice(offset, end));
          offset = end;
        },
      }), { headers: { "content-length": String(payload.length) } });
    }
    if (path === "/corrupt") {
      const corrupt = payload.slice();
      corrupt[0] ^= 0xff;
      return new Response(corrupt, { headers: { "content-length": String(corrupt.length) } });
    }
    if (path === "/cancel") {
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(payload.slice(0, 5));
          }
        },
      }), { headers: { "content-length": String(payload.length) } });
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => server.stop(true));

function artifact(path = "/model"): SttModelArtifact {
  return {
    id: "small",
    label: "Test Q8_0",
    backend: "whisper",
    fileName: "ggml-test-q8_0.bin",
    url: new URL(path, server.url).href,
    sizeBytes: payload.length,
    sha256: payloadSha256,
    xetEtag: "0".repeat(64),
    license: "MIT",
  };
}

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "meeting-stt-"));
}

function partials(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.includes(".part-")) : [];
}

describe("STT model catalog", () => {
  test("contains the exact whisper.cpp and transcribe.cpp payloads", () => {
    expect(STT_MODEL_CATALOG.map(({ id, fileName, sizeBytes, sha256, license }) => ({ id, fileName, sizeBytes, sha256, license }))).toEqual([
      {
        id: "small",
        fileName: "ggml-small-q8_0.bin",
        sizeBytes: 264_464_607,
        sha256: "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f",
        license: "MIT",
      },
      {
        id: "medium",
        fileName: "ggml-medium-q8_0.bin",
        sizeBytes: 823_369_779,
        sha256: "42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502",
        license: "MIT",
      },
      {
        id: "large-v3-turbo",
        fileName: "ggml-large-v3-turbo-q8_0.bin",
        sizeBytes: 874_188_075,
        sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
        license: "MIT",
      },
      {
        id: "large-v3",
        fileName: "ggml-large-v3-q8_0.bin",
        sizeBytes: 1_656_538_283,
        sha256: "24bc434f372355688ab9a623077a63e5361a1c41f4d8d648977e39f9b060f09e",
        license: "Apache-2.0",
      },
      {
        id: "nemotron-3.5",
        fileName: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
        sizeBytes: 751_094_240,
        sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
        license: "OpenMDW-1.1",
      },
      {
        id: "qwen3-asr-0.6b",
        fileName: "Qwen3-ASR-0.6B-Q8_0.gguf",
        sizeBytes: 850_423_456,
        sha256: "f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8",
        license: "Apache-2.0",
      },
      {
        id: "qwen3-asr-1.7b",
        fileName: "Qwen3-ASR-1.7B-Q8_0.gguf",
        sizeBytes: 2_185_030_624,
        sha256: "9a0d81792dfea2d5f278b8a63deb3ea6e02139ce42c2301f32ea19c4f77526b7",
        license: "Apache-2.0",
      },
    ]);
  });

  test("tags whisper artifacts and transcribe artifacts with their backends", () => {
    expect(STT_MODEL_CATALOG.filter((m) => m.backend === "whisper").map((m) => m.id))
      .toEqual(["small", "medium", "large-v3-turbo", "large-v3"]);
    expect(STT_MODEL_CATALOG.filter((m) => m.backend === "transcribe").map((m) => m.id))
      .toEqual(["nemotron-3.5", "qwen3-asr-0.6b", "qwen3-asr-1.7b"]);
    for (const model of STT_MODEL_CATALOG) {
      const expectedExt = model.backend === "whisper" ? ".bin" : ".gguf";
      expect(model.fileName.endsWith(expectedExt)).toBe(true);
    }
  });
});

describe("STT model downloader", () => {
  test("streams progress, follows redirects, verifies the LFS SHA-256, and atomically installs", async () => {
    const root = temporaryRoot();
    const destination = join(root, "models", "ggml-test-q8_0.bin");
    const progress: number[] = [];
    try {
      await downloadSttModel(artifact("/redirect"), destination, {
        onProgress(received) { progress.push(received); },
      });
      expect(new Uint8Array(readFileSync(destination))).toEqual(payload);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.at(-1)).toBe(payload.length);
      expect(partials(join(root, "models"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a wrong payload checksum without replacing an installed file or retaining partials", async () => {
    const root = temporaryRoot();
    const destination = join(root, "ggml-test-q8_0.bin");
    const original = new TextEncoder().encode("existing model");
    writeFileSync(destination, original);
    try {
      await expect(downloadSttModel(artifact("/corrupt"), destination)).rejects.toThrow("SHA-256 mismatch");
      expect(new Uint8Array(readFileSync(destination))).toEqual(original);
      expect(partials(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("STT model lifecycle", () => {
  test("derives install state from disk, emits progress, and persists selection across managers", async () => {
    const root = temporaryRoot();
    const modelDirectory = join(root, "models", "stt");
    const settings = new SttModelSettingsStore(root);
    const model = artifact();
    const stalePart = join(modelDirectory, `.${model.fileName}.part-stale`);
    try {
      const bootstrap = new SttModelManager(modelDirectory, settings, [model]);
      writeFileSync(stalePart, "partial");
      const manager = new SttModelManager(modelDirectory, settings, [model]);
      expect(bootstrap.state("small").status).toBe("absent");
      expect(existsSync(stalePart)).toBe(false);

      const statuses: string[] = [];
      manager.subscribe((state) => statuses.push(state.status));
      await manager.install("small");
      expect(manager.state("small").status).toBe("installed");
      expect(statuses[0]).toBe("downloading");
      expect(statuses.filter((status) => status === "downloading").length).toBeGreaterThan(1);

      const selectedPath = manager.select("small");
      expect(selectedPath).toBe(join(modelDirectory, model.fileName));
      expect(settings.load()).toEqual({ version: 1, selectedModelId: "small" });
      expect(new SttModelManager(modelDirectory, new SttModelSettingsStore(root), [model]).state("small").status).toBe("selected");

      unlinkSync(selectedPath);
      const restarted = new SttModelManager(modelDirectory, new SttModelSettingsStore(root), [model]);
      expect(restarted.state("small").status).toBe("absent");
      expect(restarted.selectedPath()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rechecks disk after model files are added or removed externally", () => {
    const root = temporaryRoot();
    const modelDirectory = join(root, "models", "stt");
    const model = artifact();
    const modelPath = join(modelDirectory, model.fileName);
    try {
      const manager = new SttModelManager(modelDirectory, new SttModelSettingsStore(root), [model]);
      expect(manager.state("small").status).toBe("absent");

      writeFileSync(modelPath, payload);
      manager.recheck();
      expect(manager.state("small").status).toBe("installed");

      unlinkSync(modelPath);
      manager.recheck();
      expect(manager.state("small").status).toBe("absent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancels from the subscribed progress event and removes every partial file", async () => {
    const root = temporaryRoot();
    const modelDirectory = join(root, "models", "stt");
    const manager = new SttModelManager(modelDirectory, new SttModelSettingsStore(root), [artifact("/cancel")]);
    let cancelled = false;
    try {
      manager.subscribe((state) => {
        if (state.status === "downloading" && state.receivedBytes > 0) cancelled = manager.cancel("small");
      });
      await manager.install("small");
      expect(cancelled).toBe(true);
      expect(manager.state("small").status).toBe("absent");
      expect(existsSync(join(modelDirectory, artifact().fileName))).toBe(false);
      expect(partials(modelDirectory)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
