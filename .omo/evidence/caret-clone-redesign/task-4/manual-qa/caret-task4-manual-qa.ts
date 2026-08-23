// Temporary manual-QA driver for Todo 4: runs the real Chromium fixture harness at
// the two required sizes twice, writes geometry JSON + screenshots + hash receipts,
// and exercises the pre-subscription failure path. Deleted after evidence capture.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fixtureById } from "/Users/hyunjun/Documents/MUNI/meeting-slides/tests/fixtures/caret-ui-states.ts";
import {
  CaretFixtureTimeoutError,
  createCaretBrowserDriver,
} from "/Users/hyunjun/Documents/MUNI/meeting-slides/tests/helpers/caret-browser-driver.ts";

const EVIDENCE = "/Users/hyunjun/Documents/MUNI/meeting-slides/.omo/evidence/caret-clone-redesign/task-4";

const driver = await createCaretBrowserDriver();
const receipts: Record<string, unknown> = {};

try {
  await mkdir(join(EVIDENCE, "green"), { recursive: true });

  for (const id of ["library-overview", "live-capturing"] as const) {
    const runs = [];
    for (const pass of [1, 2]) {
      const capture = await driver.captureState(fixtureById(id), { screenshot: pass === 1 });
      if (capture.screenshot) {
        await writeFile(join(EVIDENCE, "green", `${id}-${capture.viewport.width}x${capture.viewport.height}.png`), capture.screenshot);
      }
      runs.push({ pass, hash: capture.hash, external: capture.externalRequests, blocked: capture.blockedRequests.length });
      if (pass === 1) {
        await writeFile(
          join(EVIDENCE, "green", `${id}-machine-state.json`),
          `${JSON.stringify(JSON.parse(capture.json), null, 2)}\n`,
        );
        await writeFile(
          join(EVIDENCE, "green", `${id}-timeline.json`),
          `${JSON.stringify({ timeline: capture.timeline, clientActions: capture.clientActions }, null, 2)}\n`,
        );
        receipts[id] = {
          viewport: capture.viewport,
          geometry: capture.state.geometry,
          rootOverflow: capture.state.rootOverflow,
          environment: capture.state.environment,
          captureTimerText: capture.state.captureTimerText,
          transcriptLines: capture.state.transcriptLines,
        };
      }
    }
    (receipts[id] as Record<string, unknown>).runs = runs;
    (receipts[id] as Record<string, unknown>).identical = runs[0]!.hash === runs[1]!.hash;
  }

  // Failure probe: slide before the subscribed capture state.
  const probe = {
    ...fixtureById("live-capturing"),
    id: "live-capturing-pre-subscription",
    events: [{ message: { type: "slide", current: null, history: [] } as const, awaitState: "capture:capturing" as const }],
  };
  const failure = await driver.captureState(probe).then(() => null, (error: unknown) => error);
  receipts.failureProbe = failure instanceof CaretFixtureTimeoutError
    ? {
        name: failure.name,
        fixtureId: failure.fixtureId,
        missingState: failure.missingState,
        timeoutMs: failure.timeoutMs,
        capturedStale: failure.capturedStale,
        message: failure.message,
      }
    : { unexpected: String(failure) };
} finally {
  await driver.close();
}

await writeFile(join(EVIDENCE, "green", "manual-qa-receipts.json"), `${JSON.stringify(receipts, null, 2)}\n`);
console.log(JSON.stringify(receipts, null, 2));
