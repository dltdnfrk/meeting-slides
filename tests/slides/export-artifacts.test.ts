import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { PDFDocument } from "pdf-lib";
import puppeteer, { type Browser } from "puppeteer";
import sharp from "sharp";

import type { ResolvedAssetLayer } from "../../src/slides/assets/integration.ts";
import type {
  GeometryElement,
  GeometryPreflightResult,
  GeometrySlide,
} from "../../src/slides/geometry/contract.ts";
import type { Theme } from "../../src/slides/model/plan.ts";
import {
  publishEditablePptx,
  renderEditablePptx,
  type EditablePptxArtifact,
} from "../../src/slides/render/editable-pptx.ts";
import {
  captureStandaloneScreenshot,
  type ScreenshotQaReceipt,
} from "../../src/slides/render/screenshot-qa.ts";
import {
  exportDeterministicRaster,
  type RasterExportOutput,
} from "../../src/slides/render/raster-export.ts";
import {
  renderStandaloneHtml,
  writeStandaloneHtml,
  type StandaloneDeckInput,
} from "../../src/slides/render/standalone-html.ts";

const TIMEOUT_MS = 120_000;
const FONT_SOURCE = resolve(import.meta.dir, "../../public/fonts/figtree-latin.woff2");
const FONT_PATH = "fonts/figtree-latin.woff2";
const ASSET_PATH = "assets/local-proof.svg";
const ASSET_BYTES = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
<rect width="320" height="180" rx="20" fill="#E8F0F7"/><path d="M35 137 99 92l60 23 78-76 48 35" fill="none" stroke="#335C81" stroke-width="13" stroke-linecap="round"/><circle cx="237" cy="39" r="11" fill="#AD4B2F"/>
</svg>`);
const DECK_ID = "deck-four-format-fixture";
const PLAN_ID = "plan-four-format-fixture";
const SLIDE_IDS = ["slide-01-geometry", "slide-02-proof"] as const;
const GEOMETRY_IDS = ["geometry-01-foundation", "geometry-02-proof"] as const;
const ACCENTS = ["AD4B2F", "335C81"] as const;
const SLIDES_GRAB = resolve(import.meta.dir, "../../node_modules/.bin/slides-grab");
const SANDBOX_PROFILE = "(version 1)(allow default)(deny network*)";

let temporaryRoot = "";
let browser: Browser | undefined;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function box(x: number, y: number, width: number, height: number) {
  return { x, y, width, height } as const;
}

function element(
  slideId: string,
  suffix: string,
  role: "title" | "body" | "label" | "decoration",
  text: string,
  lines: readonly string[],
  bounds: ReturnType<typeof box>,
  fontSize: number,
  color: string,
  readingOrder: number,
): GeometryElement {
  const decorative = role === "decoration";
  return {
    id: `${slideId}:${suffix}`,
    role,
    text,
    box: bounds,
    tokens: decorative
      ? { color: `colors.${color === ACCENTS[0] ? "coral" : "blue"}` }
      : { color: "colors.ink", size: role === "title" ? "typography.heading.size" : "typography.body.size", font: "font.family" },
    resolvedTokens: decorative
      ? { color }
      : { color, size: fontSize, font: "Four Format Figtree" },
    accessibility: decorative
      ? { role: "presentation", label: "", readingOrder }
      : { role, label: text, readingOrder },
    evidence: decorative ? null : {
      fieldPath: `${PLAN_ID}.slides[${readingOrder}].${suffix}`,
      claimIds: [`claim-${slideId}`],
    },
    lines: [...lines],
    fitTrace: {
      policy: "wrap",
      requestedFontSize: fontSize,
      finalFontSize: fontSize,
      fontFloor: decorative ? 1 : 16,
      outcome: "fit",
      lines: [...lines],
      attempts: [{ fontSize, lines: [...lines], width: bounds.width - 2, height: bounds.height - 2, fits: true }],
    },
  };
}

function geometry(index: number): GeometrySlide {
  const slideId = SLIDE_IDS[index]!;
  const first = index === 0;
  const title = first ? "Geometry is the contract" : "Artifacts keep their identity";
  const bodyLines = first
    ? ["One plan. One 1280 x 720 canvas.", "Every output follows resolved boxes."]
    : ["Local font and chart assets only.", "HTML, PNG, PDF, and editable PPTX."];
  return {
    id: GEOMETRY_IDS[index]!,
    slideId,
    layout: first ? "hero" : "summary",
    canvas: { width: 1280, height: 720 },
    variant: first ? "coral-foundation" : "blue-proof",
    elements: [
      element(slideId, "accent", "decoration", "", [], box(0, 0, 36, 720), 1, ACCENTS[index]!, 0),
      element(slideId, "title", "title", title, [title], box(80, 64, 760, 72), 42, "14213D", 1),
      element(slideId, "body", "body", bodyLines.join("\n"), bodyLines, box(80, 180, 660, 112), 25, "5B6475", 2),
      element(slideId, "identity", "label", `${PLAN_ID} / ${GEOMETRY_IDS[index]}`, [`${PLAN_ID} / ${GEOMETRY_IDS[index]}`], box(80, 644, 720, 28), 17, "14213D", 3),
    ],
  };
}

function theme(fontHash: string): Theme {
  return {
    id: "theme-four-format-fixture",
    canvas: { width: 1280, height: 720 },
    font: { family: "Four Format Figtree", localPath: FONT_PATH, sha256: fontHash },
    colors: {
      paper: "F6F1E8", raised: "FFFDF8", ink: "14213D", muted: "5B6475",
      rule: "D9D2C4", coral: ACCENTS[0], blue: ACCENTS[1], focus: "1E5AA8",
    },
    spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 },
    typography: {
      display: { size: 64, lineHeight: 68, weight: 700 },
      heading: { size: 42, lineHeight: 50, weight: 700 },
      body: { size: 25, lineHeight: 34, weight: 400 },
      label: { size: 17, lineHeight: 22, weight: 600 },
    },
    stroke: { thin: 1, strong: 4 },
    radius: { small: 8, large: 24 },
  };
}

function assets(slideId: string, assetHash: string, includeAsset: boolean): ResolvedAssetLayer {
  return {
    id: `${slideId}:assets`,
    slideId,
    canvas: { width: 1280, height: 720 },
    placements: includeAsset ? [{
      id: `${slideId}:asset:local-proof`,
      assetId: "local-proof-chart",
      purpose: "informative",
      kind: "chart",
      localPath: ASSET_PATH,
      sha256: assetHash,
      mediaType: "image/svg+xml",
      sourceWidth: 320,
      sourceHeight: 180,
      byteLength: ASSET_BYTES.byteLength,
      box: box(870, 180, 320, 180),
      fit: "contain",
      accessibility: { role: "img", label: "Local deterministic upward trend" },
      evidence: { claimIds: [`claim-${slideId}`] },
    }] : [],
  };
}

function fixture(root: string): { input: StandaloneDeckInput; geometries: readonly GeometrySlide[] } {
  const fontBytes = readFileSync(join(root, FONT_PATH));
  const geometries = [geometry(0), geometry(1)] as const;
  const preflight = (slide: GeometrySlide): GeometryPreflightResult => ({ slide, status: "publishable", issues: [] });
  const input: StandaloneDeckInput = {
    id: DECK_ID,
    title: "Four-format geometry proof",
    lang: "en",
    theme: theme(sha256(fontBytes)),
    resourceRoot: root,
    slides: geometries.map((slide, index) => ({
      geometry: preflight(slide),
      assets: assets(slide.slideId, sha256(ASSET_BYTES), index === 0),
      notes: `${PLAN_ID}; ${slide.id}; ${slide.slideId}`,
    })),
    includeSlidesGrabDocuments: true,
  };
  return { input, geometries };
}

function rasterOutput(name: string): RasterExportOutput {
  const directory = join(temporaryRoot, name);
  return {
    pngDirectory: join(directory, "png"),
    pdfPath: join(directory, "four-format.pdf"),
    manifestPath: join(directory, "manifest.json"),
    receiptPath: join(directory, "receipt.json"),
  };
}

async function pixelHash(path: string): Promise<string> {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  expect({ width: info.width, height: info.height }).toEqual({ width: 1280, height: 720 });
  return sha256(data);
}

async function publishPptx(artifact: EditablePptxArtifact, outputPath: string): Promise<void> {
  mkdirSync(dirname(outputPath), { recursive: true });
  await publishEditablePptx(artifact, outputPath);
  writeFileSync(`${outputPath}.manifest.json`, artifact.manifestJson);
  writeFileSync(`${outputPath}.receipt.json`, artifact.receiptJson);
}

afterEach(async () => {
  if (browser !== undefined) await browser.close();
  browser = undefined;
  if (temporaryRoot !== "") rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = "";
});

describe("deterministic real-tool four-format slide artifacts", () => {
  test("publishes standalone HTML, stable editable PPTX, ordered PNGs and PDF without network or clipping", async () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "meeting-slides-four-format-"));
    const resourceRoot = join(temporaryRoot, "fixture");
    const deckDirectory = join(temporaryRoot, "deck");
    const rasterOneOutput = rasterOutput("raster-one");
    const rasterTwoOutput = rasterOutput("raster-two");
    const pngOneDirectory = rasterOneOutput.pngDirectory;
    const pngTwoDirectory = rasterTwoOutput.pngDirectory;
    const qaDirectory = join(temporaryRoot, "screenshot-qa");
    const pdfPath = rasterOneOutput.pdfPath;
    const pdfImagesDirectory = join(temporaryRoot, "pdf-images");
    const pptxPath = join(temporaryRoot, "four-format.pptx");
    mkdirSync(join(resourceRoot, "fonts"), { recursive: true });
    mkdirSync(join(resourceRoot, "assets"), { recursive: true });
    mkdirSync(deckDirectory, { recursive: true });
    mkdirSync(qaDirectory, { recursive: true });
    mkdirSync(pdfImagesDirectory, { recursive: true });
    copyFileSync(FONT_SOURCE, join(resourceRoot, FONT_PATH));
    writeFileSync(join(resourceRoot, ASSET_PATH), ASSET_BYTES);

    const { input, geometries } = fixture(resourceRoot);
    const firstHtml = renderStandaloneHtml(structuredClone(input));
    const secondHtml = renderStandaloneHtml(structuredClone(input));
    expect(secondHtml.sha256).toBe(firstHtml.sha256);
    expect(secondHtml.bytes).toEqual(firstHtml.bytes);
    expect(firstHtml.slidesGrabDocuments.map((entry) => entry.filename)).toEqual(SLIDE_IDS.map((id) => `${id}.html`));
    writeStandaloneHtml(input, join(deckDirectory, "index.html"));
    for (const document of firstHtml.slidesGrabDocuments) writeFileSync(join(deckDirectory, document.filename), document.bytes);
    expect(readFileSync(join(deckDirectory, "index.html"))).toEqual(Buffer.from(firstHtml.bytes));
    expect(firstHtml.html).not.toMatch(/(?:https?|ftp):\/\//i);
    expect(firstHtml.slidesGrabDocuments.every((entry) => !/(?:https?|ftp):\/\//i.test(entry.html))).toBe(true);

    const pptxRequest = {
      deckId: input.id,
      rootDirectory: resourceRoot,
      theme: input.theme,
      slides: input.slides,
    };
    const firstPptx = await renderEditablePptx(structuredClone(pptxRequest));
    const secondPptx = await renderEditablePptx(structuredClone(pptxRequest));
    expect(secondPptx.bytes).toEqual(firstPptx.bytes);
    expect(secondPptx.receipt).toEqual(firstPptx.receipt);
    expect(secondPptx.manifest).toEqual(firstPptx.manifest);
    expect(firstPptx.receipt).toMatchObject({
      deckId: DECK_ID,
      byteLength: firstPptx.bytes.byteLength,
      pptxSha256: sha256(firstPptx.bytes),
      manifestSha256: sha256(firstPptx.manifestJson),
    });
    expect(firstPptx.manifest.slideIds).toEqual(SLIDE_IDS);
    expect(firstPptx.manifest.slides.map((entry) => entry.geometryId)).toEqual([...GEOMETRY_IDS]);
    await publishPptx(firstPptx, pptxPath);
    expect(readFileSync(pptxPath)).toEqual(Buffer.from(firstPptx.bytes));
    expect(JSON.parse(readFileSync(`${pptxPath}.manifest.json`, "utf8"))).toEqual(firstPptx.manifest);
    expect(JSON.parse(readFileSync(`${pptxPath}.receipt.json`, "utf8"))).toEqual(firstPptx.receipt);

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1", "--font-render-hinting=none"],
    });
    const qaReceipts: ScreenshotQaReceipt[] = [];
    for (const [index, document] of firstHtml.slidesGrabDocuments.entries()) {
      const receipt = await captureStandaloneScreenshot(browser, {
        surface: "slides-grab",
        html: document.html,
        geometry: geometries[index]!,
        slideId: SLIDE_IDS[index]!,
        viewport: { name: "slides-grab", width: 960, height: 540, scale: 0.75 },
        outputDirectory: qaDirectory,
        receiptName: SLIDE_IDS[index]!,
        timeoutMs: 10_000,
      });
      expect(receipt.violations).toEqual([]);
      expect(receipt.events).toEqual({ externalRequests: [], failedRequests: [], pageErrors: [], consoleErrors: [] });
      expect(receipt.slide.rootOverflow).toEqual({ x: 0, y: 0 });
      expect(receipt.slide.elements.every((entry) => entry.containedInSlide && entry.clippedByAncestors.length === 0)).toBe(true);
      qaReceipts.push(receipt);
    }

    const identity = {
      planId: PLAN_ID,
      deckId: DECK_ID,
      slideIds: [...SLIDE_IDS],
      geometryIds: [...GEOMETRY_IDS],
    };
    const rasterRequest = {
      identity,
      documents: firstHtml.slidesGrabDocuments,
      tools: {
        slidesGrabPath: SLIDES_GRAB,
        playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH
          ?? resolve(import.meta.dir, "../../vendor/ms-playwright"),
        sandboxExecutable: "/usr/bin/sandbox-exec",
        sandboxProfile: SANDBOX_PROFILE,
      },
      timeoutMs: TIMEOUT_MS,
    } as const;
    const firstRaster = await exportDeterministicRaster({ ...rasterRequest, output: rasterOneOutput });
    const secondRaster = await exportDeterministicRaster({ ...rasterRequest, output: rasterTwoOutput });
    expect(firstRaster.identity).toEqual(identity);
    expect(firstRaster.manifest.renderer).toEqual({ name: "slides-grab", version: "1.5.0", resolution: "720p" });
    expect(secondRaster.manifest).toEqual(firstRaster.manifest);
    expect(secondRaster.receipt).toEqual(firstRaster.receipt);
    expect(readFileSync(rasterTwoOutput.pdfPath)).toEqual(readFileSync(rasterOneOutput.pdfPath));

    const expectedPngNames = SLIDE_IDS.map((id) => `${id}.png`);
    expect(firstRaster.manifest.slides.map((entry) => entry.pngName)).toEqual(expectedPngNames);
    expect(readdirSync(pngOneDirectory).sort()).toEqual(expectedPngNames);
    expect(readdirSync(pngTwoDirectory).sort()).toEqual(expectedPngNames);
    const pngHashes: string[] = [];
    for (const [index, name] of expectedPngNames.entries()) {
      const first = readFileSync(join(pngOneDirectory, name));
      const second = readFileSync(join(pngTwoDirectory, name));
      expect(second).toEqual(first);
      expect(sha256(second)).toBe(sha256(first));
      expect(firstRaster.manifest.slides[index]).toMatchObject({
        width: 1280,
        height: 720,
        pngSha256: sha256(first),
      });
      pngHashes.push(await pixelHash(join(pngOneDirectory, name)));
      expect(firstRaster.manifest.slides[index]!.pixelSha256).toBe(pngHashes[index]);
    }
    expect(new Set(pngHashes).size).toBe(2);

    const pdfBytes = readFileSync(pdfPath);
    expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdfBytes.byteLength).toBeGreaterThan(10_000);
    const parsedPdf = await PDFDocument.load(pdfBytes);
    expect(parsedPdf.getPageCount()).toBe(SLIDE_IDS.length);
    expect(parsedPdf.getPages().map((page) => page.getSize())).toEqual([
      { width: 960, height: 540 }, { width: 960, height: 540 },
    ]);

    const extraction = Bun.spawnSync(["/opt/homebrew/bin/pdfimages", "-png", pdfPath, join(pdfImagesDirectory, "page")], {
      cwd: temporaryRoot, stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS,
    });
    expect(extraction.exitCode, extraction.stderr.toString()).toBe(0);
    const extracted = readdirSync(pdfImagesDirectory).filter((name) => name.endsWith(".png")).sort();
    expect(extracted).toHaveLength(2);
    const pdfPageHashes: string[] = [];
    for (const name of extracted) pdfPageHashes.push(await pixelHash(join(pdfImagesDirectory, name)));
    expect(pdfPageHashes).toEqual(pngHashes);

    const metadataMatch = firstHtml.html.match(/<script id="deck-metadata" type="application\/json">([^<]+)<\/script>/);
    expect(metadataMatch).not.toBeNull();
    const htmlMetadata = JSON.parse(metadataMatch![1]!) as { deckId: string; slides: Array<{ slideId: string; notes: string }> };
    expect(htmlMetadata.deckId).toBe(identity.deckId);
    expect(htmlMetadata.slides.map((entry) => entry.slideId)).toEqual(identity.slideIds);
    expect(htmlMetadata.slides.map((entry) => entry.notes.split("; ")[1])).toEqual(identity.geometryIds);
    expect(firstPptx.manifest.deckId).toBe(identity.deckId);
    expect(firstPptx.manifest.slideIds).toEqual(identity.slideIds);
    expect(firstPptx.manifest.slides.map((entry) => entry.geometryId)).toEqual(identity.geometryIds);
    expect(expectedPngNames.map((name) => name.replace(/\.png$/, ""))).toEqual(identity.slideIds);
    expect(qaReceipts.map((entry) => entry.slideId)).toEqual(identity.slideIds);
    expect(extracted.map((_name, index) => identity.slideIds[index])).toEqual(identity.slideIds);
    expect(relative(temporaryRoot, deckDirectory)).toBe("deck");
  }, TIMEOUT_MS);
});
