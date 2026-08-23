import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import puppeteer, { type Browser } from "puppeteer";

import type { ResolvedAssetLayer } from "../../src/slides/assets/integration.ts";
import type {
  GeometryElement,
  GeometryPreflightResult,
  GeometrySlide,
} from "../../src/slides/geometry/contract.ts";
import type { Theme } from "../../src/slides/model/plan.ts";
import {
  renderStandaloneHtml,
  type StandaloneDeckInput,
  type StandaloneHtmlArtifact,
} from "../../src/slides/render/standalone-html.ts";
import {
  captureStandaloneScreenshot,
  ScreenshotQaError,
  type ScreenshotQaReceipt,
  type ScreenshotQaViewport,
} from "../../src/slides/render/screenshot-qa.ts";

const TIMEOUT_MS = 10_000;
const BOX_TOLERANCE_PX = 0.5;
const FONT_TOLERANCE_PX = 0.1;
const FONT_SOURCE = resolve(import.meta.dir, "../../public/fonts/pretendard-variable.woff2");
const FONT_LOCAL_PATH = "fonts/pretendard-variable.woff2";
const FONT_FAMILY = "Screenshot QA Pretendard";
const ASSET_LOCAL_PATH = "assets/parity-chart.svg";
const ASSET_BYTES = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
<rect width="320" height="180" rx="18" fill="#E8F0F7"/>
<path d="M38 137L103 88l58 22 77-72 44 31" fill="none" stroke="#335C81" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="103" cy="88" r="10" fill="#AD4B2F"/><circle cx="238" cy="38" r="10" fill="#AD4B2F"/>
</svg>`);

const VIEWPORTS = [
  { name: "design", width: 1280, height: 720, scale: 1 },
  { name: "slides-grab", width: 960, height: 540, scale: 0.75 },
] as const satisfies readonly ScreenshotQaViewport[];

let browser: Browser;
let root = "";
let receiptsDirectory = "";
let artifact: StandaloneHtmlArtifact;
let sourceGeometry: GeometrySlide;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function box(x: number, y: number, width: number, height: number) {
  return { x, y, width, height } as const;
}

function textElement(
  id: string,
  role: "title" | "body" | "label",
  text: string,
  lines: readonly string[],
  elementBox: Readonly<{ x: number; y: number; width: number; height: number }>,
  fontSize: number,
  readingOrder: number,
): GeometryElement {
  return {
    id,
    role,
    text,
    box: elementBox,
    tokens: {
      color: "colors.ink",
      size: role === "title" ? "typography.heading.size" : "typography.body.size",
      font: "font.family",
    },
    resolvedTokens: { color: "14213D", size: fontSize, font: FONT_FAMILY },
    accessibility: { role, label: text, readingOrder },
    evidence: {
      fieldPath: `slides[0].${role}`,
      claimIds: [`claim-${readingOrder}`],
    },
    lines,
    fitTrace: {
      policy: "wrap",
      requestedFontSize: fontSize,
      finalFontSize: fontSize,
      fontFloor: 16,
      outcome: "fit",
      lines,
      attempts: [{
        fontSize,
        lines,
        width: elementBox.width - 2,
        height: elementBox.height - 2,
        fits: true,
      }],
    },
  };
}

function decorationElement(): GeometryElement {
  return {
    id: "slide-parity:rule",
    role: "decoration",
    text: "",
    box: box(72, 154, 1136, 4),
    tokens: { color: "colors.coral" },
    resolvedTokens: { color: "AD4B2F" },
    accessibility: { role: "presentation", label: "", readingOrder: 3 },
    evidence: null,
    lines: [""],
    fitTrace: {
      policy: "wrap",
      requestedFontSize: 16,
      finalFontSize: 16,
      fontFloor: 16,
      outcome: "fit",
      lines: [""],
      attempts: [{ fontSize: 16, lines: [""], width: 0, height: 0, fits: true }],
    },
  };
}

function geometry(): GeometrySlide {
  return {
    id: "slide-parity:geometry",
    slideId: "slide-parity",
    layout: "summary",
    canvas: { width: 1280, height: 720 },
    variant: "browser-parity",
    elements: [
      textElement(
        "slide-parity:title",
        "title",
        "결정 사항 / Decision brief",
        ["결정 사항 / Decision brief"],
        box(72, 56, 760, 72),
        42,
        0,
      ),
      textElement(
        "slide-parity:body",
        "body",
        "한국어 문장은 경계 안에 유지됩니다.\nEnglish copy remains inside the same geometry.",
        [
          "한국어 문장은 경계 안에 유지됩니다.",
          "English copy remains inside the same geometry.",
        ],
        box(72, 198, 720, 112),
        26,
        1,
      ),
      textElement(
        "slide-parity:label",
        "label",
        "로컬 자산 / Local asset",
        ["로컬 자산 / Local asset"],
        box(872, 198, 304, 40),
        18,
        2,
      ),
      decorationElement(),
    ],
  };
}

function theme(fontHash: string): Theme {
  return {
    id: "screenshot-parity-theme",
    canvas: { width: 1280, height: 720 },
    font: { family: FONT_FAMILY, localPath: FONT_LOCAL_PATH, sha256: fontHash },
    colors: {
      paper: "F6F1E8",
      raised: "FFFDF8",
      ink: "14213D",
      muted: "5B6475",
      rule: "D9D2C4",
      coral: "AD4B2F",
      blue: "335C81",
      focus: "1E5AA8",
    },
    spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 },
    typography: {
      display: { size: 64, lineHeight: 68, weight: 700 },
      heading: { size: 42, lineHeight: 50, weight: 700 },
      body: { size: 26, lineHeight: 34, weight: 400 },
      label: { size: 18, lineHeight: 24, weight: 600 },
    },
    stroke: { thin: 1, strong: 4 },
    radius: { small: 8, large: 24 },
  };
}

function assets(assetHash: string): ResolvedAssetLayer {
  return {
    id: "slide-parity:assets",
    slideId: "slide-parity",
    canvas: { width: 1280, height: 720 },
    placements: [{
      id: "slide-parity:asset:chart",
      assetId: "parity-chart",
      purpose: "informative",
      kind: "chart",
      localPath: ASSET_LOCAL_PATH,
      sha256: assetHash,
      mediaType: "image/svg+xml",
      sourceWidth: 320,
      sourceHeight: 180,
      byteLength: ASSET_BYTES.byteLength,
      box: box(872, 258, 304, 171),
      fit: "contain",
      accessibility: {
        role: "img",
        label: "상승 추세를 나타내는 로컬 차트 / Local upward trend chart",
      },
      evidence: { claimIds: ["claim-asset"] },
    }],
  };
}

function deckInput(fontHash: string, assetHash: string): StandaloneDeckInput {
  sourceGeometry = geometry();
  const preflight: GeometryPreflightResult = {
    slide: sourceGeometry,
    issues: [],
    status: "publishable",
  };
  return {
    id: "deck-screenshot-parity",
    title: "Standalone screenshot parity",
    lang: "ko",
    theme: theme(fontHash),
    resourceRoot: root,
    slides: [{ geometry: preflight, assets: assets(assetHash), notes: "Local-only fixture" }],
    includeSlidesGrabDocuments: true,
  };
}

function expectNear(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function assertCleanReceipt(receipt: ScreenshotQaReceipt, viewport: ScreenshotQaViewport): void {
  expect(receipt.viewport).toEqual(viewport);
  expect(receipt.synchronization).toEqual({
    subscriptionsArmedBeforeContent: true,
    loadEventCount: 1,
    fontsStatus: "loaded",
    imagesDecoded: true,
  });
  expect(receipt.events).toMatchObject({
    externalRequests: [],
    failedRequests: [],
    pageErrors: [],
    consoleErrors: [],
  });
  expect(receipt.events.externalRequests).toHaveLength(0);
  expect(receipt.events.failedRequests).toHaveLength(0);
  expect(receipt.events.pageErrors).toHaveLength(0);
  expect(receipt.events.consoleErrors).toHaveLength(0);

  expect(receipt.png.width).toBe(viewport.width);
  expect(receipt.png.height).toBe(viewport.height);
  expect(receipt.png.bytes.byteLength).toBeGreaterThan(10_000);
  expect(receipt.png.sha256).toBe(sha256(receipt.png.bytes));
  expect(receipt.png.pixelSha256).toMatch(/^[a-f\d]{64}$/);
  expect(receipt.png.path.startsWith(`${receiptsDirectory}/`)).toBe(true);
  expect(readFileSync(receipt.png.path)).toEqual(Buffer.from(receipt.png.bytes));
  expect(receipt.inspectionPath.startsWith(`${receiptsDirectory}/`)).toBe(true);

  expect(receipt.slide.slideId).toBe(sourceGeometry.slideId);
  expect(receipt.slide.viewportBox).toEqual(box(0, 0, viewport.width, viewport.height));
  expect(receipt.slide.designBox).toEqual(box(0, 0, 1280, 720));
  expect(receipt.slide.scale).toBe(viewport.scale);
  expect(receipt.slide.rootOverflow).toEqual({ x: 0, y: 0 });
  expect(receipt.violations).toEqual([]);

  for (const expected of sourceGeometry.elements) {
    const actual = receipt.slide.elements.find(
      (entry: ScreenshotQaReceipt["slide"]["elements"][number]) => entry.elementId === expected.id,
    );
    expect(actual, `missing DOM inspection for ${expected.id}`).toBeDefined();
    for (const edge of ["x", "y", "width", "height"] as const) {
      expectNear(actual!.designBox[edge], expected.box[edge], BOX_TOLERANCE_PX);
    }
    expect(actual!.containedInSlide).toBe(true);
    expect(actual!.clippedByAncestors).toEqual([]);
    expect(actual!.scrollOverflow).toEqual({ x: 0, y: 0 });

    if (expected.accessibility.role !== "presentation") {
      expectNear(actual!.fontSizeDesignPx, expected.fitTrace.finalFontSize, FONT_TOLERANCE_PX);
      expect(actual!.fontFamily).toContain(FONT_FAMILY);
      expect(actual!.lines.map(
        (line: ScreenshotQaReceipt["slide"]["elements"][number]["lines"][number]) => line.text,
      )).toEqual(expected.lines);
      expect(actual!.lines.every(
        (line: ScreenshotQaReceipt["slide"]["elements"][number]["lines"][number]) =>
          line.containedInElement && line.containedInSlide,
      )).toBe(true);
    }
  }

  expect(receipt.slide.assets).toEqual([
    expect.objectContaining({
      placementId: "slide-parity:asset:chart",
      designBox: box(872, 258, 304, 171),
      containedInSlide: true,
      loaded: true,
      naturalWidth: 320,
      naturalHeight: 180,
    }),
  ]);
  expect(receipt.slide.textContainment).toEqual({
    korean: { text: "결정 사항 / Decision brief한국어 문장은 경계 안에 유지됩니다.로컬 자산 / Local asset", contained: true },
    english: { text: "Decision briefEnglish copy remains inside the same geometry.Local asset", contained: true },
  });
}

async function capture(
  surface: "standalone-deck" | "slides-grab",
  html: string,
  viewport: ScreenshotQaViewport,
  suffix = "",
): Promise<ScreenshotQaReceipt> {
  return captureStandaloneScreenshot(browser, {
    surface,
    html,
    geometry: sourceGeometry,
    slideId: sourceGeometry.slideId,
    viewport,
    outputDirectory: receiptsDirectory,
    receiptName: `${surface}-${viewport.name}${suffix}`,
    timeoutMs: TIMEOUT_MS,
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "meeting-slides-screenshot-parity-"));
  receiptsDirectory = join(root, "receipts");
  mkdirSync(join(root, "fonts"), { recursive: true });
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(receiptsDirectory, { recursive: true });
  copyFileSync(FONT_SOURCE, join(root, FONT_LOCAL_PATH));
  writeFileSync(join(root, ASSET_LOCAL_PATH), ASSET_BYTES);

  const fontBytes = readFileSync(join(root, FONT_LOCAL_PATH));
  artifact = renderStandaloneHtml(deckInput(sha256(fontBytes), sha256(ASSET_BYTES)));
  expect(artifact.slidesGrabDocuments).toHaveLength(1);

  browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--force-device-scale-factor=1",
      "--font-render-hinting=none",
      "--lang=ko-KR",
    ],
  });
}, TIMEOUT_MS);

afterAll(async () => {
  if (browser !== undefined) await browser.close();
  if (root !== "") rmSync(root, { recursive: true, force: true });
}, TIMEOUT_MS);

describe("standalone deck and slides-grab real-browser screenshot parity", () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.width}x${viewport.height}: shared renderer is pixel-identical, deterministic, and unclipped`, async () => {
      const grabHtml = artifact.slidesGrabDocuments[0]!.html;
      const [deck, grab] = await Promise.all([
        capture("standalone-deck", artifact.html, viewport),
        capture("slides-grab", grabHtml, viewport),
      ]);

      assertCleanReceipt(deck, viewport);
      assertCleanReceipt(grab, viewport);

      // Pixel parity is independent from PNG encoding parity; both are required.
      expect(deck.png.pixelSha256).toBe(grab.png.pixelSha256);
      expect(deck.png.sha256).toBe(grab.png.sha256);
      expect(deck.png.bytes).toEqual(grab.png.bytes);
      expect(deck.slide).toEqual(grab.slide);

      const repeated = await capture("standalone-deck", artifact.html, viewport, "-repeat");
      assertCleanReceipt(repeated, viewport);
      expect(repeated.png.pixelSha256).toBe(deck.png.pixelSha256);
      expect(repeated.png.sha256).toBe(deck.png.sha256);
      expect(repeated.png.bytes).toEqual(deck.png.bytes);
      expect(repeated.slide).toEqual(deck.slide);
    }, TIMEOUT_MS);
  }

  test("reports a typed, actionable failure when corrupted document geometry clips text and spills an asset", async () => {
    const valid = artifact.slidesGrabDocuments[0]!.html;
    const corrupted = valid
      .replace(
        "left:72px;top:198px;width:720px;height:112px;font-size:26px",
        "left:72px;top:198px;width:180px;height:20px;overflow:hidden;font-size:26px",
      )
      .replace(
        "left:872px;top:258px;width:304px;height:171px",
        "left:1210px;top:660px;width:304px;height:171px",
      );
    expect(corrupted).not.toBe(valid);

    try {
      await capture("slides-grab", corrupted, VIEWPORTS[0], "-corrupted");
      throw new Error("expected screenshot QA to reject clipped output");
    } catch (error) {
      expect(error).toBeInstanceOf(ScreenshotQaError);
      const failure = error as ScreenshotQaError;
      expect(failure.name).toBe("ScreenshotQaError");
      expect(failure.code).toBe("SCREENSHOT_QA_LAYOUT_INVALID");
      expect(failure.surface).toBe("slides-grab");
      expect(failure.slideId).toBe("slide-parity");
      expect(failure.path).toBe("slide[slide-parity]");
      expect(failure.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "geometry-mismatch",
          elementId: "slide-parity:body",
          path: "elements[slide-parity:body].box",
        }),
        expect.objectContaining({
          kind: "text-clipped",
          elementId: "slide-parity:body",
          path: "elements[slide-parity:body].lines",
        }),
        expect.objectContaining({
          kind: "asset-out-of-bounds",
          placementId: "slide-parity:asset:chart",
          path: "assets[slide-parity:asset:chart].box",
        }),
      ]));
      expect(failure.message).toMatch(/slide-parity:body/);
      expect(failure.message).toMatch(/expected.*720.*112.*actual.*180.*20/i);
      expect(failure.message).toMatch(/slide-parity:asset:chart/);
      expect(failure.message).toMatch(/right|bottom|out.of.bounds/i);
      expect(failure.receiptPath.startsWith(`${receiptsDirectory}/`)).toBe(true);
      expect(failure.screenshotPath.startsWith(`${receiptsDirectory}/`)).toBe(true);
    }
  }, TIMEOUT_MS);
});
