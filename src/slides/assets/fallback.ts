import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  AssetContractError,
  parseAssetRecord,
  type AssetKind,
  type AssetPurpose,
  type AssetRecord,
} from "./contract.ts";
import { prepareStaging } from "./acquisition.ts";
import type { AssetRegistry } from "./registry.ts";
import { escapeXml } from "./svg-renderer.ts";
import type { PlanAsset, Theme } from "../model/plan.ts";

const GENERATOR = "meeting-asset-fallback-svg-v1";
const OMISSION_POLICY = "decorative-missing-asset-v1";

export type MissingAssetFallbackReason = Readonly<
  | { code: "missing"; detail: string }
  | { code: "provider-unavailable"; provider: string; detail: string }
>;

export interface GeneratedFallbackReceipt {
  readonly status: "generated";
  readonly assetId: string;
  readonly assetKind: AssetKind;
  readonly purpose: "informative";
  readonly reason: MissingAssetFallbackReason;
  readonly provenance: Readonly<{ kind: "generated"; generator: typeof GENERATOR }>;
  readonly sha256: string;
  readonly localPath: string;
}

export interface OmittedFallbackReceipt {
  readonly status: "omitted";
  readonly assetId: string;
  readonly assetKind: AssetKind;
  readonly purpose: "decorative";
  readonly reason: MissingAssetFallbackReason;
  readonly provenance: Readonly<{ kind: "omitted"; policy: typeof OMISSION_POLICY }>;
}

export type MissingAssetFallbackResult =
  | Readonly<{
    status: "generated";
    planAsset: AssetRecord;
    asset: AssetRecord;
    receipt: GeneratedFallbackReceipt;
  }>
  | Readonly<{
    status: "omitted";
    planAsset: null;
    asset: null;
    receipt: OmittedFallbackReceipt;
  }>;

function invalid(path: string, detail: string): never {
  throw new AssetContractError("ASSET_CONTRACT_INVALID", path, detail);
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid(path, "must be a plain object");
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    return invalid(path, "must be a non-empty string");
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, path: string, expected: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) invalid(`${path}.${key}`, "key is not allowed");
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) invalid(`${path}.${key}`, "is required");
  }
}

