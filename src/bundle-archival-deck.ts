import {
  buildDeckHtml,
  buildSlideFiles,
  type DeckInput,
  type SlideFile,
} from "./deck.ts";

export const BUNDLE_ARCHIVAL_DECK_ROLE = "archival-minutes-companion" as const;

export interface BundleArchivalDeck {
  readonly role: typeof BUNDLE_ARCHIVAL_DECK_ROLE;
  readonly indexHtml: string;
  readonly files: readonly SlideFile[];
}

export type BundleArchivalDeckInput = DeckInput;

const ROLE_MARKER =
  `<meta name="meeting-slides-artifact-role" content="${BUNDLE_ARCHIVAL_DECK_ROLE}" />`;

function markArchival(html: string): string {
  if (!html.includes("<head>")) throw new TypeError("archival deck HTML is missing <head>");
  return html.replace("<head>", `<head>\n${ROLE_MARKER}`);
}

/**
 * Compatibility boundary for the required conclusion-bundle companion deck.
 *
 * This renderer is not the canonical interactive/published deck engine. Only
 * bundle export may use it; every HTML document carries a machine-readable role
 * marker so consumers cannot mistake it for a SlidePlan publication.
 */
export function buildBundleArchivalDeck(input: BundleArchivalDeckInput): BundleArchivalDeck {
  return Object.freeze({
    role: BUNDLE_ARCHIVAL_DECK_ROLE,
    indexHtml: markArchival(buildDeckHtml(input)),
    files: Object.freeze(buildSlideFiles(input).map((file) => Object.freeze({
      ...file,
      html: markArchival(file.html),
    }))),
  });
}
