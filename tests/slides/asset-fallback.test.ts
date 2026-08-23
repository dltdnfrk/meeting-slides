import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetContractError, type AssetKind, type AssetRecord } from "../../src/slides/assets/contract.ts";
import {
  createMissingAssetFallback,
  type MissingAssetFallbackReason,
} from "../../src/slides/assets/fallback.ts";
import { resolveSlideAssets } from "../../src/slides/assets/integration.ts";
import { createAssetManifest } from "../../src/slides/assets/manifest.ts";
import { createAssetRegistry } from "../../src/slides/assets/registry.ts";
import type { PlanAsset, SlidePlan } from "../../src/slides/model/plan.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../../src/slides/theme/meeting-paper.ts";
import { createDeckTheme } from "../../src/slides/theme/theme.ts";

const theme = createDeckTheme(MEETING_PAPER_STYLE_PROFILE);
const MISSING: MissingAssetFallbackReason = Object.freeze({
  code: "missing",
  detail: "The planned local source was not present.",
});
const UNAVAILABLE: MissingAssetFallbackReason = Object.freeze({
  code: "provider-unavailable",
  provider: "fixture-images",
  detail: "The provider rejected the request before returning an asset.",
});
let roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "asset-fallback-"));
  roots.push(root);
  const stagingRoot = join(root, "staging");
  const registry = createAssetRegistry({ managedRoot: join(root, "managed") });
  return { root, stagingRoot, registry };
}

function planned(kind: AssetKind = "image", overrides: Partial<PlanAsset> = {}): PlanAsset {
  const hash = "a".repeat(64);
  return {
    id: `asset-missing-${kind}`,
    purpose: "informative",
    kind,
    localPath: `assets/${hash}.png`,
    mediaType: "image/png",
    width: 1280,
    height: 720,
    byteLength: 1024,
    sha256: hash,
    altDescription: `Fallback explanation for the missing ${kind}.`,
    source: { kind: "local", originalPath: `planned/${kind}.png` },
    claimIds: ["claim-fallback"],
    ...overrides,
  };
}

function expectDeeplyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child);
}

function stagingEntries(stagingRoot: string): string[] {
  return existsSync(stagingRoot) ? readdirSync(stagingRoot) : [];
}

