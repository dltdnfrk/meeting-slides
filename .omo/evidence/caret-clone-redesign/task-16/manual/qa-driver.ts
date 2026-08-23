// Task 16 manual QA driver — real Chromium + compiled native client, ONE session.
//
// This is the human-inspectable counterpart of tests/caret-dual-surface.test.ts:
// it walks the full capture journey once and writes, at each step, a same-size
// browser screenshot plus the native surface's own projected state, so the two
// surfaces can be compared side by side rather than only through assertions.
//
// Run:  bun run .omo/evidence/caret-clone-redesign/task-16/manual/qa-driver.ts
// It deletes nothing and touches no product file.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createDualSurfaceSession } from "../../../../../tests/helpers/dual-surface-session.ts";
import {
  compileNativeDualSurfaceDriver,
  startNativeSurfaceClient,
} from "../../../../../tests/helpers/native-dual-surface-client.ts";
import {
  createBrowserSurfaceClient,
  launchBrowser,
} from "../../../../../tests/helpers/browser-dual-surface-client.ts";

const OUT = join(import.meta.dir, "qa");
mkdirSync(OUT, { recursive: true });

const CLOCK = 1_710_376_860_000;
const STARTED_AT = CLOCK - 125_000;

const P = {
  capturing: `() => document.querySelector(".app").classList.contains("app--capturing")`,
  notCapturing: `() => document.querySelector(".app").classList.contains("app--capturing") === false`,
  lines: (n: number) => `() => document.querySelectorAll("#transcript-stream .feed-line").length === ${n}`,
  phase: (v: string) => `() => document.querySelector(".app").dataset.capturePhase === ${JSON.stringify(v)}`,
  selected: (id: number) =>
    `() => document.querySelector('#session-list .session-row--selected[data-meeting-id="${id}"]') !== null`,
};

const steps: Array<Record<string, unknown>> = [];

const compiled = compileNativeDualSurfaceDriver();
if (compiled.exitCode !== 0) {
  console.error(compiled.log);
  process.exit(1);
}

const session = createDualSurfaceSession({
  startedAt: STARTED_AT,
  meetings: [
    { id: 7, title: "주간 팀 회의", started_at: STARTED_AT, status: "open" },
    { id: 6, title: "제품 로드맵 검토", started_at: STARTED_AT - 3_600_000, status: "ended" },
  ],
});

const browser = await launchBrowser();
const webReady = session.waitForClient("browser");
const web = await createBrowserSurfaceClient(browser, {
  origin: session.origin,
  clientLabel: "browser",
  clockEpochMs: CLOCK,
  viewport: { width: 1244, height: 836 },
});
await webReady;

const native = await startNativeSurfaceClient(compiled.binary, `${session.wsUrl}?client=native`);
await native.setNow(CLOCK);
const nativeReady = session.waitForClient("native");
await native.connect();
await nativeReady;
await native.setMode("expanded");

