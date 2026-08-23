// Cross-surface capture restoration (plan caret-clone-redesign, Todo 16).
//
// ONE local Bun session drives BOTH shipping surfaces at the same time:
//   * the real Chromium workspace loading the shipped `public/` assets, and
//   * the real compiled native client (`macos/TransportClient.swift` +
//     `macos/MinibarProjection.swift`) over a real `URLSessionWebSocketTask`.
//
// Both are ordinary WebSocket clients of the same fixture session, so every
// assertion below is about the ONE server truth reaching TWO projections — never
// about a mock agreeing with itself.
//
// What this suite pins (Todo 16 acceptance):
//   * both surfaces derive the timer from the server's `startedAt`, never a
//     local stopwatch, and therefore agree digit-for-digit;
//   * neither surface claims capture stopped when its transport drops;
//   * rapid Stop from either surface puts exactly ONE existing command on the
//     wire (`{"action":"stopCapture"}`);
//   * the stop window is truthful on both surfaces while trailing transcript
//     lines are still flushing, and those trailing lines are not lost;
//   * a reconnect snapshot deduplicates the transcript and restores the correct
//     shell; a browser reload during capture re-enters live;
//   * authoritative idle restores the just-ended meeting exactly once;
//   * stale meeting/job frames and malformed/out-of-order frames cannot
//     overwrite current state on either surface;
//   * phase-less capture frames keep working unchanged.
//
// Determinism: the browser clock is frozen, the native clock is injected, every
// awaited state is SUBSCRIBED to before its trigger, every await is bounded, and
// nothing sleeps, polls or uses `waitForTimeout`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser } from "puppeteer";

import {
  createDualSurfaceSession,
  type DualSurfaceSession,
} from "./helpers/dual-surface-session.ts";
import {
  compileNativeDualSurfaceDriver,
  startNativeSurfaceClient,
  type NativeSurfaceClient,
} from "./helpers/native-dual-surface-client.ts";
import {
  createBrowserSurfaceClient,
  launchBrowser,
  type BrowserSurfaceClient,
} from "./helpers/browser-dual-surface-client.ts";

const ROOT = resolve(import.meta.dir, "..");

/** Frozen browser clock and injected native clock share one epoch. */
const CLOCK_EPOCH_MS = 1_710_376_860_000;
/** Server-authoritative capture origin: 125s before the frozen clock. */
const STARTED_AT_MS = CLOCK_EPOCH_MS - 125_000;
/** Both surfaces must render this from `startedAt` alone. */
const EXPECTED_TIMER = "02:05";

const MEETINGS = [
  { id: 7, title: "주간 팀 회의", started_at: STARTED_AT_MS, status: "open" as const },
  { id: 6, title: "제품 로드맵 검토", started_at: STARTED_AT_MS - 3_600_000, status: "ended" as const },
];

let session: DualSurfaceSession;
let browser: Browser;
let web: BrowserSurfaceClient;
let native: NativeSurfaceClient;
let compileExit = -1;
let compileLog = "";
let cleanupNativeBuild: (() => void) | null = null;

/** Predicate sources evaluated INSIDE the page. Self-contained by contract. */
const P = {
  connected: `() => document.documentElement.dataset.connection === "connected"`,
  capturing: `() => document.querySelector(".app").classList.contains("app--capturing")`,
  notCapturing: `() => document.querySelector(".app").classList.contains("app--capturing") === false`,
  phase: (value: string) => `() => document.querySelector(".app").dataset.capturePhase === ${JSON.stringify(value)}`,
  shell: (value: string) => `() => document.querySelector(".app").dataset.shell === ${JSON.stringify(value)}`,
  transcriptLines: (count: number) =>
    `() => document.querySelectorAll("#transcript-stream .feed-line").length === ${count}`,
  transcriptContains: (text: string) =>
    `() => [...document.querySelectorAll("#transcript-stream .feed-line")].some((n) => n.textContent.includes(${JSON.stringify(text)}))`,
  meetingsListed: (count: number) =>
    `() => document.querySelectorAll("#session-list .session-row").length === ${count}`,
  meetingSelected: (id: number) =>
    `() => document.querySelector('#session-list .session-row--selected[data-meeting-id="${id}"]') !== null`,
  captionShown: (text: string) =>
    `() => document.getElementById("caption-text").textContent.trim() === ${JSON.stringify(text)}`,
  timer: (value: string) =>
    `() => document.getElementById("capture-timer").textContent.trim() === ${JSON.stringify(value)}`,
  compileState: (value: string) =>
    `() => document.getElementById("compile-status").dataset.state === ${JSON.stringify(value)}`,
  disconnected: `() => document.documentElement.dataset.connection === "disconnected"`,
};

