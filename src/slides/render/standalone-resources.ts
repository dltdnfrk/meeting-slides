import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ResolvedAssetLayer } from "../assets/integration.ts";
import type { StandaloneDeckInput } from "./standalone-types.ts";
import { standaloneFailure } from "./standalone-types.ts";

const IMAGE_MEDIA = new Set(["image/png", "image/svg+xml", "image/webp", "image/jpeg"]);

export interface EmbeddedPlacement {
  readonly placement: ResolvedAssetLayer["placements"][number];
  readonly dataUrl: string;
}

export interface EmbeddedSlideResources {
  readonly placements: readonly EmbeddedPlacement[];
}

export interface EmbeddedResources {
  readonly fontDataUrl: string;
  readonly slides: readonly EmbeddedSlideResources[];
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function managedFile(
  root: string,
  localPath: string,
  path: string,
  missingCode: "STANDALONE_FONT_NOT_FOUND" | "STANDALONE_ASSET_NOT_FOUND",
  identity: string,
): Uint8Array {
  const unsafe = localPath.trim() === "" || isAbsolute(localPath) || localPath.includes("\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(localPath) || localPath.split("/").some((part) => part === "" || part === "." || part === "..");
  if (unsafe) standaloneFailure("STANDALONE_PATH_UNRESOLVED", path, `'${localPath}' is not a relative path beneath the resource root`);

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    standaloneFailure("STANDALONE_PATH_UNRESOLVED", "resourceRoot", `resource root '${root}' cannot be resolved`);
  }
  const candidate = resolve(canonicalRoot, localPath);
  const lexical = relative(canonicalRoot, candidate);
  if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    standaloneFailure("STANDALONE_PATH_UNRESOLVED", path, `'${localPath}' escapes the resource root`);
  }
  if (!existsSync(candidate)) standaloneFailure(missingCode, path, `${identity} was not found at '${localPath}'`);

  let canonicalFile: string;
  try {
    canonicalFile = realpathSync(candidate);
  } catch {
    standaloneFailure(missingCode, path, `${identity} was not found at '${localPath}'`);
  }
  const physical = relative(canonicalRoot, canonicalFile);
  if (physical === ".." || physical.startsWith(`..${sep}`) || isAbsolute(physical)) {
    standaloneFailure("STANDALONE_PATH_UNRESOLVED", path, `'${localPath}' resolves outside the resource root`);
  }
  return readFileSync(canonicalFile);
}

export function embedResources(input: StandaloneDeckInput): EmbeddedResources {
  if (!input.theme.font.localPath.toLowerCase().endsWith(".woff2")) {
    standaloneFailure("STANDALONE_MEDIA_UNSUPPORTED", "theme.font.localPath", "only local woff2 fonts may be embedded");
  }
  const font = managedFile(input.resourceRoot, input.theme.font.localPath, "theme.font.localPath", "STANDALONE_FONT_NOT_FOUND", "woff2 font");
  if (sha256(font) !== input.theme.font.sha256.toLowerCase()) {
    standaloneFailure("STANDALONE_FONT_HASH_MISMATCH", "theme.font.sha256", `woff2 font sha-256 differs from '${input.theme.font.sha256}'`);
  }

  const slides = input.slides.map((slide, slideIndex): EmbeddedSlideResources => ({
    placements: slide.assets.placements.map((placement, placementIndex): EmbeddedPlacement => {
      const base = `slides[${slideIndex}].assets.placements[${placementIndex}]`;
      if (!IMAGE_MEDIA.has(placement.mediaType)) {
        standaloneFailure("STANDALONE_MEDIA_UNSUPPORTED", `${base}.mediaType`, `media type '${placement.mediaType}' cannot be embedded`);
      }
      const bytes = managedFile(input.resourceRoot, placement.localPath, `${base}.localPath`, "STANDALONE_ASSET_NOT_FOUND", `asset '${placement.assetId}'`);
      if (sha256(bytes) !== placement.sha256.toLowerCase()) {
        standaloneFailure("STANDALONE_ASSET_HASH_MISMATCH", `${base}.sha256`, `asset '${placement.assetId}' bytes do not match its sha-256`);
      }
      if (bytes.byteLength !== placement.byteLength) {
        standaloneFailure("STANDALONE_METADATA_MISMATCH", `${base}.byteLength`, `asset '${placement.assetId}' declares ${placement.byteLength} bytes but has ${bytes.byteLength}`);
      }
      return { placement, dataUrl: `data:${placement.mediaType};base64,${Buffer.from(bytes).toString("base64")}` };
    }),
  }));
  return {
    fontDataUrl: `data:font/woff2;base64,${Buffer.from(font).toString("base64")}`,
    slides,
  };
}