async function record(name: string): Promise<void> {
  const shot = await web.screenshot();
  writeFileSync(join(OUT, `${name}.png`), shot);
  const browserState = await web.read();
  const nativeState = native.latest;
  const step = {
    step: name,
    browser: {
      capturePhase: browserState.capturePhase,
      shell: browserState.shell,
      capturing: browserState.capturing,
      timer: browserState.captureTimerText,
      transcriptLines: browserState.transcriptLineCount,
      selectedMeetingIds: browserState.selectedMeetingIds,
      connection: browserState.connection,
    },
    native: {
      status: nativeState?.status,
      capturePhase: nativeState?.capturePhase,
      timer: nativeState?.timer,
      glyph: nativeState?.glyph,
      title: nativeState?.title,
      lines: nativeState?.lines.map((l) => ({ text: l.text, provisional: l.provisional })),
      stopEnabled: nativeState?.stopEnabled,
      connection: nativeState?.connection,
    },
    // The cross-surface invariant this whole task exists to protect: while the
    // server owns a capture, BOTH surfaces must show the same value, and both
    // must have derived it from the server's `startedAt` rather than a local
    // stopwatch.
    //
    // While IDLE there is no capture to time, so the two surfaces are allowed to
    // differ by design: the ambient minibar shows no timer at all (`null`, it
    // holds nothing between meetings) while the workspace leaves the just-ended
    // meeting's final duration on screen beside the meeting it just restored.
    // That difference is recorded, not asserted away.
    capturePhaseOwnsTimer: browserState.capturePhase === "capturing" || browserState.capturePhase === "stopping",
    timersAgree: browserState.captureTimerText === (nativeState?.timer ?? ""),
  };
  steps.push(step);
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(step, null, 2)}\n`);
  console.log(`${name}: browser=${step.browser.capturePhase}/${step.browser.timer} native=${step.native.status}/${step.native.timer} agree=${step.timersAgree}`);
}

// 1 — both surfaces idle after hydration
await record("01-idle-hydrated");

// 2 — manual start from the browser
{
  const live = web.expect("live", P.capturing);
  const nativeLive = native.expect("native-live", (s) => s.status === "live");
  const inbound = session.nextCommand("startCapture");
  await web.click("#btn-record");
  await inbound;
  session.startCapture();
  await live;
  await nativeLive;
}
await record("02-capturing");

// 3 — live transcript on both surfaces
{
  const lines = web.expect("lines", P.lines(3));
  const nativeLines = native.expect("native-lines", (s) => s.lines.length === 3);
  session.line({ text: "첫 번째 문장입니다", ts: STARTED_AT + 1_000 });
  session.line({ text: "두 번째 문장입니다", ts: STARTED_AT + 2_000, speaker: 1 });
  session.line({ text: "세 번째 문장입니다", ts: STARTED_AT + 3_000, speaker: 2 });
  await lines;
  await nativeLines;
}
await record("03-live-transcript");

// 4 — native transport loss alone: reconnecting, capture truth retained
{
  const reconnecting = native.expect("native-reconnecting", (s) => s.connection === "reconnecting");
  session.disconnectClient("native");
  await reconnecting;
}
await record("04-native-disconnected");

// 5 — native rejoins and re-enters live from the snapshot
{
  const rejoined = session.waitForClient("native");
  const relive = native.expect("native-relive", (s) => s.connection === "online" && s.status === "live");
  await native.connect();
  await rejoined;
  await relive;
}
await record("05-native-reconnected");

// 6 — browser reload during capture re-enters live
{
  const rejoined = session.waitForClient("browser");
  await web.reload();
  await rejoined;
  await web.expect("relive", P.capturing);
  await web.expect("relines", P.lines(3));
}
await record("06-browser-reloaded");

// 7 — the stop window: stopping on both surfaces, timer alive
{
  const stopping = web.expect("stopping", P.phase("stopping"));
  const nativeStopping = native.expect("native-stopping", (s) => s.status === "stopping");
  session.beginStop();
  await stopping;
  await nativeStopping;
}
await record("07-stopping");

// 8 — a trailing line still lands on both surfaces
{
  const tail = web.expect("tail", P.lines(4));
  const nativeTail = native.expect("native-tail", (s) => s.lines.some((l) => l.text === "마지막 정리 문장입니다"));
  session.line({ text: "마지막 정리 문장입니다", ts: STARTED_AT + 5_000 });
  await tail;
  await nativeTail;
}
await record("08-trailing-line");

// 9 — authoritative idle restores the just-ended meeting
{
  const idle = web.expect("idle", P.notCapturing);
  const nativeIdle = native.expect("native-idle", (s) => s.status === "idle");
  const restored = web.expect("restored", P.selected(7));
  session.setMeetings([
    { id: 7, title: "주간 팀 회의", started_at: STARTED_AT, status: "ended" },
    { id: 6, title: "제품 로드맵 검토", started_at: STARTED_AT - 3_600_000, status: "ended" },
  ]);
  session.finishStop();
  await idle;
  await nativeIdle;
  await restored;
}
await record("09-idle-restored");

writeFileSync(
  join(OUT, "summary.json"),
  `${JSON.stringify(
    {
      generatedBy: ".omo/evidence/caret-clone-redesign/task-16/manual/qa-driver.ts",
      clockEpochMs: CLOCK,
      serverStartedAt: STARTED_AT,
      viewport: { width: 1244, height: 836, deviceScaleFactor: 1 },
      swiftDriverCompileExit: compiled.exitCode,
      steps,
      commands: session.commands.map((c) => ({ label: c.label, raw: c.raw })),
      // The real contract: agreement in every state where a capture exists.
      timersAgreeWhileCaptureOwned: steps
        .filter((s) => s.capturePhaseOwnsTimer === true)
        .every((s) => s.timersAgree === true),
      idleStepsWhereSurfacesDifferByDesign: steps
        .filter((s) => s.capturePhaseOwnsTimer !== true)
        .map((s) => s.step),
      stopCaptureCommands: session.commandsOf("stopCapture").length,
      selectMeetingCommands: session.commandsOf("selectMeeting").map((c) => c.raw),
    },
    null,
    2,
  )}\n`,
);

console.log(
  "\ntimers agree in every capture-owning state:",
  steps.filter((s) => s.capturePhaseOwnsTimer === true).every((s) => s.timersAgree === true),
);
console.log("stopCapture commands on the wire:", session.commandsOf("stopCapture").length);
console.log("selectMeeting commands:", session.commandsOf("selectMeeting").map((c) => c.raw).join(" "));

await native.close();
await web.close();
await browser.close();
session.stop();
compiled.cleanup();