function planWith(asset: AssetRecord): SlidePlan {
  return {
    schemaVersion: 1,
    planId: "plan-fallback",
    revision: 1,
    snapshot: {
      meetingId: 1,
      transcriptVersionId: "transcript-v1",
      contentSha256: "b".repeat(64),
      lineCount: 1,
    },
    title: "Fallback integration",
    theme,
    claims: [{
      id: "claim-fallback",
      kind: "fact",
      text: "The source asset is unavailable.",
      sources: [{
        transcriptVersionId: "transcript-v1",
        startSeq: 1,
        endSeq: 1,
        evidenceQuote: "The source asset is unavailable.",
      }],
      method: "reviewed",
    }],
    assets: [{ ...structuredClone(asset), claimIds: [...asset.claimIds] }],
    slides: [{
      id: "slide-fallback",
      layout: "hero",
      storyRole: "opening",
      title: "Fallback",
      payload: { variant: "cover", statement: "The source is unavailable." },
      bindings: { title: ["claim-fallback"], statement: ["claim-fallback"] },
      editorialPaths: [],
      assetIds: [asset.id],
    }],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}

describe("deterministic missing-asset fallback", () => {
  test("generates deterministic, kind-appropriate local SVG fallbacks with preserved semantics", async () => {
    const markers: Record<AssetKind, string> = {
      image: 'data-fallback-kind="image"',
      diagram: 'data-fallback-kind="diagram"',
      chart: 'data-fallback-kind="chart"',
      icon: 'data-fallback-kind="icon"',
    };

    for (const kind of ["image", "diagram", "chart", "icon"] as const) {
      const firstFixture = fixture();
      const secondFixture = fixture();
      const source = planned(kind);
      const first = await createMissingAssetFallback({
        plannedAsset: source, reason: MISSING, theme,
        registry: firstFixture.registry, stagingRoot: firstFixture.stagingRoot,
      });
      const second = await createMissingAssetFallback({
        plannedAsset: structuredClone(source), reason: structuredClone(MISSING), theme,
        registry: secondFixture.registry, stagingRoot: secondFixture.stagingRoot,
      });

      expect(first.status).toBe("generated");
      expect(second.status).toBe("generated");
      if (first.status !== "generated" || second.status !== "generated") throw new Error("expected generated fallback");
      expect(first.asset).toEqual(second.asset);
      expect(first.planAsset).toEqual(first.asset);
      expect(first.asset.id).toBe(source.id);
      expect(first.asset.kind).toBe(kind);
      expect(first.asset.purpose).toBe("informative");
      expect(first.asset.altDescription).toBe(source.altDescription);
      expect(first.asset.claimIds).toEqual(source.claimIds);
      expect(first.asset.mediaType).toBe("image/svg+xml");
      expect(first.asset.source).toEqual({ kind: "generated", generator: "meeting-asset-fallback-svg-v1" });
      expect(first.receipt).toMatchObject({
        status: "generated",
        assetId: source.id,
        assetKind: kind,
        reason: MISSING,
        provenance: { kind: "generated", generator: "meeting-asset-fallback-svg-v1" },
        sha256: first.asset.sha256,
        localPath: first.asset.localPath,
      });
      const svg = readFileSync(join(firstFixture.root, "managed", first.asset.localPath), "utf8");
      expect(svg).toContain(markers[kind]);
      expect(svg).toContain("<title>");
      expect(svg).toContain("<desc>");
      expect(svg).toContain("role=\"img\"");
      expectDeeplyFrozen(first);
      expect(stagingEntries(firstFixture.stagingRoot)).toEqual([]);
    }
  });

  test("reuses one content-addressed cache path for identical fallback artwork", async () => {
    const { registry, stagingRoot } = fixture();
    const first = await createMissingAssetFallback({
      plannedAsset: planned("image", { id: "asset-copy-a" }), reason: UNAVAILABLE,
      theme, registry, stagingRoot,
    });
    const second = await createMissingAssetFallback({
      plannedAsset: planned("image", { id: "asset-copy-b" }), reason: UNAVAILABLE,
      theme, registry, stagingRoot,
    });

    if (first.status !== "generated" || second.status !== "generated") throw new Error("expected generated fallback");
    expect(first.asset.sha256).toBe(second.asset.sha256);
    expect(first.asset.localPath).toBe(second.asset.localPath);
    expect(registry.cacheEntries()).toEqual([first.asset.localPath]);
    expect(first.receipt.reason).toEqual(UNAVAILABLE);
  });

  test("returns an explicit frozen omission receipt for a missing decorative asset", async () => {
    const { registry, stagingRoot } = fixture();
    const result = await createMissingAssetFallback({
      plannedAsset: planned("icon", {
        id: "asset-decoration",
        purpose: "decorative",
        altDescription: "",
        claimIds: [],
      }),
      reason: MISSING,
      theme,
      registry,
      stagingRoot,
    });

    expect(result).toEqual({
      status: "omitted",
      planAsset: null,
      asset: null,
      receipt: {
        status: "omitted",
        assetId: "asset-decoration",
        assetKind: "icon",
        purpose: "decorative",
        reason: MISSING,
        provenance: { kind: "omitted", policy: "decorative-missing-asset-v1" },
      },
    });
    expectDeeplyFrozen(result);
    expect(registry.cacheEntries()).toEqual([]);
    expect(stagingEntries(stagingRoot)).toEqual([]);
  });

  test("replacement metadata and verified record pass strict asset integration", async () => {
    const { registry, stagingRoot } = fixture();
    const fallback = await createMissingAssetFallback({
      plannedAsset: planned("image"), reason: MISSING, theme, registry, stagingRoot,
    });
    if (fallback.status !== "generated") throw new Error("expected generated fallback");
    const verified = await registry.verifyForCompilation([fallback.asset]);
    const plan = planWith(fallback.planAsset);
    const layer = resolveSlideAssets(plan, createAssetManifest(verified), plan.slides[0]!);

    expect(verified).toEqual([fallback.asset]);
    expect(layer.placements[0]).toMatchObject({
      assetId: fallback.asset.id,
      localPath: fallback.asset.localPath,
      sha256: fallback.asset.sha256,
      accessibility: { role: "img", label: fallback.asset.altDescription },
      evidence: { claimIds: ["claim-fallback"] },
    });
  });

  test("rejects integrity, traversal, unsafe URL, corrupt-byte, and metadata-conflict reasons without fallback", async () => {
    const hardReasons = [
      "hash-mismatch", "traversal", "unsafe-url", "corrupt-bytes", "metadata-conflict",
    ] as const;
    for (const code of hardReasons) {
      const { registry, stagingRoot } = fixture();
      try {
        await createMissingAssetFallback({
          plannedAsset: planned(),
          reason: { code, detail: "must remain a hard failure" } as unknown as MissingAssetFallbackReason,
          theme,
          registry,
          stagingRoot,
        });
        throw new Error("expected hard failure");
      } catch (error) {
        expect(error).toBeInstanceOf(AssetContractError);
        expect(error).toMatchObject({ code: "ASSET_CONTRACT_INVALID", path: "reason.code" });
      }
      expect(registry.cacheEntries()).toEqual([]);
      expect(stagingEntries(stagingRoot)).toEqual([]);
    }
  });
});