beforeAll(async () => {
  const compiled = compileNativeDualSurfaceDriver();
  compileExit = compiled.exitCode;
  compileLog = compiled.log;
  cleanupNativeBuild = compiled.cleanup;
  if (compileExit !== 0) return;

  session = createDualSurfaceSession({ startedAt: STARTED_AT_MS, meetings: MEETINGS });

  browser = await launchBrowser();
  const webReady = session.waitForClient("browser");
  web = await createBrowserSurfaceClient(browser, {
    origin: session.origin,
    clientLabel: "browser",
    clockEpochMs: CLOCK_EPOCH_MS,
  });
  await webReady;

  native = await startNativeSurfaceClient(compiled.binary, `${session.wsUrl}?client=native`);
  await native.setNow(CLOCK_EPOCH_MS);
  const nativeReady = session.waitForClient("native");
  await native.connect();
  await nativeReady;
  // Expanded is the mode that projects the bounded three-finals window; the
  // collapsed surface deliberately shows one row, so the transcript assertions
  // below would otherwise be reading a viewport rule rather than a projection.
  await native.setMode("expanded");
}, 180_000);

afterAll(async () => {
  await native?.close().catch(() => {});
  await web?.close().catch(() => {});
  await browser?.close().catch(() => {});
  session?.stop();
  cleanupNativeBuild?.();
}, 60_000);

