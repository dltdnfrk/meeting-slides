import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Browser, ConsoleMessage, HTTPRequest, Page } from "puppeteer";
import type { GeometrySlide } from "../geometry/contract.ts";
import { deepFreeze } from "../theme/immutable.ts";
import {
  pngPixelBytes, readyAndInspect, type BrowserBox,
  type BrowserElementInspection, type BrowserInspection,
} from "./screenshot-qa-browser.ts";

export interface ScreenshotQaViewport { readonly name: string; readonly width: 1280 | 960; readonly height: 720 | 540; readonly scale: 1 | 0.75 }
export type ScreenshotQaSurface = "standalone-deck" | "slides-grab";
export interface ScreenshotQaViolation {
  readonly kind: "geometry-mismatch" | "text-clipped" | "line-mismatch" | "font-mismatch" | "element-out-of-bounds" | "asset-out-of-bounds" | "asset-unavailable";
  readonly path: string; readonly message: string; readonly elementId?: string; readonly placementId?: string;
}
export interface ScreenshotQaReceipt {
  readonly surface: ScreenshotQaSurface; readonly slideId: string; readonly viewport: ScreenshotQaViewport;
  readonly synchronization: { readonly subscriptionsArmedBeforeContent: true; readonly loadEventCount: number; readonly fontsStatus: "loaded"; readonly imagesDecoded: true };
  readonly events: { readonly externalRequests: readonly string[]; readonly failedRequests: readonly string[]; readonly pageErrors: readonly string[]; readonly consoleErrors: readonly string[] };
  readonly png: { readonly path: string; readonly width: number; readonly height: number; readonly bytes: Uint8Array; readonly sha256: string; readonly pixelSha256: string };
  readonly inspectionPath: string;
  readonly slide: BrowserInspection & { readonly slideId: string; readonly scale: number };
  readonly violations: readonly ScreenshotQaViolation[];
}
export interface CaptureStandaloneScreenshotOptions {
  readonly surface: ScreenshotQaSurface; readonly html: string; readonly geometry: GeometrySlide; readonly slideId: string;
  readonly viewport: ScreenshotQaViewport; readonly outputDirectory: string; readonly receiptName: string; readonly timeoutMs: number;
}

export class ScreenshotQaError extends Error {
  readonly code = "SCREENSHOT_QA_LAYOUT_INVALID" as const;
  readonly path: string; readonly surface: ScreenshotQaSurface; readonly slideId: string;
  readonly violations: readonly ScreenshotQaViolation[]; readonly receiptPath: string; readonly screenshotPath: string;
  constructor(input: { surface: ScreenshotQaSurface; slideId: string; violations: readonly ScreenshotQaViolation[]; receiptPath: string; screenshotPath: string }) {
    super(`Screenshot QA rejected slide '${input.slideId}': ${input.violations.map((entry) => entry.message).join("; ")}`);
    this.name = "ScreenshotQaError"; this.path = `slide[${input.slideId}]`; this.surface = input.surface; this.slideId = input.slideId;
    this.violations = input.violations; this.receiptPath = input.receiptPath; this.screenshotPath = input.screenshotPath;
  }
}

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const difference = (actual: number, expected: number): boolean => Math.abs(actual - expected) > .5;
const boxText = (box: BrowserBox): string => `${box.x},${box.y},${box.width},${box.height}`;

function artifactPath(directory: string, name: string, extension: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") throw new Error(`invalid screenshot receipt name '${name}'`);
  const root = resolve(directory); const candidate = resolve(root, `${name}.${extension}`);
  if (!candidate.startsWith(`${root}${sep}`)) throw new Error(`screenshot artifact escapes '${root}'`);
  return candidate;
}

