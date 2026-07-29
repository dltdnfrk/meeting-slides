import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { copyDeckAssets, DECK_ASSET_FILENAMES } from "../src/deck-assets.ts";

test("Given deck-local imagery, When export assets are copied, Then reveal and standalone roots receive byte-identical local files", () => {
  // Given
  const exportDirectory = mkdtempSync(join(tmpdir(), "meeting-slides-export-"));
  const slidesDirectory = join(exportDirectory, "slides");
  const sourceDirectory = join(import.meta.dir, "..", "deck", "assets");

  try {
    // When
    copyDeckAssets({ sourceDirectory, exportDirectory, slidesDirectory });

    // Then
    for (const filename of DECK_ASSET_FILENAMES) {
      const source = readFileSync(join(sourceDirectory, filename));
      const exportAsset = join(exportDirectory, "assets", filename);
      const slideAsset = join(slidesDirectory, "assets", filename);
      expect(existsSync(exportAsset)).toBe(true);
      expect(existsSync(slideAsset)).toBe(true);
      expect(readFileSync(exportAsset)).toEqual(source);
      expect(readFileSync(slideAsset)).toEqual(source);
    }
  } finally {
    rmSync(exportDirectory, { recursive: true, force: true });
  }
});
