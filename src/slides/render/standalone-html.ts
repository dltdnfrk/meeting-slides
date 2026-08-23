import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { deckDocument, grabDocument } from "./standalone-document.ts";
import { renderSlideSection } from "./standalone-presentation.ts";
import { embedResources, sha256 } from "./standalone-resources.ts";
import {
  StandaloneHtmlError,
  standaloneFailure,
  type StandaloneDeckInput,
  type StandaloneHtmlArtifact,
  type StandaloneSlideDocument,
} from "./standalone-types.ts";
import { validateDeck } from "./standalone-validation.ts";

export { StandaloneHtmlError };
export type {
  StandaloneDeckInput,
  StandaloneHtmlArtifact,
  StandaloneHtmlErrorCode,
  StandaloneSlideDocument,
  StandaloneSlideInput,
} from "./standalone-types.ts";

const encoder = new TextEncoder();

function artifactFor(html: string): Omit<StandaloneSlideDocument, "filename"> {
  const bytes = encoder.encode(html);
  return { html, bytes, sha256: sha256(bytes) };
}

export function renderStandaloneHtml(input: StandaloneDeckInput): StandaloneHtmlArtifact {
  validateDeck(input);
  const resources = embedResources(input);
  const sections = input.slides.map((_slide, index) => renderSlideSection(input, resources, index));
  const primary = artifactFor(deckDocument(input, resources, sections));
  if (input.expectedSha256 !== undefined && primary.sha256 !== input.expectedSha256.toLowerCase()) {
    standaloneFailure(
      "STANDALONE_OUTPUT_HASH_MISMATCH",
      "expectedSha256",
      `expected '${input.expectedSha256}' but rendered '${primary.sha256}'`,
    );
  }

  const slidesGrabDocuments = input.includeSlidesGrabDocuments === true
    ? sections.map((section, index): StandaloneSlideDocument => ({
      filename: `${input.slides[index]!.geometry.slide.slideId}.html`,
      ...artifactFor(grabDocument(input, resources, section)),
    }))
    : [];
  return { ...primary, slidesGrabDocuments };
}

export function writeStandaloneHtml(
  input: StandaloneDeckInput,
  outputPath: string,
): StandaloneHtmlArtifact {
  const artifact = renderStandaloneHtml(input);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, artifact.bytes);
  return artifact;
}
