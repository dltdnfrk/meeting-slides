import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import {
  exportDeterministicRaster,
  RasterExportError,
  type RasterSlideDocument,
} from "../../src/slides/render/raster-export.ts";
import { validateRasterRequest } from "../../src/slides/render/raster-export-validation.ts";

const TIMEOUT_MS = 120_000;
const PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH
  ?? resolve(import.meta.dir, "../../vendor/ms-playwright");
const SLIDES_GRAB_PATH = resolve(import.meta.dir, "../../node_modules/.bin/slides-grab");
const SANDBOX_PROFILE = "(version 1)(allow default)(deny network*)";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let root = "";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function document(slideId: string, color: string): RasterSlideDocument {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}
.slide{position:relative;width:1280px;height:720px;overflow:visible;background:${color};font-family:Arial,sans-serif}
.title{position:absolute;left:80px;top:80px;width:900px;height:80px;font-size:48px;color:#14213d}
</style></head><body><section class="slide"><div class="title">${slideId}</div></section></body></html>`;
  const bytes = new TextEncoder().encode(html);
  return { filename: `${slideId}.html`, html, bytes, sha256: sha256(bytes) };
}

async function pixelHash(path: string): Promise<string> {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  expect({ width: info.width, height: info.height }).toEqual({ width: 1280, height: 720 });
  return sha256(data);
}

function output(rootDirectory: string) {
  return {
    pngDirectory: join(rootDirectory, "raster", "png"),
    pdfPath: join(rootDirectory, "raster", "deck.pdf"),
    manifestPath: join(rootDirectory, "raster", "manifest.json"),
    receiptPath: join(rootDirectory, "raster", "receipt.json"),
  } as const;
}

afterEach(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("product-owned deterministic raster export", () => {
  test("accepts stable plan ids without a slide- prefix", () => {
    // Given: a verified document named after a legal stable slide ID.
    root = mkdtempSync(join(tmpdir(), "meeting-slides-raster-stable-id-"));
    const valid = document("hero-1", "#fff");

    // When: the raster request is validated.
    const validate = () => validateRasterRequest({
      identity: {
        planId: "plan-stable-id",
        deckId: "deck-stable-id",
        slideIds: ["hero-1"],
        geometryIds: ["geometry-hero-1"],
      },
      documents: [valid],
      output: output(root),
      tools: {
        slidesGrabPath: SLIDES_GRAB_PATH,
        playwrightBrowsersPath: PLAYWRIGHT_BROWSERS_PATH,
        sandboxExecutable: "/usr/bin/sandbox-exec",
        sandboxProfile: SANDBOX_PROFILE,
      },
      timeoutMs: TIMEOUT_MS,
    });

    // Then: the stable ID is accepted without a slide- filename prefix.
    expect(validate).not.toThrow();
  });

  test("uses real slides-grab PNG bytes once and publishes hash-bound PNG, PDF, manifest, and receipt atomically", async () => {
    expect(PLAYWRIGHT_BROWSERS_PATH).not.toBe("");
    root = mkdtempSync(join(tmpdir(), "meeting-slides-raster-export-"));
    const destinations = output(root);
    const documents = [
      document("slide-01-coral", "#f6f1e8"),
      document("slide-02-blue", "#e8f0f7"),
    ] as const;
    const request = {
      identity: {
        planId: "plan-raster-fixture",
        deckId: "deck-raster-fixture",
        slideIds: ["slide-01-coral", "slide-02-blue"],
        geometryIds: ["geometry-01-coral", "geometry-02-blue"],
      },
      documents,
      output: destinations,
      tools: {
        slidesGrabPath: SLIDES_GRAB_PATH,
        playwrightBrowsersPath: PLAYWRIGHT_BROWSERS_PATH,
        sandboxExecutable: "/usr/bin/sandbox-exec",
        sandboxProfile: SANDBOX_PROFILE,
      },
      timeoutMs: TIMEOUT_MS,
    } as const;

    const first = await exportDeterministicRaster(request);

    expect(first.identity).toEqual(request.identity);
    expect(first.geometry).toEqual({
      source: { width: 1280, height: 720 },
      raster: { width: 1280, height: 720 },
      pdfPage: { width: 960, height: 540 },
    });
    expect(first.manifest.slides.map((entry) => ({
      slideId: entry.slideId,
      geometryId: entry.geometryId,
      htmlName: entry.htmlName,
      pngName: entry.pngName,
    }))).toEqual([
      { slideId: "slide-01-coral", geometryId: "geometry-01-coral", htmlName: "slide-01-coral.html", pngName: "slide-01-coral.png" },
      { slideId: "slide-02-blue", geometryId: "geometry-02-blue", htmlName: "slide-02-blue.html", pngName: "slide-02-blue.png" },
    ]);
    expect(readdirSync(destinations.pngDirectory).sort()).toEqual([
      "slide-01-coral.png", "slide-02-blue.png",
    ]);

    const sourcePixelHashes: string[] = [];
    for (const entry of first.manifest.slides) {
      const bytes = readFileSync(join(destinations.pngDirectory, entry.pngName));
      expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
      expect(entry.pngSha256).toBe(sha256(bytes));
      expect(entry.pngByteLength).toBe(bytes.byteLength);
      expect(entry.width).toBe(1280);
      expect(entry.height).toBe(720);
      sourcePixelHashes.push(await pixelHash(join(destinations.pngDirectory, entry.pngName)));
      expect(entry.pixelSha256).toBe(sourcePixelHashes[sourcePixelHashes.length - 1]);
    }
    expect(new Set(sourcePixelHashes).size).toBe(2);

    const pdfBytes = readFileSync(destinations.pdfPath);
    expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(first.manifest.pdf.sha256).toBe(sha256(pdfBytes));
    expect(first.manifest.pdf.byteLength).toBe(pdfBytes.byteLength);
    const pdf = await PDFDocument.load(pdfBytes);
    expect(pdf.getPages().map((page) => page.getSize())).toEqual([
      { width: 960, height: 540 }, { width: 960, height: 540 },
    ]);

    const extractedDirectory = join(root, "pdf-images");
    mkdirSync(extractedDirectory);
    const extraction = Bun.spawnSync([
      "/opt/homebrew/bin/pdfimages", "-png", destinations.pdfPath, join(extractedDirectory, "page"),
    ], { stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS });
    expect(extraction.exitCode, extraction.stderr.toString()).toBe(0);
    const extracted = readdirSync(extractedDirectory).filter((name) => name.endsWith(".png")).sort();
    const pdfPixelHashes: string[] = [];
    for (const name of extracted) pdfPixelHashes.push(await pixelHash(join(extractedDirectory, name)));
    expect(pdfPixelHashes).toEqual(sourcePixelHashes);

    expect(JSON.parse(readFileSync(destinations.manifestPath, "utf8"))).toEqual(first.manifest);
    expect(JSON.parse(readFileSync(destinations.receiptPath, "utf8"))).toEqual(first.receipt);
    expect(first.receipt).toMatchObject({
      schemaVersion: 1,
      identity: request.identity,
      manifestSha256: sha256(first.manifestJson),
      pdfSha256: sha256(pdfBytes),
      pngSha256: first.manifest.slides.map((entry) => entry.pngSha256),
    });
    expect(readFileSync(destinations.manifestPath, "utf8")).toBe(first.manifestJson);
    expect(readFileSync(destinations.receiptPath, "utf8")).toBe(first.receiptJson);
    expect(readdirSync(join(root, "raster")).every((name) => !name.includes("staging"))).toBe(true);
  }, TIMEOUT_MS);

  test("rejects unverified HTML before invoking tools and leaves no output or staging", async () => {
    root = mkdtempSync(join(tmpdir(), "meeting-slides-raster-failure-"));
    const destinations = output(root);
    const valid = document("slide-01-invalid", "#fff");

    try {
      await exportDeterministicRaster({
        identity: {
          planId: "plan-invalid",
          deckId: "deck-invalid",
          slideIds: ["slide-01-invalid"],
          geometryIds: ["geometry-01-invalid"],
        },
        documents: [{ ...valid, sha256: "0".repeat(64) }],
        output: destinations,
        tools: {
          slidesGrabPath: SLIDES_GRAB_PATH,
          playwrightBrowsersPath: PLAYWRIGHT_BROWSERS_PATH,
          sandboxExecutable: "/usr/bin/sandbox-exec",
          sandboxProfile: SANDBOX_PROFILE,
        },
        timeoutMs: 1_000,
      });
      throw new Error("expected raster export to reject unverified HTML");
    } catch (error) {
      expect(error).toBeInstanceOf(RasterExportError);
      expect(error).toMatchObject({ code: "RASTER_HTML_HASH_MISMATCH", path: "documents[0].sha256" });
    }

    expect(existsSync(destinations.pngDirectory)).toBe(false);
    expect(existsSync(destinations.pdfPath)).toBe(false);
    expect(existsSync(destinations.manifestPath)).toBe(false);
    expect(existsSync(destinations.receiptPath)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});