function parseReason(value: unknown): MissingAssetFallbackReason {
  const reason = plainObject(value, "reason");
  const code = reason.code;
  if (code === "missing") {
    exactKeys(reason, "reason", ["code", "detail"]);
    return { code, detail: text(reason.detail, "reason.detail") };
  }
  if (code === "provider-unavailable") {
    exactKeys(reason, "reason", ["code", "provider", "detail"]);
    return {
      code,
      provider: text(reason.provider, "reason.provider"),
      detail: text(reason.detail, "reason.detail"),
    };
  }
  return invalid("reason.code", "only missing and provider-unavailable assets may use fallback");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function artwork(kind: AssetKind, theme: Theme, width: number, height: number): string {
  const ink = `#${theme.colors.ink}`;
  const muted = `#${theme.colors.muted}`;
  const rule = `#${theme.colors.rule}`;
  const blue = `#${theme.colors.blue}`;
  const coral = `#${theme.colors.coral}`;
  const stroke = Math.max(2, Math.round(Math.min(width, height) / 180));

  if (kind === "image") {
    return `<rect x="${width * 0.18}" y="${height * 0.2}" width="${width * 0.64}" height="${height * 0.6}" rx="${theme.radius.large}" fill="none" stroke="${rule}" stroke-width="${stroke}"/><circle cx="${width * 0.66}" cy="${height * 0.36}" r="${Math.min(width, height) * 0.055}" fill="${coral}"/><path d="M ${width * 0.22} ${height * 0.74} L ${width * 0.43} ${height * 0.48} L ${width * 0.55} ${height * 0.61} L ${width * 0.68} ${height * 0.5} L ${width * 0.78} ${height * 0.74} Z" fill="${blue}" opacity="0.72"/>`;
  }
  if (kind === "diagram") {
    const nodeWidth = width * 0.2;
    const nodeHeight = height * 0.18;
    const y = height * 0.41;
    const positions = [width * 0.12, width * 0.4, width * 0.68];
    const connectors = positions.slice(0, -1).map((x) => `<path d="M ${x + nodeWidth} ${y + nodeHeight / 2} H ${x + width * 0.28 - stroke * 2}" fill="none" stroke="${muted}" stroke-width="${stroke}"/><path d="M ${x + width * 0.28 - stroke * 5} ${y + nodeHeight / 2 - stroke * 3} L ${x + width * 0.28} ${y + nodeHeight / 2} L ${x + width * 0.28 - stroke * 5} ${y + nodeHeight / 2 + stroke * 3} Z" fill="${muted}"/>`).join("");
    const nodes = positions.map((x, index) => `<rect x="${x}" y="${y}" width="${nodeWidth}" height="${nodeHeight}" rx="${theme.radius.large}" fill="${index === 1 ? blue : coral}" opacity="${index === 1 ? "0.82" : "0.68"}"/>`).join("");
    return `${connectors}${nodes}`;
  }
  if (kind === "chart") {
    const base = height * 0.76;
    const bars = [0.25, 0.48, 0.36, 0.65].map((amount, index) => {
      const barWidth = width * 0.1;
      const x = width * (0.24 + index * 0.14);
      const barHeight = height * amount;
      return `<rect x="${x}" y="${base - barHeight}" width="${barWidth}" height="${barHeight}" rx="${theme.radius.small}" fill="${index % 2 === 0 ? blue : coral}" opacity="0.78"/>`;
    }).join("");
    return `<path d="M ${width * 0.18} ${height * 0.18} V ${base} H ${width * 0.82}" fill="none" stroke="${ink}" stroke-width="${stroke}"/>${bars}`;
  }
  const radius = Math.min(width, height) * 0.25;
  return `<circle cx="${width / 2}" cy="${height / 2}" r="${radius}" fill="${blue}" opacity="0.16"/><circle cx="${width / 2}" cy="${height / 2}" r="${radius}" fill="none" stroke="${blue}" stroke-width="${stroke}"/><path d="M ${width / 2} ${height * 0.34} V ${height * 0.56}" stroke="${ink}" stroke-width="${stroke * 1.5}" stroke-linecap="round"/><circle cx="${width / 2}" cy="${height * 0.66}" r="${stroke * 1.2}" fill="${coral}"/>`;
}

function renderFallbackSvg(asset: AssetRecord, theme: Theme): Uint8Array {
  const title = `Unavailable ${asset.kind}`;
  const description = asset.altDescription;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${asset.width} ${asset.height}" width="${asset.width}" height="${asset.height}" role="img" data-fallback-kind="${asset.kind}"><title>${escapeXml(title)}</title><desc>${escapeXml(description)}</desc><rect width="${asset.width}" height="${asset.height}" fill="#${theme.colors.raised}"/>${artwork(asset.kind, theme, asset.width, asset.height)}</svg>`;
  return new TextEncoder().encode(svg);
}

export async function createMissingAssetFallback(options: {
  readonly plannedAsset: PlanAsset;
  readonly reason: MissingAssetFallbackReason;
  readonly theme: Theme;
  readonly registry: AssetRegistry;
  readonly stagingRoot: string;
}): Promise<MissingAssetFallbackResult> {
  const planned = parseAssetRecord(options.plannedAsset, { path: "plannedAsset" });
  const reason = parseReason(options.reason);

  if (planned.purpose === "decorative") {
    return deepFreeze({
      status: "omitted" as const,
      planAsset: null,
      asset: null,
      receipt: {
        status: "omitted" as const,
        assetId: planned.id,
        assetKind: planned.kind,
        purpose: "decorative" as const,
        reason,
        provenance: { kind: "omitted" as const, policy: OMISSION_POLICY },
      },
    });
  }

  const stagingRoot = await prepareStaging(options.stagingRoot);
  const bytes = renderFallbackSvg(planned, options.theme);
  const stagingPath = resolve(stagingRoot, `.${planned.id}.${randomUUID()}.fallback.svg`);
  try {
    await writeFile(stagingPath, bytes, { flag: "wx", mode: 0o600 });
    const registered = await options.registry.register({
      id: planned.id,
      purpose: planned.purpose as Extract<AssetPurpose, "informative">,
      kind: planned.kind,
      inputPath: stagingPath,
      mediaType: "image/svg+xml",
      width: planned.width,
      height: planned.height,
      altDescription: planned.altDescription,
      source: { kind: "generated", generator: GENERATOR },
      claimIds: planned.claimIds,
    });
    const verified = (await options.registry.verifyForCompilation([registered]))[0]!;
    return deepFreeze({
      status: "generated" as const,
      planAsset: verified,
      asset: verified,
      receipt: {
        status: "generated" as const,
        assetId: verified.id,
        assetKind: verified.kind,
        purpose: "informative" as const,
        reason,
        provenance: { kind: "generated" as const, generator: GENERATOR },
        sha256: verified.sha256,
        localPath: verified.localPath,
      },
    });
  } finally {
    await rm(stagingPath, { force: true });
  }
}
