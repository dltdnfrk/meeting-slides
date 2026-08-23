import {
  array, exact, integer, isoDate, oneOf, positive, record, sha256,
  stableId, text, unique, SlidePlanParseError,
} from "./parse-helpers.ts";

function color(value: unknown, path: string): void {
  if (typeof value !== "string" || !/^[0-9A-F]{6}$/i.test(value)) {
    throw new SlidePlanParseError(path, "must be a six-digit hexadecimal color");
  }
}

function textStyle(value: unknown, path: string): void {
  const style = exact(value, path, ["size", "lineHeight", "weight"]);
  positive(style.size, `${path}.size`);
  positive(style.lineHeight, `${path}.lineHeight`);
  integer(style.weight, `${path}.weight`, 1);
}

export function validateTheme(value: unknown): void {
  const theme = exact(value, "theme", [
    "id", "canvas", "font", "colors", "spacing", "typography", "stroke", "radius",
  ]);
  stableId(theme.id, "theme.id");
  const canvas = exact(theme.canvas, "theme.canvas", ["width", "height"]);
  integer(canvas.width, "theme.canvas.width", 1);
  integer(canvas.height, "theme.canvas.height", 1);
  const font = exact(theme.font, "theme.font", ["family", "localPath", "sha256"]);
  text(font.family, "theme.font.family");
  const fontPath = text(font.localPath, "theme.font.localPath");
  if (/^(?:[a-z]+:|\/)|(?:^|\/)\.\.(?:\/|$)/i.test(fontPath)) {
    throw new SlidePlanParseError("theme.font.localPath", "must be a managed local path");
  }
  sha256(font.sha256, "theme.font.sha256");
  const colors = exact(theme.colors, "theme.colors", [
    "paper", "raised", "ink", "muted", "rule", "coral", "blue", "focus",
  ]);
  for (const key of ["paper", "raised", "ink", "muted", "rule", "coral", "blue", "focus"] as const) {
    color(colors[key], `theme.colors.${key}`);
  }
  const spacing = exact(theme.spacing, "theme.spacing", ["xs", "sm", "md", "lg", "xl"]);
  for (const key of ["xs", "sm", "md", "lg", "xl"] as const) positive(spacing[key], `theme.spacing.${key}`);
  const typography = exact(theme.typography, "theme.typography", ["display", "heading", "body", "label"]);
  for (const key of ["display", "heading", "body", "label"] as const) textStyle(typography[key], `theme.typography.${key}`);
  const stroke = exact(theme.stroke, "theme.stroke", ["thin", "strong"]);
  positive(stroke.thin, "theme.stroke.thin");
  positive(stroke.strong, "theme.stroke.strong");
  const radius = exact(theme.radius, "theme.radius", ["small", "large"]);
  positive(radius.small, "theme.radius.small");
  positive(radius.large, "theme.radius.large");
}

export interface SnapshotContext { transcriptVersionId: string; lineCount: number }

export function validateClaims(value: unknown, snapshot: SnapshotContext): Set<string> {
  const ids: string[] = [];
  array(value, "claims", true).forEach((claim, claimIndex) => {
    const path = `claims[${claimIndex}]`;
    const parsed = exact(claim, path, ["id", "kind", "text", "sources", "method"]);
    ids.push(stableId(parsed.id, `${path}.id`));
    oneOf(parsed.kind, `${path}.kind`, ["fact", "decision", "quote", "action"]);
    text(parsed.text, `${path}.text`);
    oneOf(parsed.method, `${path}.method`, ["extractive", "verbatim", "reviewed"]);
    let previousEnd: number | undefined;
    array(parsed.sources, `${path}.sources`, true).forEach((source, sourceIndex) => {
      const sourcePath = `${path}.sources[${sourceIndex}]`;
      const range = exact(source, sourcePath,
        ["transcriptVersionId", "startSeq", "endSeq", "evidenceQuote"]);
      const version = text(range.transcriptVersionId, `${sourcePath}.transcriptVersionId`);
      if (version !== snapshot.transcriptVersionId) {
        throw new SlidePlanParseError(`${sourcePath}.transcriptVersionId`, "must match the snapshot transcriptVersionId");
      }
      const start = integer(range.startSeq, `${sourcePath}.startSeq`, 1);
      const end = integer(range.endSeq, `${sourcePath}.endSeq`, 1);
      if (start > end) throw new SlidePlanParseError(sourcePath, "source range is invalid: startSeq exceeds endSeq");
      if (end > snapshot.lineCount) {
        throw new SlidePlanParseError(`${sourcePath}.endSeq`, "must not exceed snapshot.lineCount");
      }
      if (previousEnd !== undefined && start !== previousEnd + 1) {
        throw new SlidePlanParseError(`${path}.sources`, "contains non-contiguous source ranges");
      }
      previousEnd = end;
      text(range.evidenceQuote, `${sourcePath}.evidenceQuote`);
    });
  });
  unique(ids, "claims", "claim ID", ".id");
  return new Set(ids);
}

