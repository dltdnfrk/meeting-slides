import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { parseAssetRecord, type AssetRecord } from "./assets/contract.ts";
import { createAssetManifest, type AssetManifest } from "./assets/manifest.ts";
import type { PlanAsset, SlidePlan } from "./model/plan.ts";
import { parseSlidePlan } from "./model/plan-parser.ts";
import type { PipelineAssetContext, PipelineAssetPolicy } from "./server-pipeline-types.ts";

export class PipelineAssetError extends TypeError {
  constructor(readonly path: string, detail: string) {
    super(`[PIPELINE_ASSET_INVALID] ${path}: ${detail}`);
    this.name = "PipelineAssetError";
  }
}

function fail(path: string, detail: string): never {
  throw new PipelineAssetError(path, detail);
}

function within(parent: string, child: string): boolean {
  const displacement = relative(parent, child);
  return displacement === "" || (displacement !== ".." && !displacement.startsWith(`..${sep}`) && !isAbsolute(displacement));
}

function sameValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertSemanticIdentity(planned: PlanAsset, record: AssetRecord, index: number): void {
  const fields = ["id", "purpose", "kind", "width", "height", "altDescription", "claimIds"] as const;
  for (const field of fields) {
    if (!sameValues(planned[field], record[field])) {
      fail(`assets[${index}].${field}`, `fallback or resolved asset changed '${field}'`);
    }
  }
}

async function verifyManagedRecord(record: AssetRecord, root: string, index: number): Promise<AssetRecord> {
  const parsed = parseAssetRecord(record, { path: `assets[${index}]` });
  if (isAbsolute(parsed.localPath) || parsed.localPath.includes("\\") ||
      parsed.localPath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return fail(`assets[${index}].localPath`, "must be a normalized managed relative path");
  }
  const managedRoot = await realpath(resolve(root)).catch(() => fail("managedAssetRoot", "must exist after asset resolution"));
  const candidate = resolve(managedRoot, parsed.localPath);
  if (!within(managedRoot, candidate)) fail(`assets[${index}].localPath`, "escapes managedAssetRoot");
  const canonical = await realpath(candidate).catch(() => fail(`assets[${index}].localPath`, "managed asset is missing"));
  if (!within(managedRoot, canonical)) fail(`assets[${index}].localPath`, "resolves outside managedAssetRoot");
  const details = await lstat(canonical);
  if (!details.isFile()) fail(`assets[${index}].localPath`, "must resolve to a regular file");
  const bytes = await readFile(canonical);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== parsed.sha256) fail(`assets[${index}].sha256`, "does not match managed bytes");
  if (bytes.byteLength !== parsed.byteLength) fail(`assets[${index}].byteLength`, "does not match managed bytes");
  const filename = parsed.localPath.split("/").at(-1) ?? "";
  if (!filename.startsWith(`${digest}.`)) fail(`assets[${index}].localPath`, "must be content-addressed by sha256");
  return parsed;
}

export async function resolvePipelineAssets(
  plan: SlidePlan,
  policy: PipelineAssetPolicy,
  context: PipelineAssetContext,
): Promise<{ readonly plan: SlidePlan; readonly manifest: AssetManifest }> {
  const records: AssetRecord[] = [];
  for (let index = 0; index < plan.assets.length; index += 1) {
    const planned = plan.assets[index]!;
    const resolved = await policy.resolve(planned, context) ?? await policy.fallback(planned, context);
    assertSemanticIdentity(planned, resolved, index);
    records.push(await verifyManagedRecord(resolved, context.managedAssetRoot, index));
  }
  const manifest = createAssetManifest(records);
  const effective = parseSlidePlan({ ...plan, assets: records });
  return Object.freeze({ plan: effective, manifest });
}
