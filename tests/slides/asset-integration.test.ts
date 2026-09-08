import { describe, expect, test } from "bun:test";

import type { AssetRecord } from "../../src/slides/assets/contract.ts";
import {
  AssetIntegrationError,
  resolveSlideAssets,
  type ResolvedAssetLayer,
} from "../../src/slides/assets/integration.ts";
import { createAssetManifest, type AssetManifest } from "../../src/slides/assets/manifest.ts";
import { compileGeometrySlide } from "../../src/slides/geometry/compiler.ts";
import type { TextMeasureInput, TextMeasurer, TextFitPolicy } from "../../src/slides/geometry/contract.ts";
import { preflightGeometrySlide } from "../../src/slides/geometry/preflight.ts";
import type { LayoutDraft, LayoutElement } from "../../src/slides/layouts/contract.ts";
import { draftLayout } from "../../src/slides/layouts/registry.ts";
import type { PlanSlide, SlidePlan } from "../../src/slides/model/plan.ts";
import { createDeckTheme } from "../../src/slides/theme/theme.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../../src/slides/theme/meeting-paper.ts";

const HASH_HERO = "1".repeat(64);
const HASH_SUMMARY = "2".repeat(64);
const HASH_CHART = "3".repeat(64);
const HASH_UNUSED = "4".repeat(64);
const theme = createDeckTheme(MEETING_PAPER_STYLE_PROFILE);

function asset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  const sha256 = overrides.sha256 ?? HASH_HERO;
  const mediaType = overrides.mediaType ?? "image/png";
  const extension = mediaType === "image/svg+xml" ? "svg"
    : mediaType === "image/webp" ? "webp"
    : mediaType === "image/jpeg" ? "jpg"
    : "png";
  return {
    id: "asset-hero-photo",
    purpose: "informative",
    kind: "image",
    localPath: `assets/${sha256}.${extension}`,
    mediaType,
    width: 1920,
    height: 1080,
    byteLength: 24_000,
    sha256,
    altDescription: "The launch team reviewing the approved beta schedule.",
    source: {
      kind: "retrieved",
      url: "https://evidence.example/source/launch-team.png",
      retrievedAt: "2026-08-14T10:00:00.000Z",
    },
    claimIds: ["claim-launch"],
    ...overrides,
  };
}

function records(): AssetRecord[] {
  return [
    asset(),
    asset({
      id: "asset-summary-mark",
      purpose: "decorative",
      kind: "icon",
      sha256: HASH_SUMMARY,
      localPath: `assets/${HASH_SUMMARY}.svg`,
      mediaType: "image/svg+xml",
      width: 320,
      height: 320,
      byteLength: 800,
      altDescription: "",
      source: { kind: "generated", generator: "meeting-mark-v1" },
      claimIds: [],
    }),
    asset({
      id: "asset-retention-chart",
      kind: "chart",
      sha256: HASH_CHART,
      localPath: `assets/${HASH_CHART}.png`,
      width: 1600,
      height: 900,
      byteLength: 18_000,
      altDescription: "A line chart showing retention increasing by twelve percent.",
      source: { kind: "local", originalPath: "meeting-assets/retention.png" },
      claimIds: ["claim-retention"],
    }),
    asset({
      id: "asset-unreferenced",
      purpose: "decorative",
      kind: "diagram",
      sha256: HASH_UNUSED,
      localPath: `assets/${HASH_UNUSED}.webp`,
      mediaType: "image/webp",
      width: 640,
      height: 360,
      byteLength: 900,
      altDescription: "",
      source: { kind: "generated", generator: "unused-v1" },
      claimIds: [],
    }),
  ];
}

