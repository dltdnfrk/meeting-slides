import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetContractError } from "../../src/slides/assets/contract.ts";
import { acquireGeneratedImage, type ImageGenerationProvider } from "../../src/slides/assets/generated-image.ts";
import { acquirePhoto, type PhotoProvider } from "../../src/slides/assets/photo.ts";
import { createAssetRegistry } from "../../src/slides/assets/registry.ts";
import type { ByteRetriever } from "../../src/slides/assets/acquisition.ts";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0,
]);
const HASH = createHash("sha256").update(PNG).digest("hex");
const NOW = () => "2026-08-15T00:00:00.000Z";
let roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "asset-adapters-"));
  roots.push(root);
  const stagingRoot = join(root, "staging");
  return { root, stagingRoot, registry: createAssetRegistry({ managedRoot: join(root, "managed") }) };
}

function photoProvider(overrides: Record<string, unknown> = {}): PhotoProvider {
  return {
    async find() {
      return {
        requestId: "photo-request-1",
        provider: "fixture-photos",
        providerAssetId: "photo-42",
        sourceUrl: "https://images.example/photo.png",
        mediaType: "image/png",
        width: 2,
        height: 3,
        license: "CC BY 4.0",
        attribution: "Photo by Ada Example",
        ...overrides,
      };
    },
  };
}

function generator(overrides: Record<string, unknown> = {}): ImageGenerationProvider {
  return {
    async generate() {
      return {
        requestId: "generation-request-1",
        provider: "fixture-generator",
        model: "image-v2",
        prompt: "A calm blue meeting room",
        sourceUrl: "https://generated.example/result.png",
        mediaType: "image/png",
        width: 2,
        height: 3,
        ...overrides,
      };
    },
  };
}

const retrieve: ByteRetriever = async () => ({ bytes: PNG, mediaType: "image/png" });

function failure(error: unknown, code: string, path: string): void {
  expect(error).toBeInstanceOf(AssetContractError);
  expect(error).toMatchObject({ code, path });
  expect((error as Error).message).toContain(path);
}

describe("strict photo acquisition", () => {
  test("retrieves once, verifies provenance and bytes, persists locally, deduplicates, freezes receipts, and cleans staging", async () => {
    const { registry, stagingRoot } = fixture();
    let calls = 0;
    const byteRetriever: ByteRetriever = async (request) => {
      calls += 1;
      expect(request).toEqual({ url: "https://images.example/photo.png", maxBytes: 64 });
      return { bytes: PNG, mediaType: "image/png" };
    };
    const base = {
      requestId: "photo-request-1", query: "meeting room", purpose: "informative" as const,
      altDescription: "Colleagues reviewing a meeting plan.", claimIds: ["claim-room"], maxBytes: 64,
      expectedSha256: HASH,
    };
    const first = await acquirePhoto({ request: { ...base, id: "asset-photo-a" }, provider: photoProvider(), retrieveBytes: byteRetriever, registry, stagingRoot, now: NOW });
    const second = await acquirePhoto({ request: { ...base, id: "asset-photo-b" }, provider: photoProvider(), retrieveBytes: byteRetriever, registry, stagingRoot, now: NOW });

    expect(first.asset.localPath).toBe(`assets/${HASH}.png`);
    expect(second.asset.localPath).toBe(first.asset.localPath);
    expect(registry.cacheEntries()).toEqual([first.asset.localPath]);
    expect(first.receipt).toMatchObject({ kind: "photo", requestId: base.requestId, provider: "fixture-photos", providerAssetId: "photo-42", license: "CC BY 4.0", attribution: "Photo by Ada Example", sha256: HASH, byteLength: PNG.byteLength });
    expect(first.asset.source).toEqual({ kind: "retrieved", url: "https://images.example/photo.png", retrievedAt: NOW() });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.receipt)).toBe(true);
    expect(Object.isFrozen(first.asset.source)).toBe(true);
    expect(calls).toBe(2);
    expect(readdirSync(stagingRoot)).toEqual([]);
  });

  test("rejects unsafe or incomplete metadata, byte violations, accessibility misuse, and provider errors without retries", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
      [{ requestId: "not stable id" }, {}, "request.requestId"],
      [{ altDescription: "" }, {}, "request.altDescription"],
      [{ claimIds: [] }, {}, "request.claimIds"],
      [{ purpose: "decorative" }, {}, "request.purpose"],
      [{}, { requestId: "other-request" }, "providerResult.requestId"],
      [{}, { sourceUrl: "http://images.example/photo.png" }, "providerResult.sourceUrl"],
      [{}, { license: "" }, "providerResult.license"],
      [{}, { attribution: "" }, "providerResult.attribution"],
      [{}, { width: 0 }, "providerResult.width"],
      [{}, { mediaType: "image/jpeg" }, "bytes.mediaType"],
    ];
    for (const [requestOverrides, providerOverrides, path] of cases) {
      const { registry, stagingRoot } = fixture();
      let calls = 0;
      try {
        await acquirePhoto({
          request: { id: "asset-photo", requestId: "photo-request-1", query: "room", purpose: "informative", altDescription: "A room.", claimIds: ["claim-room"], maxBytes: 64, ...requestOverrides },
          provider: photoProvider(providerOverrides), retrieveBytes: async () => { calls += 1; return { bytes: PNG, mediaType: "image/png" }; }, registry, stagingRoot, now: NOW,
        });
        throw new Error("expected failure");
      } catch (error) { failure(error, "ASSET_ACQUISITION_INVALID", path); }
      expect(calls).toBeLessThanOrEqual(1);
      expect(readdirSync(stagingRoot)).toEqual([]);
    }

    const provider: PhotoProvider = { async find() { throw new Error("provider unavailable"); } };
    const { registry, stagingRoot } = fixture();
    let providerCalls = 0;
    try {
      await acquirePhoto({ request: { id: "asset-photo", requestId: "photo-request-1", query: "room", purpose: "informative", altDescription: "A room.", claimIds: ["claim-room"], maxBytes: 64 }, provider: { async find(request) { providerCalls += 1; return provider.find(request); } }, retrieveBytes: retrieve, registry, stagingRoot, now: NOW });
      throw new Error("expected failure");
    } catch (error) { failure(error, "ASSET_PROVIDER_ERROR", "provider"); }
    expect(providerCalls).toBe(1);
  });

  test("rejects oversized, hash-mutated, and dimension-mutated bytes and cleans staging", async () => {
    const variants: Array<[Uint8Array, number, string | undefined, string]> = [
      [PNG, PNG.byteLength - 1, undefined, "bytes.byteLength"],
      [PNG, 64, "0".repeat(64), "bytes.sha256"],
      [Uint8Array.from(PNG.map((byte, index) => index === 23 ? 4 : byte)), 64, undefined, "bytes.height"],
    ];
    for (const [bytes, maxBytes, expectedSha256, path] of variants) {
      const { registry, stagingRoot } = fixture();
      try {
        await acquirePhoto({ request: { id: "asset-photo", requestId: "photo-request-1", query: "room", purpose: "informative", altDescription: "A room.", claimIds: ["claim-room"], maxBytes, expectedSha256 }, provider: photoProvider(), retrieveBytes: async () => ({ bytes, mediaType: "image/png" }), registry, stagingRoot, now: NOW });
        throw new Error("expected failure");
      } catch (error) { failure(error, "ASSET_ACQUISITION_INVALID", path); }
      expect(readdirSync(stagingRoot)).toEqual([]);
    }
  });
});

