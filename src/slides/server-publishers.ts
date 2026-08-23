import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { renderEditablePptx } from "./render/editable-pptx.ts";
import { exportDeterministicRaster, type RasterExportTools, type RasterSlideDocument } from "./render/raster-export.ts";
import { renderStandaloneHtml } from "./render/standalone-html.ts";
import { pipelineHash } from "./server-pipeline-publication.ts";
import type { PipelineArtifactPublisher, PipelinePublisherRequest } from "./server-pipeline-types.ts";

export interface SlidePlanPublisherTools extends RasterExportTools {
  readonly timeoutMs: number;
}

function deckSlides(request: PipelinePublisherRequest) {
  return request.slides.map((geometry, index) => ({
    geometry,
    assets: request.assetLayers[index]!,
    notes: `${request.identity.planId}; ${geometry.slide.id}; ${geometry.slide.slideId}`,
  }));
}

function standaloneInput(request: PipelinePublisherRequest) {
  return {
    id: request.identity.deckId,
    title: request.plan.title,
    lang: "und",
    theme: request.plan.theme,
    resourceRoot: request.managedAssetRoot,
    slides: deckSlides(request),
    includeSlidesGrabDocuments: true,
  } as const;
}

export function createStandalonePublisher(): PipelineArtifactPublisher {
  return async (request) => {
    const rendered = renderStandaloneHtml(standaloneInput(request));
    return {
      format: "standalone-html",
      identity: request.identity,
      files: [
        { relativePath: "standalone/index.html", bytes: rendered.bytes },
        ...rendered.slidesGrabDocuments.map((document) => ({
          relativePath: `standalone/slides/${document.filename}`,
          bytes: document.bytes,
        })),
      ],
    };
  };
}

export function createEditablePptxPublisher(): PipelineArtifactPublisher {
  return async (request) => {
    const rendered = await renderEditablePptx({
      deckId: request.identity.deckId,
      rootDirectory: request.managedAssetRoot,
      theme: request.plan.theme,
      slides: deckSlides(request),
    });
    return {
      format: "editable-pptx",
      identity: request.identity,
      files: [
        { relativePath: "editable/deck.pptx", bytes: rendered.bytes },
        { relativePath: "editable/manifest.json", bytes: new TextEncoder().encode(rendered.manifestJson) },
        { relativePath: "editable/receipt.json", bytes: new TextEncoder().encode(rendered.receiptJson) },
      ],
    };
  };
}

function standaloneDocuments(request: PipelinePublisherRequest): RasterSlideDocument[] {
  const standalone = request.priorArtifacts.find((artifact) => artifact.format === "standalone-html");
  if (standalone === undefined) throw new TypeError("raster publisher requires the standalone artifact");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return request.identity.slideIds.map((slideId) => {
    const filename = `${slideId}.html`;
    const file = standalone.files.find((entry) => entry.relativePath === `standalone/slides/${filename}`);
    if (file === undefined) throw new TypeError(`standalone artifact is missing '${filename}'`);
    const html = decoder.decode(file.bytes);
    return { filename, html, bytes: file.bytes, sha256: pipelineHash(file.bytes) };
  });
}

export function createRasterPublisher(tools: SlidePlanPublisherTools): PipelineArtifactPublisher {
  return async (request) => {
    const root = join(request.outputDirectory, "publication");
    const output = {
      pngDirectory: join(root, "png"),
      pdfPath: join(root, "deck.pdf"),
      manifestPath: join(root, "manifest.json"),
      receiptPath: join(root, "receipt.json"),
    };
    const publication = await exportDeterministicRaster({
      identity: {
        planId: request.identity.planId,
        deckId: request.identity.deckId.replaceAll(":", "-"),
        slideIds: request.identity.slideIds,
        geometryIds: request.identity.geometryIds.map((id) => id.replaceAll(":", "-")),
      },
      documents: standaloneDocuments(request),
      output,
      tools,
      timeoutMs: tools.timeoutMs,
    });
    const files = await Promise.all([
      ...publication.manifest.slides.map(async (slide) => ({ relativePath: `raster/png/${slide.pngName}`, bytes: new Uint8Array(await readFile(join(output.pngDirectory, slide.pngName))) })),
      { relativePath: "raster/deck.pdf", bytes: new Uint8Array(await readFile(output.pdfPath)) },
      { relativePath: "raster/manifest.json", bytes: new Uint8Array(await readFile(output.manifestPath)) },
      { relativePath: "raster/receipt.json", bytes: new Uint8Array(await readFile(output.receiptPath)) },
    ]);
    if (basename(output.pdfPath) !== publication.manifest.pdf.name) throw new TypeError("raster PDF identity mismatch");
    return { format: "raster-png-pdf", identity: request.identity, files };
  };
}

export function createSlidePlanPublishers(tools: SlidePlanPublisherTools) {
  return Object.freeze({
    standalone: createStandalonePublisher(),
    pptx: createEditablePptxPublisher(),
    raster: createRasterPublisher(tools),
  });
}
