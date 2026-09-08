import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CaptureSourceStore,
  isCaptureSource,
  parseCaptureSourceSettings,
} from "../src/capture-source.ts";

describe("capture source settings", () => {
  test("Given an unknown value, When parsed, Then it is not a capture source", () => {
    expect(isCaptureSource("mic")).toBe(true);
    expect(isCaptureSource("system")).toBe(true);
    expect(isCaptureSource("file")).toBe(false);
    expect(isCaptureSource("")).toBe(false);
    expect(isCaptureSource(null)).toBe(false);
  });

  test("Given no settings file, When loaded, Then the source is mic", () => {
    const root = mkdtempSync(join(tmpdir(), "capture-source-"));
    try {
      expect(new CaptureSourceStore(root).load()).toBe("mic");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Given a saved system source, When loaded, Then system is returned", () => {
    const root = mkdtempSync(join(tmpdir(), "capture-source-"));
    try {
      const store = new CaptureSourceStore(root);
      expect(store.save("system")).toEqual({ version: 1, source: "system" });
      expect(store.load()).toBe("system");
      const written = JSON.parse(readFileSync(store.path, "utf8")) as { version: number; source: string };
      expect(written).toEqual({ version: 1, source: "system" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Given garbage JSON, When parsed, Then it throws a typed settings error", () => {
    expect(() => parseCaptureSourceSettings("{")).toThrow("Invalid capture source settings JSON");
    expect(() => parseCaptureSourceSettings("{\"version\":2,\"source\":\"mic\"}")).toThrow("Unsupported capture source settings version");
    expect(() => parseCaptureSourceSettings("{\"version\":1,\"source\":\"hdmi\"}")).toThrow("Unknown capture source");
  });
});
