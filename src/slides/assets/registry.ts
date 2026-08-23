import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  ASSET_MEDIA_TYPES,
  AssetContractError,
  parseAssetRecord,
  parseAssetRegistration,
  type AssetRecord,
  type AssetRegistration,
} from "./contract.ts";

export interface AssetRegistry {
  register(registration: AssetRegistration): Promise<AssetRecord>;
  get(id: string): AssetRecord | undefined;
  cacheEntries(): readonly string[];
  verifyForCompilation(records: readonly AssetRecord[]): Promise<readonly AssetRecord[]>;
}

function failure(
  code: ConstructorParameters<typeof AssetContractError>[0],
  path: string,
  detail: string,
): AssetContractError {
  return new AssetContractError(code, path, detail);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(parent: string, child: string): boolean {
  const displacement = relative(parent, child);
  return displacement === "" || (!displacement.startsWith(`..${sep}`) && displacement !== ".." && !isAbsolute(displacement));
}

function sameRecord(left: AssetRecord, right: AssetRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function verifiedBytes(path: string, expectedHash: string, errorPath: string): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    const details = await lstat(path);
    if (!details.isFile()) throw failure("ASSET_HASH_MISMATCH", errorPath, "managed asset is not a regular file");
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof AssetContractError) throw error;
    throw failure("ASSET_HASH_MISMATCH", errorPath, "managed asset is missing or unreadable");
  }
  if (hash(bytes) !== expectedHash) throw failure("ASSET_HASH_MISMATCH", errorPath, "managed bytes do not match the pinned SHA-256 hash");
  return bytes;
}

