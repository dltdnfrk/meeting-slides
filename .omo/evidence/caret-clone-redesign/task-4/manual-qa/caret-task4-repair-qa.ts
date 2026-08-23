// Repair-round manual QA: real Chromium at ALL required viewports, machine JSON +
// geometry hashes, screenshot-byte-stability truth check, click ordering receipts.
// Temporary; archived to evidence and deleted afterwards.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CARET_UI_STATES, fixtureById } from "/Users/hyunjun/Documents/MUNI/meeting-slides/tests/fixtures/caret-ui-states.ts";
import { createCaretBrowserDriver } from "/Users/hyunjun/Documents/MUNI/meeting-slides/tests/helpers/caret-browser-driver.ts";

const EVIDENCE = "/Users/hyunjun/Documents/MUNI/meeting-slides/.omo/evidence/caret-clone-redesign/task-4";
const REQUIRED = ["reference-library", "library-overview", "live-capturing", "stacked-live", "narrow-live", "narrow-compact"] as const;

const driver = await createCaretBrowserDriver();
const receipts: Record<string, unknown> = {};

try {
  await mkdir(join(EVIDENCE, "green"), { recursive: true });

  // All fixtures: machine JSON hash, twice, in this process.
  const sweep: Record<string, unknown> = {};
  for (const state of CARET_UI_STATES) {
    const a = await driver.captureState(state);
    const b = await driver.captureState(state);
    sweep[state.id] = {
      viewport: a.viewport,
      jsonHash: a.hash,
      jsonStable: a.json === b.json,
      geometryStable: JSON.stringify(a.state.geometry) === JSON.stringify(b.state.geometry),
      layout: a.state.layout,
      rootOverflow: a.state.rootOverflow.horizontal,
      external: a.externalRequests.length,
      triggerKinds: a.timeline.map((s) => s.triggerKind),
    };
  }
  receipts.allFixtures = sweep;

  // Required viewports: screenshots + geometry receipts + screenshot-byte truth.
  const perViewport: Record<string, unknown> = {};
  for (const id of REQUIRED) {
    const fixture = fixtureById(id);
    const a = await driver.captureState(fixture, { screenshot: true });
    const b = await driver.captureState(fixture, { screenshot: true });
    const name = `${id}-${a.viewport.width}x${a.viewport.height}`;
    await writeFile(join(EVIDENCE, "green", `${name}.png`), a.screenshot!);
    await writeFile(join(EVIDENCE, "green", `${id}-machine-state.json`), `${JSON.stringify(JSON.parse(a.json), null, 2)}\n`);
    await writeFile(join(EVIDENCE, "green", `${id}-timeline.json`), `${JSON.stringify({ timeline: a.timeline, clientActions: a.clientActions }, null, 2)}\n`);
    perViewport[id] = {
      viewport: a.viewport,
      machineJsonHash: a.hash,
      machineJsonByteStable: a.json === b.json,
      geometryByteStable: JSON.stringify(a.state.geometry) === JSON.stringify(b.state.geometry),
      geometry: a.state.geometry,
      layout: a.state.layout,
      rootOverflow: a.state.rootOverflow,
      screenshotBytes: a.screenshot!.byteLength,
      // Truthful observation, NOT an assertion: screenshots are visual artifacts.
      screenshotByteIdenticalAcrossRuns:
        createHash("sha256").update(a.screenshot!).digest("hex")
        === createHash("sha256").update(b.screenshot!).digest("hex"),
    };
  }
  receipts.requiredViewports = perViewport;

  // Click-step ordering receipt.
  const clicked = await driver.captureState(fixtureById("library-overview"));
  receipts.clickOrdering = {
    steps: clicked.timeline.map((s) => ({
      awaitState: s.awaitState,
      triggerKind: s.triggerKind,
      subscribedAtSeq: s.subscribedAtSeq,
      triggeredAtSeq: s.triggeredAtSeq,
      harnessSentBefore: s.harnessSentBefore,
      harnessSentAfter: s.harnessSentAfter,
      pageArmedOrdinal: s.pageArmedOrdinal,
      pageTriggeredOrdinal: s.pageTriggeredOrdinal,
    })),
    clientActions: clicked.clientActions,
  };
} finally {
  await driver.close();
}

await writeFile(join(EVIDENCE, "green", "repair-qa-receipts.json"), `${JSON.stringify(receipts, null, 2)}\n`);
console.log(JSON.stringify(receipts.requiredViewports, null, 2));
console.log("CLICK ORDERING:", JSON.stringify(receipts.clickOrdering, null, 2));
