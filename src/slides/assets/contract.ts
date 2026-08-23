export const ASSET_MEDIA_TYPES = Object.freeze({
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/jpeg": "jpg",
} as const);

export type AssetMediaType = keyof typeof ASSET_MEDIA_TYPES;
export type AssetPurpose = "informative" | "decorative";
export type AssetKind = "image" | "icon" | "diagram" | "chart";
export type AssetSource =
  | Readonly<{ kind: "local"; originalPath: string }>
  | Readonly<{ kind: "generated"; generator: string }>
  | Readonly<{ kind: "retrieved"; url: string; retrievedAt: string }>;

export interface AssetRecord {
  readonly id: string;
  readonly purpose: AssetPurpose;
  readonly kind: AssetKind;
  readonly localPath: string;
  readonly mediaType: AssetMediaType;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly altDescription: string;
  readonly source: AssetSource;
  readonly claimIds: readonly string[];
}

export interface AssetRegistration {
  readonly id: string;
  readonly purpose: AssetPurpose;
  readonly kind: AssetKind;
  readonly inputPath: string;
  readonly mediaType: AssetMediaType;
  readonly width: number;
  readonly height: number;
  readonly altDescription: string;
  readonly source: AssetSource;
  readonly claimIds: readonly string[];
}

export type AssetContractErrorCode =
  | "ASSET_CONTRACT_INVALID"
  | "ASSET_OUTSIDE_MANAGED_ROOT"
  | "ASSET_NOT_REGISTERED"
  | "ASSET_HASH_MISMATCH"
  | "ASSET_DUPLICATE_ID"
  | "ASSET_METADATA_CONFLICT"
  | "ASSET_ACQUISITION_INVALID"
  | "ASSET_PROVIDER_ERROR"
  | "ASSET_RETRIEVAL_ERROR";

export class AssetContractError extends TypeError {
  readonly code: AssetContractErrorCode;
  readonly path: string;

  constructor(code: AssetContractErrorCode, path: string, detail: string) {
    super(`[${code}] ${path}: ${detail}`);
    this.name = "AssetContractError";
    this.code = code;
    this.path = path;
  }
}

function invalid(path: string, detail: string): never {
  throw new AssetContractError("ASSET_CONTRACT_INVALID", path, detail);
}

