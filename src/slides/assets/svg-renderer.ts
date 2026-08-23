import { createHash } from "node:crypto";

import type { AssetKind, AssetMediaType, AssetPurpose, AssetSource } from "./contract.ts";
import type { Theme } from "../model/plan.ts";

export const SEMANTIC_COLOR_TOKENS = [
  "colors.paper",
  "colors.raised",
  "colors.ink",
  "colors.muted",
  "colors.rule",
  "colors.coral",
  "colors.blue",
  "colors.focus",
] as const;

export type SemanticColorToken = (typeof SEMANTIC_COLOR_TOKENS)[number];

export interface GeneratedAssetRegistration {
  readonly purpose: AssetPurpose;
  readonly kind: AssetKind;
  readonly mediaType: AssetMediaType;
  readonly width: number;
  readonly height: number;
  readonly altDescription: string;
  readonly source: AssetSource;
  readonly claimIds: readonly string[];
}

export interface RenderedSvgAsset {
  readonly svg: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly mediaType: "image/svg+xml";
  readonly altDescription: string;
  readonly sha256: string;
  readonly registration: GeneratedAssetRegistration;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

export function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

export function colorValue(theme: Theme, token: unknown): string {
  if (typeof token !== "string" || !SEMANTIC_COLOR_TOKENS.some((item) => item === token)) {
    throw new TypeError("color must be a semantic Theme color token");
  }
  const name = token.slice("colors.".length) as keyof Theme["colors"];
  return `#${theme.colors[name]}`;
}

export function claimIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("informative graphics require at least one claim ID");
  }
  const seen = new Set<string>();
  return Object.freeze(value.map((item, index) => {
    const id = requiredText(item, `claimIds[${index}]`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new TypeError(`claimIds[${index}] must be a stable ID`);
    if (seen.has(id)) throw new TypeError(`claimIds[${index}] duplicates claim ID '${id}'`);
    seen.add(id);
    return id;
  }));
}

export function finishSvg(
  svg: string,
  metadata: Omit<GeneratedAssetRegistration, "mediaType">,
): RenderedSvgAsset {
  const bytes = new TextEncoder().encode(svg);
  return Object.freeze({
    svg,
    bytes,
    width: metadata.width,
    height: metadata.height,
    mediaType: "image/svg+xml" as const,
    altDescription: metadata.altDescription,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    registration: Object.freeze({ ...metadata, mediaType: "image/svg+xml" as const }),
  });
}
