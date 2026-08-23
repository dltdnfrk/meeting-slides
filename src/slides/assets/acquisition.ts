import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  AssetContractError,
  type AssetKind,
  type AssetMediaType,
  type AssetPurpose,
  type AssetRecord,
  type AssetSource,
} from "./contract.ts";
import type { AssetRegistry } from "./registry.ts";

export interface ByteRetrievalRequest {
  readonly url: string;
  readonly maxBytes: number;
}

export interface RetrievedBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export type ByteRetriever = (request: ByteRetrievalRequest) => Promise<RetrievedBytes>;

export interface AcquisitionRequest {
  readonly id: string;
  readonly requestId: string;
  readonly purpose: AssetPurpose;
  readonly altDescription: string;
  readonly claimIds: readonly string[];
  readonly maxBytes: number;
  readonly expectedSha256?: string;
}

export interface VerifiedImage {
  readonly sourceUrl: string;
  readonly mediaType: AssetMediaType;
  readonly width: number;
  readonly height: number;
}

export interface AcquisitionReceiptBase {
  readonly requestId: string;
  readonly sourceUrl: string;
  readonly mediaType: AssetMediaType;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly acquiredAt: string;
}

export interface AcquisitionResult<R> {
  readonly receipt: Readonly<R>;
  readonly asset: AssetRecord;
}

export function acquisitionError(path: string, detail: string): AssetContractError {
  return new AssetContractError("ASSET_ACQUISITION_INVALID", path, detail);
}

export function requireText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw acquisitionError(path, "must be a non-empty string");
  }
  return value;
}

export function requireStableId(value: unknown, path: string): string {
  const parsed = requireText(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(parsed)) {
    throw acquisitionError(path, "must be a stable ID");
  }
  return parsed;
}

export function requireDimension(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 16_384) {
    throw acquisitionError(path, "must be a positive integer no greater than 16384");
  }
  return value;
}

export function requireTimestamp(value: unknown, path: string): string {
  const parsed = requireText(value, path);
  const date = new Date(parsed);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed) || Number.isNaN(date.valueOf()) || date.toISOString() !== parsed) {
    throw acquisitionError(path, "must be an ISO-8601 UTC timestamp");
  }
  return parsed;
}