describe("strict generated-image acquisition", () => {
  test("pins provider, model, prompt, media metadata, bytes, and local registration in a frozen receipt", async () => {
    const { registry, stagingRoot } = fixture();
    const result = await acquireGeneratedImage({ request: { id: "asset-generated", requestId: "generation-request-1", prompt: "A calm blue meeting room", purpose: "informative", altDescription: "A generated blue meeting room.", claimIds: ["claim-room"], maxBytes: 64, expectedSha256: HASH }, provider: generator(), retrieveBytes: retrieve, registry, stagingRoot, now: NOW });
    expect(result.receipt).toMatchObject({ kind: "generated-image", provider: "fixture-generator", model: "image-v2", prompt: "A calm blue meeting room", mediaType: "image/png", width: 2, height: 3, sha256: HASH });
    expect(result.asset.source).toEqual({ kind: "generated", generator: "fixture-generator/image-v2" });
    expect(result.asset.localPath.startsWith("assets/")).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.asset.claimIds)).toBe(true);
    expect(readdirSync(stagingRoot)).toEqual([]);
  });

  test("rejects mismatched provenance and does not retry generation", async () => {
    for (const [overrides, path] of [[{ model: "" }, "providerResult.model"], [{ prompt: "changed prompt" }, "providerResult.prompt"]] as const) {
      const { registry, stagingRoot } = fixture();
      let calls = 0;
      try {
        await acquireGeneratedImage({ request: { id: "asset-generated", requestId: "generation-request-1", prompt: "A calm blue meeting room", purpose: "informative", altDescription: "A generated room.", claimIds: ["claim-room"], maxBytes: 64 }, provider: { async generate() { calls += 1; return generator(overrides).generate({ requestId: "generation-request-1", prompt: "A calm blue meeting room" }); } }, retrieveBytes: retrieve, registry, stagingRoot, now: NOW });
        throw new Error("expected failure");
      } catch (error) { failure(error, "ASSET_ACQUISITION_INVALID", path); }
      expect(calls).toBe(1);
      expect(readdirSync(stagingRoot)).toEqual([]);
    }
  });
});
