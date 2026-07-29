import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const DECK_ASSET_FILENAMES = ["meeting-cover.png", "meeting-topic-map.png"] as const;

export interface DeckAssetCopyInput {
  readonly sourceDirectory: string;
  readonly exportDirectory: string;
  readonly slidesDirectory: string;
}

/** Copies the deck-local images to both HTML roots used by an export. */
export function copyDeckAssets(input: DeckAssetCopyInput): void {
  const exportAssetsDirectory = join(input.exportDirectory, "assets");
  const slideAssetsDirectory = join(input.slidesDirectory, "assets");
  mkdirSync(exportAssetsDirectory, { recursive: true });
  mkdirSync(slideAssetsDirectory, { recursive: true });

  for (const filename of DECK_ASSET_FILENAMES) {
    const source = join(input.sourceDirectory, filename);
    copyFileSync(source, join(exportAssetsDirectory, filename));
    copyFileSync(source, join(slideAssetsDirectory, filename));
  }
}