export function createAssetRegistry(options: { managedRoot: string }): AssetRegistry {
  if (typeof options?.managedRoot !== "string" || options.managedRoot.trim() === "" || options.managedRoot.includes("\0")) {
    throw failure("ASSET_CONTRACT_INVALID", "managedRoot", "must be a non-empty filesystem path");
  }

  const requestedRoot = resolve(options.managedRoot);
  const records = new Map<string, AssetRecord>();
  const entries = new Set<string>();
  let setup: Promise<{ root: string; assets: string }> | undefined;
  let registrationQueue = Promise.resolve();

  async function roots(): Promise<{ root: string; assets: string }> {
    if (setup !== undefined) return setup;
    setup = (async () => {
      await mkdir(requestedRoot, { recursive: true });
      const root = await realpath(requestedRoot);
      const requestedAssets = resolve(root, "assets");
      await mkdir(requestedAssets, { recursive: true });
      const assets = await realpath(requestedAssets);
      if (!isWithin(root, assets)) throw failure("ASSET_OUTSIDE_MANAGED_ROOT", "managedRoot", "assets directory escapes the managed root");
      return { root, assets };
    })();
    return setup;
  }

  async function cache(bytes: Uint8Array, record: AssetRecord): Promise<void> {
    const managed = await roots();
    const destination = resolve(managed.root, record.localPath);
    if (!isWithin(managed.assets, destination)) {
      throw failure("ASSET_OUTSIDE_MANAGED_ROOT", "asset.localPath", "asset path escapes the managed assets directory");
    }
    const temporary = resolve(managed.assets, `.${record.sha256}.${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode: 0o600 });
    try {
      try {
        await link(temporary, destination);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      }
    } finally {
      await unlink(temporary);
    }
    let canonical: string;
    try { canonical = await realpath(destination); }
    catch { throw failure("ASSET_HASH_MISMATCH", "asset.sha256", "cached asset is missing or unreadable"); }
    if (!isWithin(managed.assets, canonical)) {
      throw failure("ASSET_OUTSIDE_MANAGED_ROOT", "asset.localPath", "cached asset resolves outside the managed assets directory");
    }
    const persisted = await verifiedBytes(destination, record.sha256, "asset.sha256");
    if (persisted.byteLength !== record.byteLength) {
      throw failure("ASSET_HASH_MISMATCH", "asset.byteLength", "managed byte length does not match registration");
    }
  }

  async function performRegistration(input: AssetRegistration): Promise<AssetRecord> {
    const registration = parseAssetRegistration(input);
    let bytes: Uint8Array;
    try {
      const details = await lstat(resolve(registration.inputPath));
      if (!details.isFile()) throw failure("ASSET_CONTRACT_INVALID", "asset.inputPath", "must identify a regular local file");
      bytes = await readFile(resolve(registration.inputPath));
    } catch (error) {
      if (error instanceof AssetContractError) throw error;
      throw failure("ASSET_CONTRACT_INVALID", "asset.inputPath", "local file is missing or unreadable");
    }
    if (bytes.byteLength === 0) throw failure("ASSET_CONTRACT_INVALID", "asset.inputPath", "asset file must not be empty");
    const digest = hash(bytes);
    const candidate = parseAssetRecord({
      id: registration.id,
      purpose: registration.purpose,
      kind: registration.kind,
      localPath: `assets/${digest}.${ASSET_MEDIA_TYPES[registration.mediaType]}`,
      mediaType: registration.mediaType,
      width: registration.width,
      height: registration.height,
      byteLength: bytes.byteLength,
      sha256: digest,
      altDescription: registration.altDescription,
      source: registration.source,
      claimIds: registration.claimIds,
    });
    const existing = records.get(candidate.id);
    if (existing !== undefined) {
      if (sameRecord(existing, candidate)) throw failure("ASSET_DUPLICATE_ID", "asset.id", `asset ID '${candidate.id}' is already registered`);
      throw failure("ASSET_METADATA_CONFLICT", "asset.id", `asset ID '${candidate.id}' conflicts with its first registration`);
    }
    await cache(bytes, candidate);
    records.set(candidate.id, candidate);
    entries.add(candidate.localPath);
    return candidate;
  }

  function register(registration: AssetRegistration): Promise<AssetRecord> {
    const result = registrationQueue.then(() => performRegistration(registration));
    registrationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function verifyForCompilation(input: readonly AssetRecord[]): Promise<readonly AssetRecord[]> {
    const managed = await roots();
    const verified: AssetRecord[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const value = input[index];
      const rawPath = value !== null && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "localPath")?.value
        : undefined;
      if (typeof rawPath !== "string" || isAbsolute(rawPath) || rawPath.includes("\\") || rawPath.split("/").some((part) => part === ".." || part === "." || part === "")) {
        throw failure("ASSET_OUTSIDE_MANAGED_ROOT", `assets[${index}].localPath`, "asset path is not a normalized managed path");
      }
      const destination = resolve(managed.root, rawPath);
      if (!isWithin(managed.assets, destination)) {
        throw failure("ASSET_OUTSIDE_MANAGED_ROOT", `assets[${index}].localPath`, "asset path escapes the managed root");
      }
      const record = parseAssetRecord(value, { path: `assets[${index}]` });
      const registered = records.get(record.id);
      if (registered === undefined) throw failure("ASSET_NOT_REGISTERED", `assets[${index}].id`, `asset ID '${record.id}' is not registered`);
      if (!sameRecord(registered, record)) throw failure("ASSET_METADATA_CONFLICT", `assets[${index}].id`, "record differs from its registration");
      let canonical: string;
      try { canonical = await realpath(destination); }
      catch { throw failure("ASSET_HASH_MISMATCH", `assets[${index}].sha256`, "managed asset is missing or unreadable"); }
      if (!isWithin(managed.assets, canonical)) {
        throw failure("ASSET_OUTSIDE_MANAGED_ROOT", `assets[${index}].localPath`, "asset symlink escapes the managed root");
      }
      const bytes = await verifiedBytes(destination, record.sha256, `assets[${index}].sha256`);
      if (bytes.byteLength !== record.byteLength) {
        throw failure("ASSET_HASH_MISMATCH", `assets[${index}].byteLength`, "managed byte length does not match the manifest");
      }
      verified.push(registered);
    }
    return verified;
  }

  return {
    register,
    get: (id: string) => records.get(id),
    cacheEntries: () => Object.freeze([...entries].sort()),
    verifyForCompilation,
  };
}
