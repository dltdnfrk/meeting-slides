import { createHash } from "node:crypto";
import { chmodSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PngArtifactReceipt { file: string; sha256: string; width: number; height: number; byteLength: number }

export function validateAndDescribePngDirectory(directory: string, expectedCount: number): PngArtifactReceipt[] {
  const files = readdirSync(directory).filter((file) => file.toLowerCase().endsWith(".png")).sort();
  if (files.length !== expectedCount) throw new Error(`PNG count mismatch: expected ${expectedCount}, got ${files.length}`);
  return files.map((file) => {
    const bytes = readFileSync(join(directory, file));
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
      throw new Error(`Invalid PNG artifact: ${file}`);
    }
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    if (width <= 0 || height <= 0) throw new Error(`Invalid PNG dimensions: ${file}`);
    return { file, sha256: createHash("sha256").update(bytes).digest("hex"), width, height, byteLength: bytes.byteLength };
  });
}

export function publishPngDirectory(input: { temporaryDirectory: string; finalDirectory: string; expectedCount: number; meetingId: number; createdAt?: string }): PngArtifactReceipt[] {
  try {
    const artifacts = validateAndDescribePngDirectory(input.temporaryDirectory, input.expectedCount);
    writeFileSync(join(input.temporaryDirectory, "artifact-manifest.json"), JSON.stringify({
      schemaVersion: 1, meetingId: input.meetingId, artifactType: "slide_png_set",
      createdAt: input.createdAt ?? new Date().toISOString(), artifacts,
    }, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(input.temporaryDirectory, input.finalDirectory);
    try { chmodSync(input.finalDirectory, 0o700); } catch { /* non-POSIX filesystem */ }
    return artifacts;
  } catch (error) {
    rmSync(input.temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}