function violations(geometry: GeometrySlide, inspection: BrowserInspection): ScreenshotQaViolation[] {
  const found: ScreenshotQaViolation[] = [];
  for (const expected of geometry.elements) {
    const actual = inspection.elements.find((entry: BrowserElementInspection) => entry.elementId === expected.id);
    if (actual === undefined) {
      found.push({ kind: "geometry-mismatch", elementId: expected.id, path: `elements[${expected.id}].box`, message: `${expected.id} is absent from the document` }); continue;
    }
    if ((["x", "y", "width", "height"] as const).some((edge) => difference(actual.designBox[edge], expected.box[edge]))) {
      found.push({ kind: "geometry-mismatch", elementId: expected.id, path: `elements[${expected.id}].box`,
        message: `${expected.id} expected box ${boxText(expected.box)} (width ${expected.box.width}, height ${expected.box.height}); actual ${boxText(actual.designBox)} (width ${actual.designBox.width}, height ${actual.designBox.height})` });
    }
    if (!actual.containedInSlide) found.push({ kind: "element-out-of-bounds", elementId: expected.id, path: `elements[${expected.id}].box`, message: `${expected.id} is out of bounds` });
    if (expected.accessibility.role !== "presentation") {
      if (actual.lines.map((line) => line.text).join("\n") !== expected.lines.join("\n")) found.push({ kind: "line-mismatch", elementId: expected.id, path: `elements[${expected.id}].lines`, message: `${expected.id} line breaks differ from geometry` });
      if (Math.abs(actual.fontSizeDesignPx - expected.fitTrace.finalFontSize) > .1) found.push({ kind: "font-mismatch", elementId: expected.id, path: `elements[${expected.id}].fontSize`, message: `${expected.id} expected font ${expected.fitTrace.finalFontSize}; actual ${actual.fontSizeDesignPx}` });
      if (actual.lines.some((line) => !line.containedInElement || !line.containedInSlide) || actual.scrollOverflow.x > .5 || actual.scrollOverflow.y > .5 || actual.clippedByAncestors.length > 0) {
        found.push({ kind: "text-clipped", elementId: expected.id, path: `elements[${expected.id}].lines`, message: `${expected.id} text is clipped or overflowing` });
      }
    }
  }
  for (const asset of inspection.assets) {
    if (!asset.loaded) found.push({ kind: "asset-unavailable", placementId: asset.placementId, path: `assets[${asset.placementId}].src`, message: `${asset.placementId} did not decode` });
    if (!asset.containedInSlide) found.push({ kind: "asset-out-of-bounds", placementId: asset.placementId, path: `assets[${asset.placementId}].box`, message: `${asset.placementId} is out of bounds at right or bottom (${boxText(asset.designBox)})` });
  }
  return found;
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, page: Page): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`screenshot QA timed out after ${timeoutMs}ms at ${page.url()}`)), timeoutMs); });
  try { return await Promise.race([promise, timeout]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function captureStandaloneScreenshot(browser: Browser, options: CaptureStandaloneScreenshotOptions): Promise<ScreenshotQaReceipt> {
  const pngPath = artifactPath(options.outputDirectory, options.receiptName, "png");
  const inspectionPath = artifactPath(options.outputDirectory, options.receiptName, "inspection.json");
  mkdirSync(resolve(options.outputDirectory), { recursive: true });
  const page = await browser.newPage(); let loadEventCount = 0;
  const externalRequests: string[] = [], failedRequests: string[] = [], pageErrors: string[] = [], consoleErrors: string[] = [];
  const isExternal = (url: string): boolean => /^(https?|file|ftp):/i.test(url);
  const onRequest = (request: HTTPRequest): void => { if (isExternal(request.url())) { externalRequests.push(request.url()); void request.abort("blockedbyclient"); } else void request.continue(); };
  page.on("load", () => { loadEventCount += 1; });
  page.on("request", onRequest);
  page.on("requestfailed", (request) => { failedRequests.push(`${request.url()}: ${request.failure()?.errorText ?? "failed"}`); });
  page.on("console", (message: ConsoleMessage) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => { pageErrors.push(error instanceof Error ? error.message : String(error)); });
  try {
    await page.setRequestInterception(true);
    await page.setViewport({ width: options.viewport.width, height: options.viewport.height, deviceScaleFactor: 1 });
    await page.setContent(options.html, { waitUntil: "load", timeout: options.timeoutMs });
    const selectorId = options.slideId.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    // This geometry-comparison surface owns scaling at .deck. Do not multiply
    // it by a document's independent slides-grab viewport transform.
    await page.addStyleTag({ content: `html,body{margin:0!important;padding:0!important;width:${options.viewport.width}px!important;height:${options.viewport.height}px!important;min-height:0!important;overflow:hidden!important;display:block!important}.deck{position:fixed!important;left:0!important;top:0!important;width:1280px!important;height:720px!important;transform:scale(${options.viewport.scale})!important;transform-origin:top left!important}.slide{display:none!important;box-shadow:none!important;transform:none!important}.slide[data-slide-id="${selectorId}"]{display:block!important}.controls,[data-presenter-notes]{display:none!important}` });
    const inspection = await bounded(page.evaluate(readyAndInspect, options.slideId, options.viewport.scale), options.timeoutMs, page);
    const png = new Uint8Array(await page.screenshot({ type: "png", captureBeyondViewport: false }));
    writeFileSync(pngPath, png);
    const issueList = violations(options.geometry, inspection);
    if (externalRequests.length > 0 || failedRequests.length > 0 || pageErrors.length > 0 || consoleErrors.length > 0) {
      issueList.push({ kind: "asset-unavailable", path: `slide[${options.slideId}].events`, message: `browser errors: ${[...externalRequests, ...failedRequests, ...pageErrors, ...consoleErrors].join("; ")}` });
    }
    const slide = { ...inspection, slideId: options.slideId, scale: options.viewport.scale };
    const receipt: ScreenshotQaReceipt = {
      surface: options.surface, slideId: options.slideId, viewport: { ...options.viewport },
      synchronization: { subscriptionsArmedBeforeContent: true, loadEventCount, fontsStatus: "loaded", imagesDecoded: true },
      events: { externalRequests, failedRequests, pageErrors, consoleErrors },
      png: { path: pngPath, width: options.viewport.width, height: options.viewport.height, bytes: png, sha256: hash(png), pixelSha256: hash(pngPixelBytes(png)) },
      inspectionPath, slide, violations: issueList,
    };
    writeFileSync(inspectionPath, JSON.stringify({ ...receipt, png: { ...receipt.png, bytes: undefined } }, null, 2));
    deepFreeze(receipt.events); deepFreeze(receipt.slide); deepFreeze(receipt.violations); Object.freeze(receipt.viewport); Object.freeze(receipt.synchronization); Object.freeze(receipt.png); Object.freeze(receipt);
    if (issueList.length > 0) throw new ScreenshotQaError({ surface: options.surface, slideId: options.slideId, violations: receipt.violations, receiptPath: inspectionPath, screenshotPath: pngPath });
    return receipt;
  } finally { await page.close(); }
}