function exact(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(path, "must be a plain object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") invalid(path, "symbol keys are not allowed");
    if (!keys.includes(key)) invalid(`${path}.${key}`, "key is not allowed");
    if (!("value" in descriptors[key]!)) invalid(`${path}.${key}`, "accessor properties are not allowed");
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.value === undefined) {
      invalid(`${path}.${key}`, "is required");
    }
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function choice<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.some((item) => item === value)) {
    invalid(path, `must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function text(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string") invalid(path, "must be a string");
  if (!allowEmpty && value.trim() === "") invalid(path, "must not be empty");
  if (value.includes("\0")) invalid(path, "must not contain a null byte");
  return value;
}

function id(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(parsed)) invalid(path, "must be a stable ID");
  return parsed;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) invalid(path, "must be a positive integer");
  return value;
}

function source(value: unknown, path: string): AssetSource {
  const base = exactKind(value, path);
  if (base.kind === "local") {
    const parsed = exact(value, path, ["kind", "originalPath"]);
    return { kind: "local", originalPath: text(parsed.originalPath, `${path}.originalPath`) };
  }
  if (base.kind === "generated") {
    const parsed = exact(value, path, ["kind", "generator"]);
    return { kind: "generated", generator: text(parsed.generator, `${path}.generator`) };
  }
  const parsed = exact(value, path, ["kind", "url", "retrievedAt"]);
  const url = text(parsed.url, `${path}.url`);
  let resolved: URL;
  try { resolved = new URL(url); } catch { invalid(`${path}.url`, "must be an absolute HTTP(S) URL"); }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") invalid(`${path}.url`, "must be an absolute HTTP(S) URL");
  const retrievedAt = text(parsed.retrievedAt, `${path}.retrievedAt`);
  const date = new Date(retrievedAt);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(retrievedAt) ||
      Number.isNaN(date.valueOf()) || date.toISOString() !== retrievedAt) {
    invalid(`${path}.retrievedAt`, "must be a valid ISO-8601 UTC timestamp");
  }
  return { kind: "retrieved", url, retrievedAt };
}

function exactKind(value: unknown, path: string): { kind: AssetSource["kind"] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(path, "must be a plain object");
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (descriptor === undefined || !("value" in descriptor)) invalid(`${path}.kind`, "is required");
  return { kind: choice(descriptor.value, `${path}.kind`, ["local", "generated", "retrieved"]) };
}

function claims(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) invalid(`${path}[${index}]`, "must be a present data element");
    const parsed = id(descriptor.value, `${path}[${index}]`);
    if (seen.has(parsed)) invalid(`${path}[${index}]`, `duplicate claim ID '${parsed}'`);
    seen.add(parsed);
    result.push(parsed);
  }
  const allowed = new Set(["length", ...result.map((_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.has(key)) invalid(path, "array properties are not allowed");
  }
  return result;
}

function accessibility(purpose: AssetPurpose, alt: string, claimIds: readonly string[], path: string): void {
  if (purpose === "informative") {
    if (alt.trim() === "") invalid(`${path}.altDescription`, "informative assets require non-empty alternative text");
    if (claimIds.length === 0) invalid(`${path}.claimIds`, "informative assets require at least one claim ID");
  } else {
    if (alt !== "") invalid(`${path}.altDescription`, "decorative assets require empty alternative text");
    if (claimIds.length !== 0) invalid(`${path}.claimIds`, "decorative assets cannot reference claims");
  }
}

export function parseAssetRecord(value: unknown, options: { path?: string } = {}): AssetRecord {
  const path = options.path ?? "asset";
  const parsed = exact(value, path, ["id", "purpose", "kind", "localPath", "mediaType", "width", "height", "byteLength", "sha256", "altDescription", "source", "claimIds"]);
  const assetId = id(parsed.id, `${path}.id`);
  const purpose = choice(parsed.purpose, `${path}.purpose`, ["informative", "decorative"]);
  const kind = choice(parsed.kind, `${path}.kind`, ["image", "icon", "diagram", "chart"]);
  const hash = text(parsed.sha256, `${path}.sha256`);
  if (!/^[0-9a-f]{64}$/.test(hash)) invalid(`${path}.sha256`, "must be a lowercase 64-character SHA-256 hash");
  const mediaType = choice(parsed.mediaType, `${path}.mediaType`, Object.keys(ASSET_MEDIA_TYPES) as AssetMediaType[]);
  const localPath = text(parsed.localPath, `${path}.localPath`);
  if (localPath !== `assets/${hash}.${ASSET_MEDIA_TYPES[mediaType]}`) invalid(`${path}.localPath`, "must be the matching managed content-addressed path");
  const altDescription = text(parsed.altDescription, `${path}.altDescription`, true);
  const claimIds = claims(parsed.claimIds, `${path}.claimIds`);
  accessibility(purpose, altDescription, claimIds, path);
  return { id: assetId, purpose, kind, localPath, mediaType, width: positiveInteger(parsed.width, `${path}.width`), height: positiveInteger(parsed.height, `${path}.height`), byteLength: positiveInteger(parsed.byteLength, `${path}.byteLength`), sha256: hash, altDescription, source: source(parsed.source, `${path}.source`), claimIds };
}

export function parseAssetRegistration(value: unknown, path = "asset"): AssetRegistration {
  const parsed = exact(value, path, ["id", "purpose", "kind", "inputPath", "mediaType", "width", "height", "altDescription", "source", "claimIds"]);
  const purpose = choice(parsed.purpose, `${path}.purpose`, ["informative", "decorative"]);
  const altDescription = text(parsed.altDescription, `${path}.altDescription`, true);
  const claimIds = claims(parsed.claimIds, `${path}.claimIds`);
  accessibility(purpose, altDescription, claimIds, path);
  const inputPath = text(parsed.inputPath, `${path}.inputPath`);
  if (/^[a-z][a-z\d+.-]*:/i.test(inputPath)) invalid(`${path}.inputPath`, "must be a local filesystem path");
  return { id: id(parsed.id, `${path}.id`), purpose, kind: choice(parsed.kind, `${path}.kind`, ["image", "icon", "diagram", "chart"]), inputPath, mediaType: choice(parsed.mediaType, `${path}.mediaType`, Object.keys(ASSET_MEDIA_TYPES) as AssetMediaType[]), width: positiveInteger(parsed.width, `${path}.width`), height: positiveInteger(parsed.height, `${path}.height`), altDescription, source: source(parsed.source, `${path}.source`), claimIds };
}
