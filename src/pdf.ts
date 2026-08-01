import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import puppeteer, { type Browser } from "puppeteer";

const A4_PRINTABLE_HEIGHT_MM = 273;
const FIT_TOLERANCE_PX = 0.5;
const TEMP_PREFIX = "meeting-minutes-pdf-";
const FIT_LEVELS = ["normal", "compact", "dense", "minimum"] as const;

const FIT_CSS = `
  html { --minutes-fit-scale: 1; --minutes-space-scale: 1; }
  html[data-minutes-fit="compact"] { --minutes-fit-scale: .95; --minutes-space-scale: .82; }
  html[data-minutes-fit="dense"] { --minutes-fit-scale: .90; --minutes-space-scale: .68; }
  html[data-minutes-fit="minimum"] { --minutes-fit-scale: .84; --minutes-space-scale: .54; }
  .first-page { font-size: calc(10.5pt * var(--minutes-fit-scale)); line-height: 1.32; }
  .first-page .minutes-header { padding-top: calc(6mm * var(--minutes-space-scale)); margin-bottom: calc(8mm * var(--minutes-space-scale)); }
  .first-page h1 { margin-bottom: calc(3mm * var(--minutes-space-scale)); font-size: calc(25pt * var(--minutes-fit-scale)); }
  .first-page h2 { margin-bottom: calc(3mm * var(--minutes-space-scale)); font-size: calc(14pt * var(--minutes-fit-scale)); }
  .first-page .purpose { margin-bottom: calc(5mm * var(--minutes-space-scale)); font-size: calc(11.5pt * var(--minutes-fit-scale)); }
  .first-page .meeting-meta { gap: calc(2mm * var(--minutes-space-scale)) 7mm; padding: calc(4mm * var(--minutes-space-scale)) 0; }
  .first-page .minutes-block { margin-top: calc(7mm * var(--minutes-space-scale)); }
  .first-page th, .first-page td { padding: calc(2.5mm * var(--minutes-space-scale)) 2mm; }
  .first-page th { font-size: calc(8.5pt * var(--minutes-fit-scale)); }
`;

export interface RenderMinutesPdfOptions {
  /** Override used by packaged builds and for explicit launch diagnostics. */
  executablePath?: string;
}

export class MinutesPdfOverflowError extends Error {
  readonly measuredHeightPx: number;
  readonly availableHeightPx: number;

  constructor(measuredHeightPx: number, availableHeightPx: number) {
    super(
      `First-page overflow: decision/action summary is ${measuredHeightPx.toFixed(1)}px high and cannot fit `
      + `within the ${availableHeightPx.toFixed(1)}px A4 content area at the minimum supported density.`,
    );
    this.name = "MinutesPdfOverflowError";
    this.measuredHeightPx = measuredHeightPx;
    this.availableHeightPx = availableHeightPx;
  }
}

interface FirstPageMeasurement {
  height: number;
  available: number;
}

async function closeBrowser(browser: Browser | undefined): Promise<unknown> {
  if (!browser) return undefined;
  try {
    await browser.close();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function removeTemporaryDirectory(path: string): Promise<unknown> {
  try {
    await rm(path, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * Render minutes HTML as a portrait A4 PDF.
 *
 * The decision/action summary is measured under print media before PDF creation.
 * A fixed sequence of density levels is attempted; content that still does not fit
 * is rejected rather than being silently split across pages.
 */
export async function renderMinutesPdf(
  html: string,
  options: RenderMinutesPdfOptions = {},
): Promise<Uint8Array> {
  if (typeof html !== "string" || !html.trim()) throw new TypeError("Minutes HTML must be a non-empty string.");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const deckDirectory = join(moduleDirectory, "..", "deck");
  const htmlPath = join(temporaryDirectory, "minutes.html");
  let browser: Browser | undefined;
  let result: Uint8Array | undefined;
  let operationError: unknown;
  let launchAttempted = false;

  try {
    const [minutesCss, themeCss] = await Promise.all([
      readFile(join(deckDirectory, "minutes.css"), "utf8"),
      readFile(join(deckDirectory, "theme.css"), "utf8"),
    ]);
    await Promise.all([
      writeFile(htmlPath, html, "utf8"),
      writeFile(join(temporaryDirectory, "minutes.css"), minutesCss, "utf8"),
      writeFile(join(temporaryDirectory, "theme.css"), themeCss, "utf8"),
    ]);

    launchAttempted = true;
    browser = await puppeteer.launch({
      headless: true,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    });

    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.emulateMediaType("print");

    const allowedDirectoryUrl = pathToFileURL(`${temporaryDirectory}/`).href;
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith(allowedDirectoryUrl) || url === "about:blank") void request.continue();
      else void request.abort("blockedbyclient");
    });

    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.addStyleTag({ content: FIT_CSS });
    await page.evaluate(() => document.fonts.ready);

    let measurement: FirstPageMeasurement | undefined;
    for (const level of FIT_LEVELS) {
      measurement = await page.evaluate(({ fitLevel, printableHeightMm }) => {
        const firstPage = document.querySelector<HTMLElement>(".first-page");
        if (!firstPage) throw new Error('Minutes HTML must contain a ".first-page" section.');
        document.documentElement.dataset.minutesFit = fitLevel;

        const probe = document.createElement("div");
        probe.style.cssText = `position:absolute;visibility:hidden;height:${printableHeightMm}mm`;
        document.body.append(probe);
        const available = probe.getBoundingClientRect().height;
        probe.remove();

        const firstRect = firstPage.getBoundingClientRect();
        const descendantBottom = Array.from(firstPage.querySelectorAll<HTMLElement>("*"))
          .reduce((bottom, element) => Math.max(bottom, element.getBoundingClientRect().bottom), firstRect.bottom);
        return {
          height: Math.max(firstPage.scrollHeight, descendantBottom - firstRect.top),
          available,
        };
      }, { fitLevel: level, printableHeightMm: A4_PRINTABLE_HEIGHT_MM });

      if (measurement.height <= measurement.available + FIT_TOLERANCE_PX) break;
    }

    if (!measurement || measurement.height > measurement.available + FIT_TOLERANCE_PX) {
      throw new MinutesPdfOverflowError(measurement?.height ?? Number.POSITIVE_INFINITY, measurement?.available ?? 0);
    }

    const pdf = await page.pdf({
      format: "A4",
      landscape: false,
      printBackground: true,
      preferCSSPageSize: true,
    });
    result = new Uint8Array(pdf);
  } catch (error) {
    operationError = launchAttempted && !browser
      ? new Error(`Chromium launch failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      : error;
  }

  const [browserCleanupError, tempCleanupError] = await Promise.all([
    closeBrowser(browser),
    removeTemporaryDirectory(temporaryDirectory),
  ]);

  if (operationError) throw operationError;
  const cleanupError = browserCleanupError ?? tempCleanupError;
  if (cleanupError) {
    throw new Error(`Minutes PDF cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, {
      cause: cleanupError,
    });
  }
  if (!result) throw new Error("Minutes PDF renderer completed without producing PDF bytes.");
  return result;
}