describe("dual-surface seam builds and connects", () => {
  test("the native client compiles against the SHIPPING pure modules", () => {
    expect(compileLog).not.toMatch(/error:/);
    expect(compileExit).toBe(0);
  }, 20_000);

  test("one session holds both surfaces as independent clients", () => {
    expect([...session.clientLabels].sort()).toEqual(["browser", "native"]);
  }, 20_000);

  test("no surface in this seam synchronises on elapsed time", () => {
    // The whole seam must be event-driven: every await is settled by a real
    // observation (a DOM mutation, an NDJSON state line, a socket message) and
    // bounded by a deadline that can only ever REJECT. A delay used as
    // synchronisation would make the dual-surface result depend on scheduling.
    const sources = [
      "tests/caret-dual-surface.test.ts",
      "tests/helpers/dual-surface-session.ts",
      "tests/helpers/native-dual-surface-client.ts",
      "tests/helpers/browser-dual-surface-client.ts",
      "tests/fixtures/native-dual-surface-driver.swift",
    ];
    // Patterns are assembled from fragments so this scanner's own source cannot
    // match the rule it enforces.
    const forbidden = [
      ["wait", "ForTimeout"],
      ["Bun\\.", "sleep"],
      ["Thread\\.", "sleep"],
      ["set", "Interval"],
      // A RESOLVING timer is a delay; only rejecting deadlines are allowed.
      ["set", "Timeout\\(\\s*resolve"],
    ].map((parts) => new RegExp(parts.join("")));

    for (const relative of sources) {
      const body = readFileSync(join(ROOT, relative), "utf-8");
      // Strip comments so the prose describing the rule cannot trip the rule.
      const code = body
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      for (const pattern of forbidden) {
        expect({ file: relative, pattern: pattern.source, matched: pattern.test(code) })
          .toEqual({ file: relative, pattern: pattern.source, matched: false });
      }
    }
  }, 20_000);

  test("the native driver drives the real transport module, not a copy", () => {
    const driver = readFileSync(join(ROOT, "tests", "fixtures", "native-dual-surface-driver.swift"), "utf-8");
    expect(driver).toContain("URLSessionWebSocketTask");
    expect(driver).toContain("TransportClient()");
    expect(driver).toContain("MinibarProjection()");
    // No second state store and no AppKit in the headless client.
    expect(driver).not.toMatch(/import AppKit/);
  }, 20_000);
});
describe("browser client hydration is not connection state", () => {
  test("both surfaces hydrate idle from the same connect snapshot", async () => {
    const state = await web.read();
    expect(state.connection).toBe("connected");
    expect(state.capturing).toBe(false);
    expect(native.latest?.capturePhase).toBe("idle");
    expect(native.latest?.connection).toBe("online");
  }, 20_000);
});
describe("manual start from the browser reaches both surfaces", () => {
  test("startCapture uses the existing action and meeting_id spelling", async () => {
    const started = web.expect("browser:capturing", P.capturing);
    const nativeLive = native.expect("native:live", (s) => s.status === "live");
    // Subscribed BEFORE the click, so the command cannot be missed or raced.
    const inbound = session.nextCommand("startCapture");
    await web.click("#btn-record");
    const command = (await inbound).parsed as Record<string, unknown>;
    expect(Object.keys(command).sort()).toEqual(["action"]);

    session.startCapture();
    await started;
    await nativeLive;

    const state = await web.read();
    expect(state.capturing).toBe(true);
    expect(native.latest?.capturePhase).toBe("capturing");
  }, 20_000);

  test("both surfaces derive the SAME timer from the server startedAt", async () => {
    const state = await web.read();
    expect(state.captureTimerText).toBe(EXPECTED_TIMER);
    expect(native.latest?.timer).toBe(EXPECTED_TIMER);
    expect(native.latest?.startedAt).toBe(STARTED_AT_MS);
  }, 20_000);
});
describe("live transcript projects into both surfaces", () => {
  test("finalized lines reach the browser stream and the native viewport", async () => {
    const browserLines = web.expect("browser:3-lines", P.transcriptLines(3));
    const nativeLines = native.expect("native:3-lines", (s) => s.lines.length === 3);
    session.line({ text: "첫 번째 문장입니다", ts: STARTED_AT_MS + 1_000 });
    session.line({ text: "두 번째 문장입니다", ts: STARTED_AT_MS + 2_000, speaker: 1 });
    session.line({ text: "세 번째 문장입니다", ts: STARTED_AT_MS + 3_000, speaker: 2 });
    await browserLines;
    await nativeLines;

    const state = await web.read();
    expect(state.transcriptTexts).toEqual([
      "첫 번째 문장입니다",
      "두 번째 문장입니다",
      "세 번째 문장입니다",
    ]);
    expect(native.latest?.lines.map((l) => l.text)).toEqual([
      "첫 번째 문장입니다",
      "두 번째 문장입니다",
      "세 번째 문장입니다",
    ]);
  }, 20_000);

  test("a provisional caption is provisional on both surfaces", async () => {
    const shown = web.expect("browser:caption", P.captionShown("네 번째 문장을 말하는 중"));
    const nativeCaption = native.expect(
      "native:caption",
      (s) => s.lines.some((line) => line.provisional && line.text === "네 번째 문장을 말하는 중"),
    );
    session.caption({ text: "네 번째 문장을 말하는 중", ts: STARTED_AT_MS + 4_000 });
    await shown;
    await nativeCaption;

    // The caption is never a finalized row on either surface.
    const state = await web.read();
    expect(state.transcriptLineCount).toBe(3);
    expect(native.latest?.lines.filter((l) => !l.provisional).length).toBe(3);
  }, 20_000);
});

