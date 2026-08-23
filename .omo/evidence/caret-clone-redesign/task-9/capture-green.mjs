// Task-9 GREEN evidence capture: token JSON + swatch screenshots at all six
// canonical viewports, plus one reduced-motion capture. Screenshots exist for
// human visual inspection; their bytes are never asserted anywhere.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFoundationProbe } from "../../../../tests/helpers/caret-foundation-probe.ts";

const repoRoot = new URL("../../../../", import.meta.url).pathname;
const outDir = join(repoRoot, ".omo/evidence/caret-clone-redesign/task-9/green");
const shotDir = join(outDir, "screens");
mkdirSync(shotDir, { recursive: true });

const VIEWPORTS = [
  { name: "reference", width: 1440, height: 900 },
  { name: "library", width: 1244, height: 836 },
  { name: "live", width: 960, height: 760 },
  { name: "stacked", width: 820, height: 900 },
  { name: "narrow", width: 375, height: 812 },
  { name: "compact", width: 320, height: 667 },
];

const probe = await createFoundationProbe();
const records = [];

for (const viewport of VIEWPORTS) {
  const snapshot = await probe.measure({ width: viewport.width, height: viewport.height });
  const png = await probe.screenshot({ width: viewport.width, height: viewport.height });
  const file = `foundation-${viewport.name}-${viewport.width}x${viewport.height}.png`;
  writeFileSync(join(shotDir, file), png);
  records.push({
    viewport,
    fontsReady: snapshot.fontsReady,
    externalRequests: snapshot.externalRequests,
    fontRequests: snapshot.fontRequests.map((url) => url.replace(snapshot.origin, "")),
    loadedFamilies: snapshot.loadedFamilies,
    renderedFamilies: snapshot.renderedFamilies,
    computedFamilies: snapshot.computedFamilies,
    backdropFilters: snapshot.backdropFilters,
    focus: snapshot.focus,
    motion: snapshot.motion,
    rootOverflow: snapshot.rootOverflow,
    screenshot: {
      path: `green/screens/${file}`,
      bytes: png.byteLength,
      sha256: createHash("sha256").update(png).digest("hex"),
    },
  });
  if (viewport.name === "library") {
    writeFileSync(join(outDir, "tokens.json"), `${JSON.stringify(snapshot.tokens, null, 2)}\n`);
  }
}

const reduced = await probe.measure({ width: 1244, height: 836 }, { reducedMotion: true });
const reducedPng = await probe.screenshot({ width: 1244, height: 836 }, { reducedMotion: true });
writeFileSync(join(shotDir, "foundation-reduced-motion-1244x836.png"), reducedPng);

writeFileSync(join(outDir, "foundation-states.json"), `${JSON.stringify({
  capturedFor: "caret-clone-redesign todo 9",
  note: "Screenshots are visual-inspection artifacts only; no byte-level golden assertion exists for them anywhere in this task.",
  states: records,
  reducedMotion: {
    tokens: {
      "--cf-motion-quick": reduced.tokens["--cf-motion-quick"],
      "--cf-motion-state": reduced.tokens["--cf-motion-state"],
    },
    computed: reduced.motion,
    canvasUnchanged: reduced.tokens["--cf-canvas"],
    screenshot: {
      path: "green/screens/foundation-reduced-motion-1244x836.png",
      bytes: reducedPng.byteLength,
      sha256: createHash("sha256").update(reducedPng).digest("hex"),
    },
  },
}, null, 2)}\n`);

console.log(JSON.stringify({
  viewports: records.length,
  allFontsReady: records.every((r) => r.fontsReady),
  totalExternalRequests: records.reduce((sum, r) => sum + r.externalRequests.length, 0),
  maxRootOverflow: Math.max(...records.map((r) => r.rootOverflow.horizontal)),
  reducedMotion: reduced.motion,
}, null, 2));

await probe.close();