function validateAssetSource(value: unknown, path: string): void {
  const source = record(value, path);
  const kind = oneOf(source.kind, `${path}.kind`, ["local", "generated", "retrieved"]);
  switch (kind) {
    case "local": {
      const local = exact(source, path, ["kind", "originalPath"]);
      text(local.originalPath, `${path}.originalPath`);
      break;
    }
    case "generated": {
      const generated = exact(source, path, ["kind", "generator"]);
      text(generated.generator, `${path}.generator`);
      break;
    }
    case "retrieved": {
      const retrieved = exact(source, path, ["kind", "url", "retrievedAt"]);
      const url = text(retrieved.url, `${path}.url`);
      try { new URL(url); } catch { throw new SlidePlanParseError(`${path}.url`, "must be an absolute URL"); }
      isoDate(retrieved.retrievedAt, `${path}.retrievedAt`);
      break;
    }
  }
}

export function validateAssets(value: unknown, claimIds: ReadonlySet<string>): Set<string> {
  const ids: string[] = [];
  array(value, "assets").forEach((asset, assetIndex) => {
    const path = `assets[${assetIndex}]`;
    const parsed = exact(asset, path, [
      "id", "purpose", "kind", "localPath", "mediaType", "width", "height", "byteLength",
      "sha256", "altDescription", "source", "claimIds",
    ]);
    ids.push(stableId(parsed.id, `${path}.id`));
    const purpose = oneOf(parsed.purpose, `${path}.purpose`, ["informative", "decorative"]);
    oneOf(parsed.kind, `${path}.kind`, ["image", "diagram", "chart", "icon"]);
    const hash = sha256(parsed.sha256, `${path}.sha256`);
    const localPath = text(parsed.localPath, `${path}.localPath`);
    if (!/^assets\/[A-Za-z0-9._-]+$/.test(localPath) || localPath.includes("..")) {
      throw new SlidePlanParseError(`${path}.localPath`, "must be a managed local asset path, not a hotlink");
    }
    if (!localPath.startsWith(`assets/${hash}.`)) {
      throw new SlidePlanParseError(`${path}.localPath`, "filename must contain the asset hash");
    }
    text(parsed.mediaType, `${path}.mediaType`);
    integer(parsed.width, `${path}.width`, 1);
    integer(parsed.height, `${path}.height`, 1);
    integer(parsed.byteLength, `${path}.byteLength`, 1);
    text(parsed.altDescription, `${path}.altDescription`);
    validateAssetSource(parsed.source, `${path}.source`);
    const references = array(parsed.claimIds, `${path}.claimIds`).map((claimId, claimIndex) => {
      const id = stableId(claimId, `${path}.claimIds[${claimIndex}]`);
      if (!claimIds.has(id)) throw new SlidePlanParseError(`${path}.claimIds[${claimIndex}]`, `unknown claim '${id}'`);
      return id;
    });
    if (purpose === "informative" && references.length === 0) {
      throw new SlidePlanParseError(`${path}.claimIds`, "informative assets require at least one claim");
    }
    unique(references, `${path}.claimIds`, "claim reference");
  });
  unique(ids, "assets", "asset ID", ".id");
  return new Set(ids);
}