describe("independent transport loss never claims capture stopped", () => {
  test("the native client alone drops: reconnecting, capture truth retained", async () => {
    const reconnecting = native.expect("native:reconnecting", (s) => s.connection === "reconnecting");
    session.disconnectClient("native");
    const dropped = await reconnecting;

    expect(dropped.status).toBe("reconnecting");
    // The last authoritative capture projection survives the dead socket.
    expect(dropped.capturePhase).toBe("capturing");
    expect(dropped.timer).toBe(EXPECTED_TIMER);
    expect(dropped.lines.length).toBeGreaterThan(0);
    // Stop cannot be sent over a socket that does not exist.
    expect(dropped.stopEnabled).toBe(false);

    // The browser surface was untouched by the other client's loss.
    const state = await web.read();
    expect(state.connection).toBe("connected");
    expect(state.capturing).toBe(true);
  }, 20_000);

  test("the native client re-enters live from the reconnect snapshot", async () => {
    const rejoined = session.waitForClient("native");
    const live = native.expect("native:relive", (s) => s.connection === "online" && s.status === "live");
    await native.connect();
    await rejoined;
    const state = await live;
    expect(state.capturePhase).toBe("capturing");
    expect(state.timer).toBe(EXPECTED_TIMER);
    // The snapshot REPLACES the viewport: three lines, never six.
    expect(state.lines.filter((l) => !l.provisional).length).toBe(3);
  }, 20_000);

  test("the browser alone drops: live content and timer retained, no phantom stop", async () => {
    const disconnected = web.expect("browser:disconnected", P.disconnected);
    session.disconnectClient("browser");
    await disconnected;

    const state = await web.read();
    expect(state.connection).toBe("disconnected");
    // Losing the socket is not evidence the meeting ended.
    expect(state.capturing).toBe(true);
    expect(state.captureTimerText).toBe(EXPECTED_TIMER);
    expect(state.transcriptLineCount).toBe(3);
    // The native surface never saw the browser's loss.
    expect(native.latest?.connection).toBe("online");
    expect(native.latest?.capturePhase).toBe("capturing");
  }, 20_000);

  test("browser reload during capture re-enters live with a deduplicated transcript", async () => {
    const rejoined = session.waitForClient("browser");
    await web.reload();
    await rejoined;
    // Hydration order is status → capture → slide → transcript snapshot.
    await web.expect("browser:relive", P.capturing);
    await web.expect("browser:relines", P.transcriptLines(3));

    const state = await web.read();
    expect(state.connection).toBe("connected");
    expect(state.capturing).toBe(true);
    expect(state.transcriptTexts).toEqual([
      "첫 번째 문장입니다",
      "두 번째 문장입니다",
      "세 번째 문장입니다",
    ]);
    expect(state.captureTimerText).toBe(EXPECTED_TIMER);
    expect(state.shell).toBe("live");
  }, 20_000);
});

describe("stale and malformed frames cannot overwrite current state", () => {
  test("a meeting payload for a meeting nobody selected is ignored", async () => {
    const before = await web.read();
    const seen = native.expect("native:stale-meeting", (s) => s.reason === "message");
    session.broadcast({
      type: "meeting",
      meetingId: 6,
      title: "제품 로드맵 검토",
      transcript: [{ text: "다른 회의의 문장", ts: 1 }],
      current: { title: "다른 슬라이드", bullets: [], index: 1 },
      history: [],
      compiled: null,
    });
    await seen;
    await web.expect("browser:still-live", P.capturing);

    const after = await web.read();
    expect(after.transcriptTexts).toEqual(before.transcriptTexts);
    expect(after.capturing).toBe(true);
    expect(native.latest?.capturePhase).toBe("capturing");
  }, 20_000);

  test("a malformed frame leaves both projections untouched", async () => {
    const before = await web.read();
    const nativeFailure = native.expect(
      "native:decode-failure",
      (s) => s.projectionDecodeFailures > 0 || s.decodeFailures > 0,
    );
    session.broadcastRaw("{ this is not json");
    await nativeFailure;

    const after = await web.read();
    expect(after.transcriptTexts).toEqual(before.transcriptTexts);
    expect(after.capturing).toBe(true);
    // The capture truth the surface already had is retained.
    expect(native.latest?.capturePhase).toBe("capturing");
    expect(native.latest?.timer).toBe(EXPECTED_TIMER);
  }, 20_000);

  test("an out-of-order compile result for a superseded job does not disturb capture", async () => {
    // `renderCompileStatus` publishes the server's own status verbatim into
    // `data-state`; the test reads that machine value, never the copy beside it.
    const started = web.expect("browser:compile-started", P.compileState("started"));
    session.broadcast({ type: "compile", status: "started", jobId: "job-2" });
    await started;

    // A terminal answer for the PREVIOUS job arrives late.
    const stale = native.expect("native:stale-job", (s) => s.reason === "message");
    session.broadcast({ type: "compile", status: "error", jobId: "job-1", error: "stale" });
    await stale;

    const state = await web.read();
    // The superseded job's failure never replaced the running job's state.
    expect(state.compileStatusState).toBe("started");
    // Compile never disables the capture surface.
    expect(state.capturing).toBe(true);
    expect(native.latest?.capturePhase).toBe("capturing");

    const done = web.expect("browser:compile-success", P.compileState("success"));
    session.broadcast({
      type: "compile",
      status: "success",
      jobId: "job-2",
      outline: { slideCount: 4 },
    });
    await done;
  }, 20_000);
});

