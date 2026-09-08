import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface BundleFileIntegrity {
  readonly sha256: string;
  readonly byte_size: number;
  readonly byte_length: number;
}

export function isSafeBundlePath(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && !path.includes("\\") &&
    path.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

/** Caller checks manifest paths and maps filesystem errors to its own domain. */
export function readBundleFile(root: string, relativePath: string): Promise<Buffer> {
  return readFile(join(root, relativePath));
}

export function bundleFileSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function matchesBundleFile(bytes: Uint8Array, entry: BundleFileIntegrity): boolean {
  return bytes.byteLength === entry.byte_size && entry.byte_length === entry.byte_size &&
    bundleFileSha256(bytes) === entry.sha256;
}

const signatures = { pdf: Buffer.from("%PDF-"), docx: Buffer.from("PK\x03\x04") } as const;

/** Signature only; required outputs, identity and DB authority stay with callers. */
export function hasBundleSignature(bytes: Uint8Array, kind: keyof typeof signatures): boolean {
  const signature = signatures[kind];
  return signature.every((byte, index) => bytes[index] === byte);
}
