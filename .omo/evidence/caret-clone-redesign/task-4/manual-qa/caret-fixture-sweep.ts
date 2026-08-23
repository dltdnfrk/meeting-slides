import { CARET_UI_STATES } from "/Users/hyunjun/Documents/MUNI/meeting-slides/tests/fixtures/caret-ui-states.ts";
import { createCaretBrowserDriver } from "/Users/hyunjun/Documents/MUNI/meeting-slides/tests/helpers/caret-browser-driver.ts";
const driver = await createCaretBrowserDriver();
const out: Record<string, unknown> = {};
try {
  for (const f of CARET_UI_STATES) {
    const c = await driver.captureState(f);
    out[f.id] = { hash: c.hash, viewport: c.viewport, external: c.externalRequests.length, timer: c.state.captureTimerText, lines: c.state.transcriptLines, slide: c.state.slideTitle, compile: c.state.compileStatusState, overflow: c.state.rootOverflow.horizontal };
  }
} finally { await driver.close(); }
console.log(JSON.stringify(out, null, 2));