describe("rapid Stop emits exactly one existing command", () => {
  test("the native surface sends one stopCapture under repeated activation", async () => {
    const before = session.commandsOf("stopCapture").length;
    const activated = native.expect("native:stop-1", (s) => s.reason === "stop-activated");
    native.activateStopNoWait();
    native.activateStopNoWait();
    native.activateStopNoWait();
    await activated;
    const settled = await native.snapshot("after-rapid-stop");

    expect(settled.sent.filter((frame) => frame.includes("stopCapture")).length).toBe(1);
    const commands = session.commandsOf("stopCapture").slice(before);
    expect(commands.length).toBe(1);
    expect(commands[0]?.label).toBe("native");
    expect(JSON.parse(commands[0]!.raw)).toEqual({ action: "stopCapture" });
  }, 20_000);

  test("the browser surface sends one stopCapture under a double activation", async () => {
    const before = session.commandsOf("stopCapture").length;
    const stopping = web.expect("browser:stop-pending", P.phase("stopping"));
    await web.doubleClick("#btn-record");
    await stopping;
    // Give the wire the same chance to carry a SECOND command as the first: the
    // native snapshot round-trip is an ordered barrier through the same server.
    await native.snapshot("browser-stop-barrier");

    const commands = session.commandsOf("stopCapture").slice(before);
    expect(commands.map((entry) => entry.label)).toEqual(["browser"]);
    expect(JSON.parse(commands[0]!.raw)).toEqual({ action: "stopCapture" });
  }, 20_000);
});

describe("the stop window stays truthful while trailing lines flush", () => {
  test("both surfaces report stopping, not idle, before the flush completes", async () => {
    const browserStopping = web.expect("browser:stopping", P.phase("stopping"));
    const nativeStopping = native.expect("native:stopping", (s) => s.status === "stopping");
    session.beginStop();
    await browserStopping;
    await nativeStopping;

    const state = await web.read();
    // Stop and the timer stay present through the whole stop window.
    expect(state.capturePhase).toBe("stopping");
    expect(state.captureTimerText).toBe(EXPECTED_TIMER);
    expect(state.shell).toBe("live");
    expect(native.latest?.status).toBe("stopping");
    expect(native.latest?.timer).toBe(EXPECTED_TIMER);
  }, 20_000);

  test("trailing lines emitted after the stop broadcast are kept by both surfaces", async () => {
    const browserTail = web.expect("browser:tail", P.transcriptContains("마지막 정리 문장입니다"));
    const nativeTail = native.expect(
      "native:tail",
      (s) => s.lines.some((line) => line.text === "마지막 정리 문장입니다"),
    );
    session.line({ text: "마지막 정리 문장입니다", ts: STARTED_AT_MS + 5_000 });
    await browserTail;
    await nativeTail;

    const state = await web.read();
    expect(state.transcriptLineCount).toBe(4);
    expect(native.latest?.lines.some((l) => l.text === "마지막 정리 문장입니다")).toBe(true);
  }, 20_000);
});

