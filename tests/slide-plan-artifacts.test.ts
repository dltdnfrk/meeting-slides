import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveSlidePlanArtifact,
  SlidePlanArtifactError,
} from "../src/slide-plan-artifacts.ts";

const roots: string[] = [];
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "slide-plan-artifacts-"));
  roots.push(root);
  mkdirSync(join(root, "standalone"), { recursive: true });
  writeFileSync(join(root, "standalone", "index.html"), "<!doctype html><title>Deck</title>");
  const manifestValue = {
    schemaVersion: 1,
    identity: { planId: "plan-safe" },
    planSha256: "a".repeat(64),
    assetManifestSha256: "b".repeat(64),
    artifacts: [{
      format: "standalone-html",
      files: [{ relativePath: "standalone/index.html", byteLength: 34, sha256: "c".repeat(64) }],
    }],
  };
  const manifest = `${JSON.stringify(manifestValue)}\n`;
  const publicationSha256 = hash(manifest);
  writeFileSync(join(root, "publication.json"), `${JSON.stringify({
    ...manifestValue,
    publicationSha256,
  })}\n`);
  const store = {
    one: (planId: string) => planId === "plan-safe"
      ? { path: root, publicationSha256 }
      : null,
  };
  return { root, manifest, store };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SlidePlan artifact route", () => {
  test("resolves only manifest-bound files with safe response metadata", async () => {
    const { root, store } = fixture();
    const artifact = await resolveSlidePlanArtifact(
      "/slide-plan-artifacts/plan-safe/standalone/index.html",
      store,
    );
    expect(artifact).toEqual({
      filePath: realpathSync(join(root, "standalone", "index.html")),
      contentType: "text/html; charset=utf-8",
      disposition: "attachment",
    });
  });

  test("rejects traversal, unlisted files, tampered manifests, and unknown plans", async () => {
    const { root, store } = fixture();
    await expect(resolveSlidePlanArtifact(
      "/slide-plan-artifacts/plan-safe/%2e%2e/meetings.db",
      store,
    )).rejects.toMatchObject({ status: 403 });
    await expect(resolveSlidePlanArtifact(
      "/slide-plan-artifacts/plan-safe/unlisted.txt",
      store,
    )).rejects.toMatchObject({ status: 404 });
    await expect(resolveSlidePlanArtifact(
      "/slide-plan-artifacts/unknown/standalone/index.html",
      store,
    )).rejects.toMatchObject({ status: 404 });

    writeFileSync(join(root, "publication.json"), "{}");
    await expect(resolveSlidePlanArtifact(
      "/slide-plan-artifacts/plan-safe/standalone/index.html",
      store,
    )).rejects.toBeInstanceOf(SlidePlanArtifactError);
  });
});
