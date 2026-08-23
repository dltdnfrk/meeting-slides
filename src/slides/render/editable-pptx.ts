import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { buildEditablePptx } from "./editable-pptx-builder.ts";
import { canonicalizeEditablePptx, validateEditablePptxPackage } from "./editable-pptx-opc.ts";
import {
  EditablePptxError,
  pptxFailure,
  type EditablePptxArtifact,
  type EditablePptxPublication,
  type EditablePptxReceipt,
  type EditablePptxRenderRequest,
} from "./editable-pptx-types.ts";
import { pptxSha256, validateEditablePptxRequest } from "./editable-pptx-validation.ts";

export { EditablePptxError } from "./editable-pptx-types.ts";
export type {
  EditablePptxArtifact,
  EditablePptxManifest,
  EditablePptxManifestAsset,
  EditablePptxManifestSlide,
  EditablePptxPublication,
  EditablePptxReceipt,
  EditablePptxRenderRequest,
  EditablePptxSlideInput,
} from "./editable-pptx-types.ts";

export async function renderEditablePptx(request: EditablePptxRenderRequest): Promise<EditablePptxArtifact> {
  const verified = validateEditablePptxRequest(request);
  const generated = await buildEditablePptx(verified);
  const bytes = await canonicalizeEditablePptx(generated.bytes, request);
  await validateEditablePptxPackage(bytes, request);
  const manifestJson = `${JSON.stringify(generated.manifest)}\n`;
  const receipt: EditablePptxReceipt = {
    schemaVersion: 1,
    deckId: request.deckId,
    byteLength: bytes.byteLength,
    pptxSha256: pptxSha256(bytes),
    manifestSha256: pptxSha256(manifestJson),
    counts: generated.manifest.counts,
  };
  return {
    bytes,
    manifest: generated.manifest,
    manifestJson,
    receipt,
    receiptJson: `${JSON.stringify(receipt)}\n`,
  };
}

function validateArtifact(artifact: EditablePptxArtifact): void {
  const manifestJson = `${JSON.stringify(artifact.manifest)}\n`;
  const receiptJson = `${JSON.stringify(artifact.receipt)}\n`;
  const valid = artifact.manifestJson === manifestJson && artifact.receiptJson === receiptJson &&
    artifact.receipt.deckId === artifact.manifest.deckId &&
    artifact.receipt.byteLength === artifact.bytes.byteLength &&
    artifact.receipt.pptxSha256 === pptxSha256(artifact.bytes) &&
    artifact.receipt.manifestSha256 === pptxSha256(artifact.manifestJson) &&
    JSON.stringify(artifact.receipt.counts) === JSON.stringify(artifact.manifest.counts);
  if (!valid) pptxFailure("PPTX_PARTIAL_PUBLICATION", "artifact.bytes", "artifact bytes, manifest, and receipt are not hash-bound");
}

export async function publishEditablePptx(artifact: EditablePptxArtifact, outputPath: string): Promise<EditablePptxPublication> {
  validateArtifact(artifact);
  try {
    await validateEditablePptxPackage(artifact.bytes);
  } catch (error) {
    if (error instanceof EditablePptxError) {
      pptxFailure("PPTX_PARTIAL_PUBLICATION", "artifact.bytes", error.message);
    }
    throw error;
  }

  const directory = dirname(outputPath);
  const stagingPath = join(directory, `.${basename(outputPath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(stagingPath, artifact.bytes, { flag: "wx" });
    renameSync(stagingPath, outputPath);
  } catch (error) {
    if (existsSync(stagingPath)) rmSync(stagingPath, { force: true });
    pptxFailure("PPTX_PARTIAL_PUBLICATION", "outputPath", error instanceof Error ? error.message : "atomic publication failed");
  }
  return {
    outputPath,
    byteLength: artifact.bytes.byteLength,
    pptxSha256: artifact.receipt.pptxSha256,
    manifestSha256: artifact.receipt.manifestSha256,
  };
}