function slides(): PlanSlide[] {
  return [
    {
      id: "slide-hero",
      layout: "hero",
      storyRole: "opening",
      title: "Launch readiness",
      payload: { variant: "cover", statement: "The beta launches Friday." },
      bindings: { title: ["claim-launch"], statement: ["claim-launch"] },
      editorialPaths: [],
      assetIds: ["asset-hero-photo"],
    },
    {
      id: "slide-summary",
      layout: "summary",
      storyRole: "context",
      title: "What changed",
      payload: { mode: "overview", items: ["The launch date is approved."] },
      bindings: { title: ["claim-launch"], "items[0]": ["claim-launch"] },
      editorialPaths: [],
      assetIds: ["asset-summary-mark"],
    },
    {
      id: "slide-metrics",
      layout: "metrics",
      storyRole: "argument",
      title: "Retention signal",
      payload: {
        mode: "chart",
        metrics: [{ label: "Retention", value: "+12%", detail: "After the cohort change" }],
      },
      bindings: {
        title: ["claim-retention"],
        "metrics[0].label": ["claim-retention"],
        "metrics[0].value": ["claim-retention"],
        "metrics[0].detail": ["claim-retention"],
      },
      editorialPaths: [],
      assetIds: ["asset-retention-chart"],
    },
    {
      id: "slide-actions",
      layout: "actions",
      storyRole: "commitment",
      title: "Owners and dates",
      payload: { items: [{ task: "Publish notes", owner: "Mina", due: "Thursday" }] },
      bindings: {
        title: ["claim-action"],
        "items[0].task": ["claim-action"],
        "items[0].owner": ["claim-action"],
        "items[0].due": ["claim-action"],
      },
      editorialPaths: [],
      assetIds: [],
    },
  ];
}

function plan(): SlidePlan {
  const verified = records();
  return {
    schemaVersion: 1,
    planId: "plan-asset-integration",
    revision: 1,
    snapshot: {
      meetingId: 42,
      transcriptVersionId: "transcript-v7",
      contentSha256: "a".repeat(64),
      lineCount: 8,
    },
    title: "Launch readiness review",
    theme,
    claims: [
      {
        id: "claim-launch",
        kind: "decision",
        text: "The beta launches Friday.",
        sources: [{
          transcriptVersionId: "transcript-v7",
          startSeq: 1,
          endSeq: 2,
          evidenceQuote: "We agreed the beta launches Friday.",
        }],
        method: "reviewed",
      },
      {
        id: "claim-retention",
        kind: "fact",
        text: "Retention increased by 12%.",
        sources: [{
          transcriptVersionId: "transcript-v7",
          startSeq: 3,
          endSeq: 4,
          evidenceQuote: "Retention increased by twelve percent.",
        }],
        method: "extractive",
      },
      {
        id: "claim-action",
        kind: "action",
        text: "Mina publishes the notes Thursday.",
        sources: [{
          transcriptVersionId: "transcript-v7",
          startSeq: 5,
          endSeq: 5,
          evidenceQuote: "Mina will publish the notes Thursday.",
        }],
        method: "reviewed",
      },
    ],
    assets: verified.map((entry) => ({
      ...structuredClone(entry),
      claimIds: [...entry.claimIds],
    })),
    slides: slides(),
    createdAt: "2026-08-14T10:00:00.000Z",
    updatedAt: "2026-08-14T10:00:00.000Z",
  };
}

function manifest(source = records()): AssetManifest {
  return createAssetManifest(source);
}

function slide(source: SlidePlan, id: string): PlanSlide {
  const found = source.slides.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`fixture slide not found: ${id}`);
  return found;
}

function expectDeeplyFrozen(value: unknown, path = "root"): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value), path).toBe(true);
  for (const [key, child] of Object.entries(value)) expectDeeplyFrozen(child, `${path}.${key}`);
}

