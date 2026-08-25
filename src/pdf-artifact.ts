import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, fsyncSync, linkSync, lstatSync, openSync, readSync, rmSync, unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

export interface PdfArtifactReceipt {
  path: string;
  byteLength: number;
  sha256: string;
}

export function validatePdfFile(path: string): Omit<PdfArtifactReceipt, "path"> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("PDF artifact must be a regular file");
  if (stat.size < 64) throw new Error("PDF artifact is truncated");
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  try {
    const head = Buffer.alloc(Math.min(8, stat.size));
    readSync(fd, head, 0, head.length, 0);
    if (!head.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) throw new Error("PDF artifact has an invalid header");
    const tailLength = Math.min(4_096, stat.size);
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, stat.size - tailLength);
    if (!tail.toString("latin1").trimEnd().endsWith("%%EOF")) throw new Error("PDF artifact is missing its EOF marker");
    const buffer = Buffer.allocUnsafe(64 * 1_024);
    let position = 0;
    while (position < stat.size) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    if (position !== stat.size) throw new Error("PDF artifact could not be read completely");
    return { byteLength: stat.size, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch { /* directory fsync is not supported on every platform/filesystem */ }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function publishPdfFile(temporaryPath: string, finalPath: string): PdfArtifactReceipt {
  let finalCreated = false;
  try {
    const receipt = validatePdfFile(temporaryPath);
    chmodSync(temporaryPath, 0o600);
    const fd = openSync(temporaryPath, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temporaryPath, finalPath); // atomic visibility and no overwrite on collision
    finalCreated = true;
    unlinkSync(temporaryPath);
    syncDirectory(dirname(finalPath));
    return { path: finalPath, ...receipt };
  } catch (error) {
    if (finalCreated) rmSync(finalPath, { force: true });
    throw error;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
