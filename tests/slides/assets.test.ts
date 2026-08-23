import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AssetContractError,
  parseAssetRecord,
  type AssetRecord,
  type AssetRegistration,
} from "../../src/slides/assets/contract.ts";
import { createAssetRegistry } from "../../src/slides/assets/registry.ts";
import {
  createAssetManifest,
  stableAssetManifestJson,
} from "../../src/slides/assets/manifest.ts";

const BYTES = {
  image: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11]),
  icon: Buffer.from("<svg viewBox='0 0 16 16'><path d='M1 8h14'/></svg>", "utf8"),
  diagram: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
  chart: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]),
} as const;

const EXTENSION = {
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/jpeg": "jpg",
} as const;

let temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(): { root: string; incomingRoot: string; managedRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "meeting-slides-assets-"));
  temporaryRoots.push(root);
  const incomingRoot = join(root, "incoming");
  const managedRoot = join(root, "managed");
  mkdirSync(incomingRoot, { recursive: true });
  mkdirSync(managedRoot, { recursive: true });
  return { root, incomingRoot, managedRoot };
}

function writeIncoming(root: string, name: string, bytes: Uint8Array): string {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function registration(
  incomingRoot: string,
  overrides: Partial<AssetRegistration> = {},
): AssetRegistration {
  return {
    id: "asset-retention-chart",
    purpose: "informative",
    kind: "chart",
    inputPath: writeIncoming(incomingRoot, "retention.png", BYTES.image),
    mediaType: "image/png",
    width: 1280,
    height: 720,
    altDescription: "Line chart showing retention rising twelve percent.",
    source: { kind: "local", originalPath: "meeting-assets/retention.png" },
    claimIds: ["claim-retention"],
    ...overrides,
  };
}

function validRecord(overrides: Partial<AssetRecord> = {}): AssetRecord {
  const hash = sha256(BYTES.image);
  return {
    id: "asset-retention-chart",
    purpose: "informative",
    kind: "chart",
    localPath: `assets/${hash}.png`,
    mediaType: "image/png",
    width: 1280,
    height: 720,
    byteLength: BYTES.image.byteLength,
    sha256: hash,
    altDescription: "Line chart showing retention rising twelve percent.",
    source: { kind: "local", originalPath: "meeting-assets/retention.png" },
    claimIds: ["claim-retention"],
    ...overrides,
  };
}

function expectAssetFailure(
  operation: () => unknown,
  expected: { code: string; path: string },
): void {
  try {
    operation();
    throw new Error("expected an asset contract failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AssetContractError);
    const failure = error as AssetContractError;
    expect(failure.code).toBe(expected.code);
    expect(failure.path).toBe(expected.path);
    expect(failure.message).toContain(`[${expected.code}]`);
    expect(failure.message).toContain(expected.path);
  }
}

async function expectAsyncAssetFailure(
  operation: () => Promise<unknown>,
  expected: { code: string; path: string },
): Promise<void> {
  try {
    await operation();
    throw new Error("expected an asset contract failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AssetContractError);
    const failure = error as AssetContractError;
    expect(failure.code).toBe(expected.code);
    expect(failure.path).toBe(expected.path);
    expect(failure.message).toContain(`[${expected.code}]`);
    expect(failure.message).toContain(expected.path);
  }
}

describe("asset contract and provenance", () => {
  test("registers image, icon, diagram, and chart bytes with local, generated, and retrieved provenance", async () => {
    const { incomingRoot, managedRoot } = fixture();
    const registry = createAssetRegistry({ managedRoot });
    const cases: AssetRegistration[] = [
      registration(incomingRoot, {
        id: "asset-photo",
        kind: "image",
        inputPath: writeIncoming(incomingRoot, "photo.png", BYTES.image),
        altDescription: "Workshop participants reviewing the launch plan.",
        source: { kind: "local", originalPath: "camera/workshop.png" },
        claimIds: ["claim-workshop"],
      }),
      registration(incomingRoot, {
        id: "asset-arrow-icon",
        purpose: "decorative",
        kind: "icon",
        inputPath: writeIncoming(incomingRoot, "arrow.svg", BYTES.icon),
        mediaType: "image/svg+xml",
        width: 16,
        height: 16,
        altDescription: "",
        source: { kind: "generated", generator: "deterministic-svg-v1" },
        claimIds: [],
      }),
      registration(incomingRoot, {
        id: "asset-release-diagram",
        kind: "diagram",
        inputPath: writeIncoming(incomingRoot, "release.webp", BYTES.diagram),
        mediaType: "image/webp",
        width: 640,
        height: 360,
        altDescription: "Diagram connecting quality assurance to beta publication.",
        source: { kind: "generated", generator: "release-flow-v2" },
        claimIds: ["claim-process"],
      }),
      registration(incomingRoot, {
        id: "asset-retention-chart",
        kind: "chart",
        inputPath: writeIncoming(incomingRoot, "retention.jpg", BYTES.chart),
        mediaType: "image/jpeg",
        width: 1280,
        height: 720,
        altDescription: "Chart showing retention rising twelve percent.",
        source: {
          kind: "retrieved",
          url: "https://evidence.example/reports/retention.jpg",
          retrievedAt: "2026-08-14T10:00:00.000Z",
        },
        claimIds: ["claim-retention"],
      }),
    ];

    const records = await Promise.all(cases.map((item) => registry.register(item)));

    expect(records.map((record: AssetRecord) => record.kind)).toEqual(["image", "icon", "diagram", "chart"]);
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const bytes = [BYTES.image, BYTES.icon, BYTES.diagram, BYTES.chart][index]!;
      const extension = EXTENSION[record.mediaType as keyof typeof EXTENSION];
      expect(record.sha256).toBe(sha256(bytes));
      expect(record.byteLength).toBe(bytes.byteLength);
      expect(record.localPath).toBe(`assets/${record.sha256}.${extension}`);
    }
    expect(records.map((record: AssetRecord) => record.source.kind)).toEqual([
      "local", "generated", "generated", "retrieved",
    ]);
  });

  test("informative assets require claim IDs and non-empty alternative text", () => {
    expectAssetFailure(
      () => parseAssetRecord(validRecord({ claimIds: [] }), { path: "assets[2]" }),
      { code: "ASSET_CONTRACT_INVALID", path: "assets[2].claimIds" },
    );
    expectAssetFailure(
      () => parseAssetRecord(validRecord({ altDescription: "   " }), { path: "assets[2]" }),
      { code: "ASSET_CONTRACT_INVALID", path: "assets[2].altDescription" },
    );
  });

  test("decorative assets require presentation-empty alt text and no claim IDs", () => {
    const decorative = validRecord({
      id: "asset-divider",
      purpose: "decorative",
      kind: "icon",
      altDescription: "",
      claimIds: [],
    });
    expect(parseAssetRecord(decorative, { path: "assets[0]" })).toEqual(decorative);

    expectAssetFailure(
      () => parseAssetRecord({ ...decorative, altDescription: "A divider" }, { path: "assets[0]" }),
      { code: "ASSET_CONTRACT_INVALID", path: "assets[0].altDescription" },
    );
    expectAssetFailure(
      () => parseAssetRecord({ ...decorative, claimIds: ["claim-layout"] }, { path: "assets[0]" }),
      { code: "ASSET_CONTRACT_INVALID", path: "assets[0].claimIds" },
    );
  });

  test("strictly parses IDs, managed paths, hashes, media types, dimensions, and byte lengths", () => {
    const hash = sha256(BYTES.image);
    const cases: Array<[string, unknown, string]> = [
      ["ID whitespace", validRecord({ id: "Asset Retention" }), "assets[4].id"],
      ["absolute path", validRecord({ localPath: `/tmp/${hash}.png` }), "assets[4].localPath"],
      ["traversal", validRecord({ localPath: `assets/../${hash}.png` }), "assets[4].localPath"],
      ["hotlink", validRecord({ localPath: `https://cdn.example/${hash}.png` }), "assets[4].localPath"],
      ["uppercase hash", validRecord({ sha256: hash.toUpperCase() }), "assets[4].sha256"],
      ["short hash", validRecord({ sha256: "a".repeat(63) }), "assets[4].sha256"],
      ["path/hash mismatch", validRecord({ localPath: `assets/${"b".repeat(64)}.png` }), "assets[4].localPath"],
      ["unsupported media", validRecord({ mediaType: "text/html" }), "assets[4].mediaType"],
      ["extension mismatch", validRecord({ localPath: `assets/${hash}.jpg` }), "assets[4].localPath"],
      ["zero width", validRecord({ width: 0 }), "assets[4].width"],
      ["fractional height", validRecord({ height: 719.5 }), "assets[4].height"],
      ["string dimension", { ...validRecord(), width: "1280" }, "assets[4].width"],
      ["zero byte length", validRecord({ byteLength: 0 }), "assets[4].byteLength"],
      ["fractional byte length", validRecord({ byteLength: 9.5 }), "assets[4].byteLength"],
      ["unknown field", { ...validRecord(), remoteUrl: "https://cdn.example/a.png" }, "assets[4].remoteUrl"],
    ];

    for (const [label, value, path] of cases) {
      expectAssetFailure(
        () => parseAssetRecord(value, { path: "assets[4]" }),
        { code: "ASSET_CONTRACT_INVALID", path },
      );
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test("strictly parses each provenance variant and rejects ambiguous or incomplete provenance", () => {
    const cases: Array<[unknown, string]> = [
      [{ kind: "local", originalPath: "" }, "assets[1].source.originalPath"],
      [{ kind: "generated", generator: "   " }, "assets[1].source.generator"],
      [{ kind: "retrieved", url: "/relative.png", retrievedAt: "2026-08-14T10:00:00.000Z" }, "assets[1].source.url"],
      [{ kind: "retrieved", url: "http://evidence.example/a.png", retrievedAt: "yesterday" }, "assets[1].source.retrievedAt"],
      [{ kind: "remote", url: "https://evidence.example/a.png" }, "assets[1].source.kind"],
      [{ kind: "local", originalPath: "a.png", generator: "ambiguous" }, "assets[1].source.generator"],
    ];

    for (const [source, path] of cases) {
      expectAssetFailure(
        () => parseAssetRecord({ ...validRecord(), source }, { path: "assets[1]" }),
        { code: "ASSET_CONTRACT_INVALID", path },
      );
    }
  });
});

describe("managed registry verification and content addressing", () => {
  test("compilation resolves only registered, currently verified bytes under the managed root", async () => {
    const { incomingRoot, managedRoot } = fixture();
    const registry = createAssetRegistry({ managedRoot });
    const record = await registry.register(registration(incomingRoot));

    const [verified] = await registry.verifyForCompilation([record]);
    expect(verified).toEqual(record);
    expect(verified!.localPath.startsWith("assets/")).toBe(true);

    await expectAsyncAssetFailure(
      () => registry.verifyForCompilation([validRecord({ id: "asset-never-registered" })]),
      { code: "ASSET_NOT_REGISTERED", path: "assets[0].id" },
    );
  });

  test("traversal references and symlinks escaping the managed root fail before compilation", async () => {
    const { root, incomingRoot, managedRoot } = fixture();
    const registry = createAssetRegistry({ managedRoot });
    const record = await registry.register(registration(incomingRoot));

    await expectAsyncAssetFailure(
      () => registry.verifyForCompilation([{ ...record, localPath: `assets/../${record.sha256}.png` }]),
      { code: "ASSET_OUTSIDE_MANAGED_ROOT", path: "assets[0].localPath" },
    );

    const managedPath = join(managedRoot, record.localPath);
    const outsidePath = join(root, "outside.png");
    writeFileSync(outsidePath, BYTES.image);
    unlinkSync(managedPath);
    symlinkSync(outsidePath, managedPath);

    await expectAsyncAssetFailure(
      () => registry.verifyForCompilation([record]),
      { code: "ASSET_OUTSIDE_MANAGED_ROOT", path: "assets[0].localPath" },
    );
  });

  test("changing bytes after registration fails pinned-hash verification", async () => {
    const { incomingRoot, managedRoot } = fixture();
    const registry = createAssetRegistry({ managedRoot });
    const record = await registry.register(registration(incomingRoot));
    writeFileSync(join(managedRoot, record.localPath), Buffer.from("changed-after-registration", "utf8"));

    await expectAsyncAssetFailure(
      () => registry.verifyForCompilation([record]),
      { code: "ASSET_HASH_MISMATCH", path: "assets[0].sha256" },
    );
  });

  test("duplicate IDs and conflicting metadata fail without replacing the first registration", async () => {
    const { incomingRoot, managedRoot } = fixture();
    const registry = createAssetRegistry({ managedRoot });
    const first = registration(incomingRoot);
    const record = await registry.register(first);

    await expectAsyncAssetFailure(
      () => registry.register(first),
      { code: "ASSET_DUPLICATE_ID", path: "asset.id" },
    );

    await expectAsyncAssetFailure(
      () => registry.register(registration(incomingRoot, {
        id: first.id,
        inputPath: writeIncoming(incomingRoot, "different.png", BYTES.chart),
        width: 1920,
      })),
      { code: "ASSET_METADATA_CONFLICT", path: "asset.id" },
    );
    expect(registry.get(first.id)).toEqual(record);
  });

  test("identical bytes share one deterministic content-addressed cache entry", async () => {
    const { incomingRoot, managedRoot } = fixture();
    const registry = createAssetRegistry({ managedRoot });
    const first = await registry.register(registration(incomingRoot, {
      id: "asset-copy-a",
      inputPath: writeIncoming(incomingRoot, "copy-a.png", BYTES.image),
    }));
    const second = await registry.register(registration(incomingRoot, {
      id: "asset-copy-b",
      inputPath: writeIncoming(incomingRoot, "copy-b.png", BYTES.image),
      altDescription: "The same verified chart used for a second claim.",
      claimIds: ["claim-copy"],
    }));

    expect(first.sha256).toBe(second.sha256);
    expect(first.localPath).toBe(second.localPath);
    expect(registry.cacheEntries()).toEqual([first.localPath]);

    const freshRegistry = createAssetRegistry({ managedRoot });
    const replay = await freshRegistry.register(registration(incomingRoot, {
      id: "asset-replayed",
      inputPath: writeIncoming(incomingRoot, "replayed.png", BYTES.image),
    }));
    expect(replay.localPath).toBe(first.localPath);
    expect(freshRegistry.cacheEntries()).toEqual([first.localPath]);
  });
});

describe("asset manifest boundary", () => {
  test("manifests are sorted, deeply frozen, JSON-ready, stable, and expose no hotlink as a consumable path", () => {
    const retrieved = validRecord({
      id: "asset-zeta",
      source: {
        kind: "retrieved",
        url: "https://evidence.example/source/chart.png",
        retrievedAt: "2026-08-14T10:00:00.000Z",
      },
    });
    const local = validRecord({ id: "asset-alpha" });
    const manifest = createAssetManifest([retrieved, local]);

    expect(manifest).toEqual({ schemaVersion: 1, assets: [local, retrieved] });
    expect(manifest.assets.map((asset: AssetRecord) => asset.id)).toEqual(["asset-alpha", "asset-zeta"]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.assets)).toBe(true);
    expect(Object.isFrozen(manifest.assets[0])).toBe(true);
    expect(Object.isFrozen(manifest.assets[0]!.source)).toBe(true);
    expect(Object.isFrozen(manifest.assets[0]!.claimIds)).toBe(true);
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
    expect(manifest.assets.every((asset: AssetRecord) => !/^https?:\/\//.test(asset.localPath))).toBe(true);
    expect(manifest.assets.every((asset: AssetRecord) => asset.localPath.startsWith("assets/"))).toBe(true);

    const canonical = stableAssetManifestJson(manifest);
    expect(canonical).toBe(stableAssetManifestJson(createAssetManifest([local, retrieved])));
    expect(canonical).toBe(`${JSON.stringify(manifest)}\n`);
  });

  test("manifest construction rejects duplicate IDs and conflicting records with typed indexed paths", () => {
    const record = validRecord();
    expectAssetFailure(
      () => createAssetManifest([record, { ...record }]),
      { code: "ASSET_DUPLICATE_ID", path: "assets[1].id" },
    );
    expectAssetFailure(
      () => createAssetManifest([record, { ...record, width: record.width + 1 }]),
      { code: "ASSET_METADATA_CONFLICT", path: "assets[1].id" },
    );
  });
});