describe("authoritative idle restores the just-ended meeting exactly once", () => {
  test("idle ends capture on both surfaces", async () => {
    const browserIdle = web.expect("browser:idle", P.notCapturing);
    const nativeIdle = native.expect("native:idle", (s) => s.status === "idle");
    session.setMeetings([
      { id: 7, title: "주간 팀 회의", started_at: STARTED_AT_MS, status: "ended" },
      MEETINGS[1]!,
    ]);
    session.finishStop();
    await browserIdle;
    await nativeIdle;

    expect(native.latest?.capturePhase).toBe("idle");
    // The ambient surface holds no transcript between meetings.
    expect(native.latest?.lines.length).toBe(0);
  }, 20_000);

  test("the just-ended meeting is restored, and selected exactly once", async () => {
    const restored = web.expect("browser:just-ended", P.meetingSelected(7));
    // Idle already went out above; the restoration is the client's own act.
    await restored;

    const state = await web.read();
    expect(state.selectedMeetingIds).toEqual(["7"]);
    expect(state.selectedMeetingTitle).toBe("주간 팀 회의");
    // Exactly one selectMeeting for the just-ended meeting, not a loop.
    const selects = session
      .commandsOf("selectMeeting")
      .filter((entry) => (entry.parsed as { meetingId?: number }).meetingId === 7);
    expect(selects.length).toBe(1);
    expect(selects[0]?.label).toBe("browser");
  }, 20_000);

  test("the restoration does not repeat when further idle snapshots arrive", async () => {
    const before = session.commandsOf("selectMeeting").length;
    const seen = native.expect("native:idle-again", (s) => s.reason === "message");
    session.finishStop();
    await seen;
    await native.snapshot("idle-repeat-barrier");

    expect(session.commandsOf("selectMeeting").length).toBe(before);
    const state = await web.read();
    expect(state.selectedMeetingIds).toEqual(["7"]);
  }, 20_000);

  test("an idle re-asserted after reconnect cannot restore a second time", async () => {
    // The realistic repeat path: the capture ended, the surface restored the
    // meeting, then the socket dropped and the server re-asserted its state on
    // reconnect. The restoration token was consumed by the first idle, so this
    // second authoritative idle must be inert - no new selectMeeting, and the
    // operator's current selection untouched.
    const before = session.commandsOf("selectMeeting").length;

    const reconnected = session.waitForClient("browser");
    const disconnected = web.expect("browser:restore-drop", P.disconnected);
    session.disconnectClient("browser");
    await disconnected;
    await reconnected;
    await web.expect("browser:restore-reconnected", P.connected);
    // Reconnect performs one explicit authoritative refetch for the selected meeting.
    const afterReconnect = session.commandsOf("selectMeeting").length;
    expect(afterReconnect).toBe(before + 1);

    // The reconnect snapshot itself carries an authoritative idle capture frame.
    const seen = native.expect("native:post-reconnect-idle", (s) => s.reason === "message");
    session.finishStop();
    await seen;
    await native.snapshot("post-reconnect-barrier");

    expect(session.commandsOf("selectMeeting").length).toBe(afterReconnect);
  }, 20_000);

  test("a SECOND capture cycle restores its own meeting, and only its own", async () => {
    // The restoration must be scoped to the capture that just ended. A surface
    // that remembered the FIRST live meeting would re-select meeting 7 here, and
    // one that restored on any idle would fight the operator's own selection.
    const beforeSelects = session
      .commandsOf("selectMeeting")
      .filter((entry) => (entry.parsed as { meetingId?: number }).meetingId === 7).length;

    // A new meeting goes live; the server marks exactly that one `open`.
    const live = web.expect("browser:second-live", P.capturing);
    const nativeLive = native.expect("native:second-live", (s) => s.status === "live");
    session.setMeetings([
      { id: 8, title: "후속 조치 회의", started_at: STARTED_AT_MS, status: "open" },
      { id: 7, title: "주간 팀 회의", started_at: STARTED_AT_MS, status: "ended" },
    ]);
    session.startCapture();
    await live;
    await nativeLive;

    // The operator is looking at the LIBRARY meeting 7 while 8 records, so the
    // restoration has something real to override - or to leave alone.
    const idle = web.expect("browser:second-idle", P.notCapturing);
    const restored = web.expect("browser:second-restored", P.meetingSelected(8));
    session.setMeetings([
      { id: 8, title: "후속 조치 회의", started_at: STARTED_AT_MS, status: "ended" },
      { id: 7, title: "주간 팀 회의", started_at: STARTED_AT_MS, status: "ended" },
    ]);
    session.beginStop();
    session.finishStop();
    await idle;
    await restored;

    const state = await web.read();
    expect(state.selectedMeetingIds).toEqual(["8"]);
    // Meeting 7 was never re-selected by the second cycle.
    const sevens = session
      .commandsOf("selectMeeting")
      .filter((entry) => (entry.parsed as { meetingId?: number }).meetingId === 7).length;
    expect(sevens).toBe(beforeSelects);
    // Exactly one selection for the meeting that actually just ended.
    const eights = session
      .commandsOf("selectMeeting")
      .filter((entry) => (entry.parsed as { meetingId?: number }).meetingId === 8);
    expect(eights.length).toBe(1);
    expect(eights[0]?.label).toBe("browser");
  }, 20_000);
});

