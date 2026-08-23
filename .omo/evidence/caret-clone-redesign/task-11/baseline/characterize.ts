// Baseline characterization of the CURRENT library shell before Todo 11.
// Reads real geometry / ARIA / visibility from the shipped surface in Chromium.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fixtureById } from "../../../../../tests/fixtures/caret-ui-states.ts";
import { createCaretBrowserDriver } from "../../../../../tests/helpers/caret-browser-driver.ts";

const outDir = join(import.meta.dir);

const driver = await createCaretBrowserDriver();
try {
  const report: Record<string, unknown> = {};
  for (const id of ["empty-library", "library-overview", "library-transcript"]) {
    const capture = await driver.captureState(fixtureById(id), { screenshot: true });
    report[id] = {
      viewport: capture.viewport,
      geometry: capture.state.geometry,
      layout: capture.state.layout,
      rootOverflow: capture.state.rootOverflow,
      meetingTitles: capture.state.meetingTitles,
      transcriptLines: capture.state.transcriptLines,
    };
    await writeFile(join(outDir, `${id}.png`), capture.screenshot!);
  }
  await writeFile(join(outDir, "baseline-geometry.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await driver.close();
}
