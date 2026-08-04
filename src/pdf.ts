import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium, type Browser } from "playwright";

const A4_PRINTABLE_HEIGHT_MM = 273;
const FIT_TOLERANCE_PX = 0.5;
const TEMP_PREFIX = "meeting-minutes-pdf-";
const FIT_LEVELS = ["normal", "compact", "dense", "minimum"] as const;

const FIT_CSS = `
  html { --minutes-fit-scale: 1; --minutes-space-scale: 1; }
  html[data-minutes-fit="compact"] { --minutes-fit-scale: .95; --minutes-space-scale: .82; }
  html[data-minutes-fit="dense"] { --minutes-fit-scale: .90; --minutes-space-scale: .68; }
  html[data-minutes-fit="minimum"] { --minutes-fit-scale: .84; --minutes-space-scale: .54; }
  .first-page {
    break-inside: avoid;
    page-break-inside: avoid;
    font-size: calc(10.5pt * var(--minutes-fit-scale));
    line-height: 1.32;
  }
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
  /** Override for packaged builds and explicit launch-failure diagnostics. */
  executablePath?: string;
}

export class MinutesPdfOverflowError extends Error {
  readonly measuredHeightPx: number;
  readonly availableHeightPx: number;

  constructor(measuredHeightPx: number, availableHeightPx: number) {
    super(
      `First-page overflow: decision/action summary is ${measuredHeightPx.toFixed(1)}px high and cannot fit `
      + `within the ${availableHeightPx.toFixed(1)}px A4 printable area after the minimum typography stage.`,
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

function chromiumExecutableSuffixes(): string[] {
  if (process.platform === "darwin") {
    const architecture = process.arch === "arm64" ? "arm64" : "x64";
    return [
      `chrome-headless-shell-mac-${architecture}/chrome-headless-shell`,
      `chrome-mac-${architecture}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    ];
  }
  if (process.platform === "win32") {
    return [
      "chrome-headless-shell-win64/chrome-headless-shell.exe",
      "chrome-win64/chrome.exe",
    ];
  }
  return [
    "chrome-headless-shell-linux64/chrome-headless-shell",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
  ];
}

/** Resolve only the Chromium installation vendored under vendor/ms-playwright. */
export async function resolveVendoredChromiumExecutable(vendorRoot?: string): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const root = vendorRoot ?? join(moduleDirectory, "..", "vendor", "ms-playwright");
  let installations: string[];
  try {
    installations = (await readdir(root))
      .filter((entry) => entry.startsWith("chromium_headless_shell-") || entry.startsWith("chromium-"))
      .sort((left, right) => {
        const headlessDifference = Number(right.startsWith("chromium_headless_shell-"))
          - Number(left.startsWith("chromium_headless_shell-"));
        return headlessDifference || right.localeCompare(left);
      });
  } catch (error) {
    throw new Error(`Vendored Chromium directory is unavailable at ${root}.`, { cause: error });
  }

  for (const installation of installations) {
    for (const suffix of chromiumExecutableSuffixes()) {
      const candidate = join(root, installation, suffix);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue through the finite set of vendored Playwright layouts.
      }
    }
  }
  throw new Error(`No executable vendored Chromium was found under ${root}.`);
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
 * Typography is reduced through a fixed sequence; content that still does not fit
 * is rejected rather than allowing Chromium to split the first page.
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
    const [minutesCss, themeCss, executablePath] = await Promise.all([
      readFile(join(deckDirectory, "minutes.css"), "utf8"),
      readFile(join(deckDirectory, "theme.css"), "utf8"),
      options.executablePath ? Promise.resolve(options.executablePath) : resolveVendoredChromiumExecutable(),
    ]);
    await Promise.all([
      writeFile(htmlPath, html, "utf8"),
      writeFile(join(temporaryDirectory, "minutes.css"), minutesCss, "utf8"),
      writeFile(join(temporaryDirectory, "theme.css"), themeCss, "utf8"),
    ]);

    launchAttempted = true;
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage();
    await page.emulateMedia({ media: "print" });

    const allowedDirectoryUrl = pathToFileURL(`${temporaryDirectory}/`).href;
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith(allowedDirectoryUrl) || url === "about:blank") await route.continue();
      else await route.abort("blockedbyclient");
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
  } finally {
    const browserCleanupError = await closeBrowser(browser);
    const tempCleanupError = await removeTemporaryDirectory(temporaryDirectory);
    if (!operationError) {
      const cleanupError = browserCleanupError ?? tempCleanupError;
      if (cleanupError) {
        operationError = new Error(
          `Minutes PDF cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          { cause: cleanupError },
        );
      }
    }
  }

  if (operationError) throw operationError;
  if (!result) throw new Error("Minutes PDF renderer completed without producing PDF bytes.");
  return result;
}