function expectIntegrationFailure(
  operation: () => unknown,
  expected: { code: string; path: string; detail?: RegExp },
): void {
  try {
    operation();
    throw new Error("expected asset integration failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AssetIntegrationError);
    const failure = error as AssetIntegrationError;
    expect(failure.code).toBe(expected.code);
    expect(failure.path).toBe(expected.path);
    expect(failure.message).toContain(`[${expected.code}]`);
    expect(failure.message).toContain(expected.path);
    if (expected.detail !== undefined) expect(failure.message).toMatch(expected.detail);
  }
}

function resolve(source: SlidePlan, slideId: string, verified = manifest()): ResolvedAssetLayer {
  return resolveSlideAssets(source, verified, slide(source, slideId));
}

describe("SlidePlan asset integration boundary", () => {
  test("resolves hero, summary, and metrics-chart assets into deterministic render-ready placements", () => {
    const source = plan();

    expect(resolve(source, "slide-hero")).toEqual({
      id: "slide-hero:assets",
      slideId: "slide-hero",
      canvas: { width: 1280, height: 720 },
      placements: [{
        id: "slide-hero:asset:asset-hero-photo",
        assetId: "asset-hero-photo",
        purpose: "informative",
        kind: "image",
        localPath: `assets/${HASH_HERO}.png`,
        sha256: HASH_HERO,
        mediaType: "image/png",
        sourceWidth: 1920,
        sourceHeight: 1080,
        byteLength: 24_000,
        box: { x: 704, y: 0, width: 576, height: 720 },
        fit: "cover",
        accessibility: { role: "img", label: "The launch team reviewing the approved beta schedule." },
        evidence: { claimIds: ["claim-launch"] },
      }],
    });

    expect(resolve(source, "slide-summary").placements).toEqual([{
      id: "slide-summary:asset:asset-summary-mark",
      assetId: "asset-summary-mark",
      purpose: "decorative",
      kind: "icon",
      localPath: `assets/${HASH_SUMMARY}.svg`,
      sha256: HASH_SUMMARY,
      mediaType: "image/svg+xml",
      sourceWidth: 320,
      sourceHeight: 320,
      byteLength: 800,
      box: { x: 880, y: 160, width: 240, height: 240 },
      fit: "contain",
      accessibility: { role: "presentation", label: "" },
      evidence: null,
    }]);

    expect(resolve(source, "slide-metrics").placements).toEqual([{
      id: "slide-metrics:asset:asset-retention-chart",
      assetId: "asset-retention-chart",
      purpose: "informative",
      kind: "chart",
      localPath: `assets/${HASH_CHART}.png`,
      sha256: HASH_CHART,
      mediaType: "image/png",
      sourceWidth: 1600,
      sourceHeight: 900,
      byteLength: 18_000,
      box: { x: 480, y: 152, width: 720, height: 480 },
      fit: "contain",
      accessibility: { role: "img", label: "A line chart showing retention increasing by twelve percent." },
      evidence: { claimIds: ["claim-retention"] },
    }]);
  });

  test("returns only referenced assets, preserves text contracts, freezes deeply, and is deterministic", () => {
    const source = plan();
    const selected = slide(source, "slide-metrics");
    const selectedBefore = structuredClone(selected);
    const first = resolveSlideAssets(source, manifest(), selected);
    const second = resolveSlideAssets(structuredClone(source), manifest(records().reverse()), structuredClone(selected));

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.placements.map((entry: { readonly assetId: string }) => entry.assetId)).toEqual(["asset-retention-chart"]);
    expect(JSON.stringify(first)).not.toContain("asset-unreferenced");
    expect(selected).toEqual(selectedBefore);
    expect("elements" in first).toBe(false);
    expectDeeplyFrozen(first);
  });

  test("uses only verified managed local paths and never exposes or reads retrieved URLs", () => {
    const source = plan();
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error("asset integration must not fetch remote bytes");
    }) as unknown as typeof fetch;

    try {
      const result = resolve(source, "slide-hero");
      expect(fetchCalls).toBe(0);
      expect(result.placements[0]!.localPath).toBe(`assets/${HASH_HERO}.png`);
      expect(result.placements[0]!.localPath).not.toMatch(/^[a-z][a-z\d+.-]*:/i);
      expect(JSON.stringify(result)).not.toContain("https://evidence.example");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("requires each reference in both the plan and verified manifest", () => {
    const missingPlanRecord = plan();
    missingPlanRecord.assets = missingPlanRecord.assets.filter((entry) => entry.id !== "asset-hero-photo");
    expectIntegrationFailure(
      () => resolve(missingPlanRecord, "slide-hero"),
      { code: "ASSET_MISSING_PLAN_RECORD", path: "slides[0].assetIds[0]", detail: /asset-hero-photo/ },
    );

    const source = plan();
    expectIntegrationFailure(
      () => resolve(source, "slide-hero", manifest(records().filter((entry) => entry.id !== "asset-hero-photo"))),
      { code: "ASSET_MISSING_VERIFIED_RECORD", path: "slides[0].assetIds[0]", detail: /asset-hero-photo/ },
    );
  });

  test("rejects any plan/manifest metadata drift at the verified field path", () => {
    const cases: Array<[string, Partial<AssetRecord>]> = [
      ["sha256", { sha256: "9".repeat(64), localPath: `assets/${"9".repeat(64)}.png` }],
      ["mediaType", { mediaType: "image/jpeg", localPath: `assets/${HASH_HERO}.jpg` }],
      ["width", { width: 1919 }],
      ["height", { height: 1079 }],
      ["altDescription", { altDescription: "Different semantic description." }],
      ["claimIds", { claimIds: ["claim-retention"] }],
    ];

    for (const [field, overrides] of cases) {
      const changed = records().map((entry) => entry.id === "asset-hero-photo" ? asset(overrides) : entry);
      expectIntegrationFailure(
        () => resolve(plan(), "slide-hero", manifest(changed)),
        { code: "ASSET_METADATA_DRIFT", path: `manifest.assets[0].${field}`, detail: /asset-hero-photo/ },
      );
    }
  });

  test("binds informative evidence only to known claims represented on that slide", () => {
    const unknown = plan();
    unknown.assets[0]!.claimIds = ["claim-absent"];
    const unknownVerified = records();
    unknownVerified[0] = asset({ claimIds: ["claim-absent"] });
    expectIntegrationFailure(
      () => resolve(unknown, "slide-hero", manifest(unknownVerified)),
      { code: "ASSET_UNKNOWN_CLAIM", path: "plan.assets[0].claimIds[0]", detail: /claim-absent/ },
    );

    const unbound = plan();
    unbound.assets[0]!.claimIds = ["claim-retention"];
    const unboundVerified = records();
    unboundVerified[0] = asset({ claimIds: ["claim-retention"] });
    expectIntegrationFailure(
      () => resolve(unbound, "slide-hero", manifest(unboundVerified)),
      { code: "ASSET_CLAIM_NOT_BOUND", path: "slides[0].assetIds[0]", detail: /claim-retention.*slide-hero/i },
    );
  });

  test("rejects semantic alt or evidence on decorative assets", () => {
    const cases: Array<[string, Partial<AssetRecord>]> = [
      ["altDescription", { altDescription: "Decorative flourish" }],
      ["claimIds", { claimIds: ["claim-launch"] }],
    ];

    for (const [field, overrides] of cases) {
      const source = plan();
      Object.assign(source.assets[1]!, overrides);
      const forgedManifest = {
        schemaVersion: 1,
        assets: records().map((entry) => entry.id === "asset-summary-mark"
          ? Object.freeze({ ...entry, ...overrides })
          : entry),
      } as AssetManifest;
      expectIntegrationFailure(
        () => resolve(source, "slide-summary", forgedManifest),
        { code: "ASSET_ACCESSIBILITY_INVALID", path: `plan.assets[1].${field}` },
      );
    }
  });

  test("rejects duplicate IDs and hotlinks with typed indexed paths", () => {
    const duplicatePlan = plan();
    duplicatePlan.assets.push(structuredClone(duplicatePlan.assets[0]!));
    expectIntegrationFailure(
      () => resolve(duplicatePlan, "slide-hero"),
      { code: "ASSET_DUPLICATE_ID", path: "plan.assets[4].id", detail: /asset-hero-photo/ },
    );

    const duplicateManifest = {
      schemaVersion: 1,
      assets: [...records(), structuredClone(records()[0]!)],
    } as AssetManifest;
    expectIntegrationFailure(
      () => resolve(plan(), "slide-hero", duplicateManifest),
      { code: "ASSET_DUPLICATE_ID", path: "manifest.assets[4].id", detail: /asset-hero-photo/ },
    );

    const hotlinked = plan();
    hotlinked.assets[0]!.localPath = "https://cdn.example/launch-team.png";
    const hotlinkManifest = {
      schemaVersion: 1,
      assets: records().map((entry) => entry.id === "asset-hero-photo"
        ? { ...entry, localPath: "https://cdn.example/launch-team.png" }
        : entry),
    } as AssetManifest;
    expectIntegrationFailure(
      () => resolve(hotlinked, "slide-hero", hotlinkManifest),
      { code: "ASSET_HOTLINK", path: "plan.assets[0].localPath" },
    );
  });

  test("fails unsupported layout variants and colliding single-slot placements", () => {
    const unsupported = plan();
    slide(unsupported, "slide-actions").assetIds = ["asset-summary-mark"];
    expectIntegrationFailure(
      () => resolve(unsupported, "slide-actions"),
      { code: "ASSET_PLACEMENT_UNSUPPORTED", path: "slides[3].assetIds[0]", detail: /actions/ },
    );

    const unsupportedVariant = plan();
    (slide(unsupportedVariant, "slide-metrics") as Extract<PlanSlide, { layout: "metrics" }>).payload.mode = "cards";
    expectIntegrationFailure(
      () => resolve(unsupportedVariant, "slide-metrics"),
      { code: "ASSET_PLACEMENT_UNSUPPORTED", path: "slides[2].assetIds[0]", detail: /metrics.*cards/i },
    );

    const collision = plan();
    slide(collision, "slide-hero").assetIds.push("asset-summary-mark");
    expectIntegrationFailure(
      () => resolve(collision, "slide-hero"),
      { code: "ASSET_PLACEMENT_COLLISION", path: "slides[0].assetIds[1]", detail: /asset-hero-photo.*asset-summary-mark/i },
    );
  });
});

describe("asset placement versus text geometry", () => {
  interface Box {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }

  function boxesOverlap(left: Box, right: Box): boolean {
    return left.x < right.x + right.width &&
      right.x < left.x + left.width &&
      left.y < right.y + right.height &&
      right.y < left.y + left.height;
  }

  class StaticMeasurer implements TextMeasurer {
    measure(input: TextMeasureInput): { width: number; height: number } {
      return { width: input.text.length * input.fontSize * 0.5, height: input.fontSize };
    }
  }

  const bodyPolicy: TextFitPolicy = {
    mode: "wrap", wordBreak: "normal", overflowWrap: "break-word", fontFloor: 12,
  };

  function compiledBody(): ReturnType<typeof compileGeometrySlide> {
    const element: LayoutElement = {
      id: "fixture:body",
      role: "body",
      text: "alpha",
      box: { x: 80, y: 180, width: 200, height: 60 },
      tokens: { color: "colors.ink", size: "typography.body.size", font: "font.family" },
      accessibility: { role: "body", label: "body: alpha", readingOrder: 0 },
      evidence: null,
    };
    const draft: LayoutDraft = {
      id: "fixture:layout",
      slideId: "fixture",
      layout: "summary",
      canvas: { width: 1280, height: 720 },
      variant: "overlap-fixture",
      elements: [element],
    };
    return compileGeometrySlide(draft, theme, {
      textMeasurer: new StaticMeasurer(),
      textPolicies: { body: bodyPolicy },
    });
  }

  test("chart-mode metrics place no card under the chart rect", () => {
    // Given: a metrics slide in chart mode with a resolved chart placement
    const source = plan();
    const draft = draftLayout(slide(source, "slide-metrics"));
    const chart = resolve(source, "slide-metrics").placements[0]!;

    // When: every drafted element box is compared with the chart rect
    const overlapped = draft.elements.filter((entry) => boxesOverlap(entry.box, chart.box));

    // Then: no text box sits under the chart, and every card stays in the left column
    expect(chart.box).toEqual({ x: 480, y: 152, width: 720, height: 480 });
    expect(overlapped.map((entry) => entry.id)).toEqual([]);
    expect(draft.elements
      .filter((entry) => entry.role.startsWith("metric-"))
      .every((entry) => entry.box.x + entry.box.width <= chart.box.x)).toBe(true);
  });

  test("a hero image placement does not intersect the statement box", () => {
    // Given: a cover hero slide with a resolved image placement
    const source = plan();
    const draft = draftLayout(slide(source, "slide-hero"));
    const image = resolve(source, "slide-hero").placements[0]!;
    const statement = draft.elements.find((entry) => entry.role === "statement")!;

    // When: the statement box is compared with the image rect
    // Then: the image rect is disjoint from the statement and every other hero text box
    expect(image.box).toEqual({ x: 704, y: 0, width: 576, height: 720 });
    expect(boxesOverlap(statement.box, image.box)).toBe(false);
    expect(draft.elements.every((entry) => !boxesOverlap(entry.box, image.box))).toBe(true);
  });

  test("a statement-variant hero image placement does not intersect text boxes", () => {
    const source = plan();
    const heroSlide = slide(source, "slide-hero");
    if (heroSlide.layout !== "hero") throw new Error("expected hero slide");
    const statementSlide = {
      ...heroSlide,
      payload: { variant: "statement" as const, statement: heroSlide.payload.statement },
    };
    source.slides = source.slides.map((entry) => entry.id === statementSlide.id ? statementSlide : entry);
    const draft = draftLayout(statementSlide);
    const image = resolve(source, "slide-hero").placements[0]!;

    expect(image.box).toEqual({ x: 704, y: 0, width: 576, height: 720 });
    expect(draft.elements.every((entry) => !boxesOverlap(entry.box, image.box))).toBe(true);
  });

  test("a summary icon placement does not intersect text boxes", () => {
    const source = plan();
    const summarySlide = slide(source, "slide-summary");
    if (summarySlide.layout !== "summary") throw new Error("expected summary slide");
    const listSlide = {
      ...summarySlide,
      payload: {
        mode: "overview" as const,
        items: ["The launch date is approved.", "Quality remains the gate.", "Mina owns notes."],
      },
      bindings: {
        title: ["claim-launch"],
        "items[0]": ["claim-launch"],
        "items[1]": ["claim-launch"],
        "items[2]": ["claim-launch"],
      },
    };
    const icon = resolve(source, "slide-summary").placements[0]!;
    const statementDraft = draftLayout(summarySlide);
    const listDraft = draftLayout(listSlide);

    expect(icon.box).toEqual({ x: 880, y: 160, width: 240, height: 240 });
    expect(statementDraft.elements.every((entry) => !boxesOverlap(entry.box, icon.box))).toBe(true);
    expect(listDraft.elements.every((entry) => !boxesOverlap(entry.box, icon.box))).toBe(true);
  });

  test("preflight reports an overlap error when an asset rect intersects a text element", () => {
    // Given: a compiled slide whose body element occupies x 80..280, y 180..240
    const compiled = compiledBody();

    // When: preflight compares an intersecting asset rect against the text boxes
    const result = preflightGeometrySlide(compiled, {}, [
      { id: "fixture:asset", box: { x: 140, y: 160, width: 60, height: 80 } },
    ]);

    // Then: the asset-text intersection blocks publication deterministically
    expect(result.status).toBe("blocked");
    expect(result.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      path: issue.path,
      elementIds: issue.elementIds,
    }))).toEqual([{
      code: "undeclared-intersection",
      severity: "error",
      path: "assets[0].box",
      elementIds: ["fixture:asset", "fixture:body"],
    }]);
  });

  test("preflight keeps a slide with a disjoint asset rect publishable", () => {
    // Given: the same compiled body element
    const compiled = compiledBody();

    // When: preflight compares a non-intersecting asset rect
    const result = preflightGeometrySlide(compiled, {}, [
      { id: "fixture:asset", box: { x: 400, y: 400, width: 50, height: 50 } },
    ]);

    // Then: the slide stays publishable with no new issues
    expect(result.status).toBe("publishable");
    expect(result.issues).toEqual([]);
  });
});
