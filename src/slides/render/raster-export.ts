import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { assembleRasterPdf } from "./raster-export-pdf.ts";
import {
  RASTER_GEOMETRY,
  rasterRenderFilename,
  rasterSha256,
  validatePng,
  validateRasterRequest,
} from "./raster-export-validation.ts";
import {
  RasterExportError,
  rasterFailure,
  type RasterExportManifest,
  type RasterExportPublication,
  type RasterExportReceipt,
  type RasterExportRequest,
} from "./raster-export-types.ts";

export { RasterExportError } from "./raster-export-types.ts";
export type {
  RasterExportIdentity,
  RasterExportManifest,
  RasterExportOutput,
  RasterExportPublication,
  RasterExportReceipt,
  RasterExportRequest,
  RasterExportTools,
  RasterGeometryIdentity,
  RasterManifestSlide,
  RasterSlideDocument,
} from "./raster-export-types.ts";

interface ToolResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runSlidesGrab(
  request: ReturnType<typeof validateRasterRequest>,
  slidesDirectory: string,
  pngDirectory: string,
): Promise<ToolResult> {
  const command = [
    request.tools.sandboxExecutable,
    "-p",
    request.tools.sandboxProfile,
    request.tools.slidesGrabPath,
    "png",
    "--slides-dir",
    slidesDirectory,
    "--output-dir",
    pngDirectory,
    "--resolution",
    "720p",
  ];
  const child = Bun.spawn(command, {
    cwd: dirname(request.publicationRoot),
    env: {
      ...request.tools.environment,
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PLAYWRIGHT_BROWSERS_PATH: request.tools.playwrightBrowsersPath,
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: request.timeoutMs,
    killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function assertPngSet(directory: string, expected: readonly string[]): void {
  const actual = readdirSync(directory).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    rasterFailure(
      "RASTER_PNG_SET_MISMATCH",
      "output.pngDirectory",
      `expected exactly [${sortedExpected.join(", ")}], received [${actual.join(", ")}]`,
    );
  }
}

export async function exportDeterministicRaster(request: RasterExportRequest): Promise<RasterExportPublication> {
  const verified = validateRasterRequest(request);
  const parent = dirname(verified.publicationRoot);
  const stagingRoot = join(parent, `.${basename(verified.publicationRoot)}.staging-${randomUUID()}`);
  const slidesDirectory = join(stagingRoot, ".verified-html");
  const stagedPngDirectory = join(stagingRoot, basename(verified.output.pngDirectory));
  const stagedPdfPath = join(stagingRoot, basename(verified.output.pdfPath));
  const stagedManifestPath = join(stagingRoot, basename(verified.output.manifestPath));
  const stagedReceiptPath = join(stagingRoot, basename(verified.output.receiptPath));

  try {
    mkdirSync(slidesDirectory, { recursive: true });
    for (const [index, document] of verified.documents.entries()) {
      writeFileSync(
        join(slidesDirectory, rasterRenderFilename(document, index)),
        document.bytes,
        { flag: "wx" },
      );
    }

    const tool = await runSlidesGrab(verified, slidesDirectory, stagedPngDirectory);
    if (tool.exitCode !== 0) {
      const timedOut = tool.exitCode === 137 || /timed?\s*out|timeout/i.test(tool.stderr);
      rasterFailure(
        timedOut ? "RASTER_TOOL_TIMEOUT" : "RASTER_TOOL_FAILED",
        "tools.slidesGrabPath",
        `slides-grab exited ${tool.exitCode}\nstdout:\n${tool.stdout}\nstderr:\n${tool.stderr}`,
      );
    }

    const expectedPngNames = verified.documents.map((document, index) =>
      rasterRenderFilename(document, index).replace(/\.html$/i, ".png"));
    assertPngSet(stagedPngDirectory, expectedPngNames);
    const pngBytes: Uint8Array[] = [];
    const slides = verified.documents.map((document, index) => {
      const pngName = expectedPngNames[index]!;
      const bytes = new Uint8Array(readFileSync(join(stagedPngDirectory, pngName)));
      const png = validatePng(bytes, `output.pngDirectory/${pngName}`);
      pngBytes.push(bytes);
      return {
        slideId: verified.identity.slideIds[index]!,
        geometryId: verified.identity.geometryIds[index]!,
        htmlName: document.filename,
        htmlSha256: document.sha256,
        pngName,
        pngByteLength: bytes.byteLength,
        pngSha256: rasterSha256(bytes),
        pixelSha256: png.pixelSha256,
        width: png.width,
        height: png.height,
      } as const;
    });

    const pdfBytes = await assembleRasterPdf(pngBytes);
    const pdfSha256 = rasterSha256(pdfBytes);
    const manifest: RasterExportManifest = {
      schemaVersion: 1,
      format: "deterministic-raster",
      identity: verified.identity,
      geometry: RASTER_GEOMETRY,
      renderer: { name: "slides-grab", version: "1.5.0", resolution: "720p" },
      slides,
      pdf: {
        name: basename(verified.output.pdfPath),
        byteLength: pdfBytes.byteLength,
        sha256: pdfSha256,
        pages: slides.length,
      },
    };
    const manifestJson = `${JSON.stringify(manifest)}\n`;
    const receipt: RasterExportReceipt = {
      schemaVersion: 1,
      identity: verified.identity,
      manifestSha256: rasterSha256(manifestJson),
      pdfSha256,
      pngSha256: slides.map((slide) => slide.pngSha256),
    };
    const receiptJson = `${JSON.stringify(receipt)}\n`;

    writeFileSync(stagedPdfPath, pdfBytes, { flag: "wx" });
    writeFileSync(stagedManifestPath, manifestJson, { flag: "wx" });
    writeFileSync(stagedReceiptPath, receiptJson, { flag: "wx" });
    rmSync(slidesDirectory, { recursive: true, force: true });

    if (existsSync(verified.publicationRoot)) {
      rasterFailure("RASTER_OUTPUT_EXISTS", "output", `publication directory appeared during export: ${verified.publicationRoot}`);
    }
    renameSync(stagingRoot, verified.publicationRoot);

    return {
      identity: verified.identity,
      geometry: RASTER_GEOMETRY,
      output: verified.output,
      manifest,
      manifestJson,
      receipt,
      receiptJson,
    };
  } catch (error) {
    if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
    if (error instanceof RasterExportError) throw error;
    rasterFailure(
      "RASTER_PUBLICATION_FAILED",
      "output",
      error instanceof Error ? error.message : "unknown raster publication failure",
    );
  }
}