export function requireHttpsUrl(value: unknown, path: string): string {
  const text = requireText(value, path);
  let url: URL;
  try { url = new URL(text); } catch { throw acquisitionError(path, "must be an absolute HTTPS URL"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw acquisitionError(path, "must be an HTTPS URL without credentials");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const version = isIP(host);
  const unsafeV4 = version === 4 && (/^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host));
  const unsafeV6 = version === 6 && (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb"));
  if (host === "localhost" || host.endsWith(".localhost") || unsafeV4 || unsafeV6) {
    throw acquisitionError(path, "must not target a local or private host");
  }
  return text;
}

export function validateRequest(request: AcquisitionRequest): void {
  requireStableId(request.id, "request.id");
  requireStableId(request.requestId, "request.requestId");
  if (request.purpose !== "informative") {
    throw acquisitionError("request.purpose", "provider-acquired assets must be informative");
  }
  requireText(request.altDescription, "request.altDescription");
  if (!Array.isArray(request.claimIds) || request.claimIds.length === 0) {
    throw acquisitionError("request.claimIds", "must contain at least one claim ID");
  }
  const seen = new Set<string>();
  request.claimIds.forEach((claim, index) => {
    const id = requireStableId(claim, `request.claimIds[${index}]`);
    if (seen.has(id)) throw acquisitionError(`request.claimIds[${index}]`, "must not be duplicated");
    seen.add(id);
  });
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
    throw acquisitionError("request.maxBytes", "must be a positive safe integer");
  }
  if (request.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(request.expectedSha256)) {
    throw acquisitionError("request.expectedSha256", "must be a lowercase SHA-256 hash");
  }
}

function detectedImage(bytes: Uint8Array): { mediaType: AssetMediaType; width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png = bytes.length >= 24 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  if (png) return { mediaType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  const webp = bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  const webpKind = webp ? String.fromCharCode(...bytes.slice(12, 16)) : "";
  if (webpKind === "VP8X") {
    const little24 = (offset: number) => bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16;
    return { mediaType: "image/webp", width: little24(24) + 1, height: little24(27) + 1 };
  }
  if (webpKind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { mediaType: "image/webp", width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (webpKind === "VP8L" && bytes[20] === 0x2f) {
    const bits = view.getUint32(21, true);
    return { mediaType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1]!;
      if (marker >= 0xc0 && marker <= 0xc3) return { mediaType: "image/jpeg", height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      const length = view.getUint16(offset + 2);
      if (length < 2) break;
      offset += length + 2;
    }
  }
  throw acquisitionError("bytes.mediaType", "bytes are not a supported PNG, JPEG, or WebP image");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export async function prepareStaging(stagingRoot: string): Promise<string> {
  if (typeof stagingRoot !== "string" || stagingRoot.trim() === "" || stagingRoot.includes("\0")) {
    throw acquisitionError("stagingRoot", "must be a non-empty filesystem path");
  }
  const root = resolve(stagingRoot);
  await mkdir(root, { recursive: true });
  return root;
}

export async function persistVerified<R extends AcquisitionReceiptBase>(options: {
  request: AcquisitionRequest;
  image: VerifiedImage;
  source: AssetSource;
  kind?: AssetKind;
  receipt: Omit<R, "byteLength" | "sha256">;
  retrieveBytes: ByteRetriever;
  registry: AssetRegistry;
  stagingRoot: string;
}): Promise<AcquisitionResult<R>> {
  let retrieved: RetrievedBytes;
  try {
    retrieved = await options.retrieveBytes({ url: options.image.sourceUrl, maxBytes: options.request.maxBytes });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "byte retrieval failed";
    throw new AssetContractError("ASSET_RETRIEVAL_ERROR", "retrieveBytes", detail);
  }
  if (typeof retrieved !== "object" || retrieved === null) throw acquisitionError("bytes", "retriever must return a byte response");
  if (!(retrieved.bytes instanceof Uint8Array)) throw acquisitionError("bytes", "retriever must return Uint8Array bytes");
  if (retrieved.bytes.byteLength === 0) throw acquisitionError("bytes.byteLength", "must not be empty");
  if (retrieved.bytes.byteLength > options.request.maxBytes) throw acquisitionError("bytes.byteLength", "exceeds request.maxBytes");
  if (retrieved.mediaType !== options.image.mediaType) throw acquisitionError("bytes.mediaType", "retrieval MIME type differs from provider metadata");
  const detected = detectedImage(retrieved.bytes);
  if (detected.mediaType !== options.image.mediaType) throw acquisitionError("bytes.mediaType", "detected MIME type differs from provider metadata");
  if (detected.width !== options.image.width) throw acquisitionError("bytes.width", "detected width differs from provider metadata");
  if (detected.height !== options.image.height) throw acquisitionError("bytes.height", "detected height differs from provider metadata");
  const sha256 = createHash("sha256").update(retrieved.bytes).digest("hex");
  if (options.request.expectedSha256 !== undefined && sha256 !== options.request.expectedSha256) {
    throw acquisitionError("bytes.sha256", "does not match request.expectedSha256");
  }
  const path = resolve(options.stagingRoot, `.${options.request.requestId}.${randomUUID()}.stage`);
  try {
    await writeFile(path, retrieved.bytes, { flag: "wx", mode: 0o600 });
    const asset = await options.registry.register({
      id: options.request.id, purpose: options.request.purpose, kind: options.kind ?? "image", inputPath: path,
      mediaType: options.image.mediaType, width: options.image.width, height: options.image.height,
      altDescription: options.request.altDescription, source: options.source, claimIds: options.request.claimIds,
    });
    const receipt = { ...options.receipt, byteLength: retrieved.bytes.byteLength, sha256 };
    return deepFreeze({ receipt, asset }) as AcquisitionResult<R>;
  } finally {
    await rm(path, { force: true });
  }
}