describe("phase-less capture frames stay compatible", () => {
  test("a phase-less capture message still drives both surfaces", async () => {
    const browserLive = web.expect("browser:phaseless-live", P.capturing);
    const nativeLive = native.expect("native:phaseless-live", (s) => s.status === "live");
    // Exactly what a server without the additive metadata sends.
    session.broadcast({
      type: "capture",
      capturing: true,
      mode: "mic",
      startedAt: STARTED_AT_MS,
    });
    await browserLive;
    await nativeLive;

    const state = await web.read();
    expect(state.capturing).toBe(true);
    expect(state.captureTimerText).toBe(EXPECTED_TIMER);
    expect(native.latest?.capturePhase).toBe("capturing");
    expect(native.latest?.timer).toBe(EXPECTED_TIMER);

    const browserIdle = web.expect("browser:phaseless-idle", P.notCapturing);
    const nativeIdle = native.expect("native:phaseless-idle", (s) => s.status === "idle");
    session.broadcast({ type: "capture", capturing: false, mode: "mic" });
    await browserIdle;
    await nativeIdle;
    expect(native.latest?.capturePhase).toBe("idle");
  }, 20_000);
});

describe("calendar auto-capture and natural recorder failure", () => {
  test("automatic capture reaches both surfaces without a client command", async () => {
    const before = session.commandsOf("startCapture").length;
    const browserLive = web.expect("browser:auto-live", P.capturing);
    const nativeLive = native.expect("native:auto-live", (s) => s.status === "live");
    // The launcher's `POST /api/auto-capture` path: the server starts capture
    // with no WebSocket command from either surface.
    session.startCapture();
    await browserLive;
    await nativeLive;

    expect(session.commandsOf("startCapture").length).toBe(before);
    expect(native.latest?.timer).toBe(EXPECTED_TIMER);
    const state = await web.read();
    expect(state.captureTimerText).toBe(EXPECTED_TIMER);
  }, 20_000);

  test("a natural recorder failure ends capture truthfully on both surfaces", async () => {
    const before = session.commandsOf("stopCapture").length;
    const browserIdle = web.expect("browser:failure-idle", P.notCapturing);
    const nativeIdle = native.expect("native:failure-idle", (s) => s.status === "idle");
    session.recorderFailed("마이크 입력이 중단되었습니다. 마이크와 권한을 확인한 뒤 다시 시작해 주세요");
    await browserIdle;
    await nativeIdle;

    // Nobody asked to stop: the surfaces followed the server, not a local guess.
    expect(session.commandsOf("stopCapture").length).toBe(before);
    expect(native.latest?.capturePhase).toBe("idle");
    const state = await web.read();
    expect(state.capturing).toBe(false);
  }, 20_000);
});
