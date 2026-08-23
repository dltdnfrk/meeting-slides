import {
  AssetContractError,
  parseAssetRecord,
  type AssetRecord,
} from "./contract.ts";

export interface AssetManifest {
  readonly schemaVersion: 1;
  readonly assets: readonly AssetRecord[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sameRecord(left: AssetRecord, right: AssetRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createAssetManifest(records: readonly AssetRecord[]): AssetManifest {
  if (!Array.isArray(records)) {
    throw new AssetContractError("ASSET_CONTRACT_INVALID", "assets", "must be an array");
  }
  const parsed: AssetRecord[] = [];
  const byId = new Map<string, AssetRecord>();
  records.forEach((value, index) => {
    const record = parseAssetRecord(value, { path: `assets[${index}]` });
    const existing = byId.get(record.id);
    if (existing !== undefined) {
      const code = sameRecord(existing, record) ? "ASSET_DUPLICATE_ID" : "ASSET_METADATA_CONFLICT";
      throw new AssetContractError(code, `assets[${index}].id`, `asset ID '${record.id}' occurs more than once`);
    }
    byId.set(record.id, record);
    parsed.push(record);
  });
  parsed.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return deepFreeze({ schemaVersion: 1 as const, assets: parsed });
}

export function stableAssetManifestJson(manifest: AssetManifest): string {
  if (typeof manifest !== "object" || manifest === null || manifest.schemaVersion !== 1) {
    throw new AssetContractError("ASSET_CONTRACT_INVALID", "schemaVersion", "must equal 1");
  }
  const canonical = createAssetManifest(manifest.assets);
  return `${JSON.stringify(canonical)}\n`;
}
