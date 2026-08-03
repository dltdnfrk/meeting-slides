import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppSettingsStore } from "../src/app-settings.ts";

describe("AppSettingsStore", () => {
  test("persists provider, model, and effort under the project only", () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-settings-"));
    try {
      const store = new AppSettingsStore(root);
      expect(store.load()).toBeNull();
      const saved = store.save({
        providerId: "cli:codex",
        model: "gpt-5.6-luna",
        effort: "high",
      });
      expect(saved).toEqual({
        version: 1,
        providerId: "cli:codex",
        model: "gpt-5.6-luna",
        effort: "high",
      });
      expect(store.load()).toEqual(saved);
      expect(store.path.startsWith(root)).toBe(true);
      expect(existsSync(join(root, ".meeting-slides", "settings.json"))).toBe(true);
      expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual(saved);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects corrupt files and invalid registry selections", () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-settings-"));
    try {
      const store = new AppSettingsStore(root);
      expect(() => store.save({ providerId: "cli:gemini", effort: "high" })).toThrow();
      expect(() => store.save({ providerId: "cli:codex", model: "made-up" })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
