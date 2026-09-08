// Native macOS minibar projection seam (plan caret-clone-redesign, Todo 14).
//
// Compiles the pure Swift minibar projection together with the Todo 5/10 pure
// modules and a deterministic fixture driver exactly once, runs the driver
// exactly once with a scenario batch on stdin, and asserts on that single
// machine-readable result.
//
// The driver is headless: no AppKit, no NSApplication, no window creation, no
// socket, no clock, no sleeps or polling. Time is injected as a value so timer
// text is deterministic. The AppKit shell (`macos/MinibarWindowController.swift`,
// `macos/MinibarView.swift`) is asserted structurally only: it must stay a thin
// projection host with no decisions of its own.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CONTRACT_SWIFT = join(ROOT, "macos", "NativeSurfaceContract.swift");
const LIFECYCLE_SWIFT = join(ROOT, "macos", "AppLifecycle.swift");
const TRANSPORT_SWIFT = join(ROOT, "macos", "TransportClient.swift");
const PROJECTION_SWIFT = join(ROOT, "macos", "MinibarProjection.swift");
const CONTROLLER_SWIFT = join(ROOT, "macos", "MinibarWindowController.swift");
const VIEW_SWIFT = join(ROOT, "macos", "MinibarView.swift");
const DRIVER_SWIFT = join(ROOT, "tests", "fixtures", "native-minibar-driver.swift");
const LAUNCHER_SWIFT = join(ROOT, "macos", "launcher.swift");
const BUILD_SCRIPT = join(ROOT, "scripts", "build-app.sh");

interface DriverResult {
  name: string;
  ok: boolean;
  value?: unknown;
  error?: { kind: string; detail: string };
}

interface DriverOutput {
  driver: string;
  results: DriverResult[];
}

let buildDir = "";
let compileLog = "";
let compileExit = -1;
let shellTypecheckLog = "";
let shellTypecheckExit = -1;
let driverStdout = "";
let driverStderr = "";
let driverExit = -1;
let output: DriverOutput | null = null;
let byName = new Map<string, DriverResult>();

const CAPTURING =
  '{"type":"capture","capturing":true,"mode":"live","phase":"capturing","startedAt":1723370000000}';
const STARTING =
  '{"type":"capture","capturing":true,"mode":"live","phase":"starting","startedAt":1723370000000}';
const STOPPING =
  '{"type":"capture","capturing":true,"mode":"live","phase":"stopping","startedAt":1723370000000}';
const SWITCHING =
  '{"type":"capture","capturing":true,"mode":"live","phase":"switching-model","startedAt":1723370000000}';
const IDLE = '{"type":"capture","capturing":false,"mode":"live","phase":"idle"}';

const line = (text: string, ts: number, speaker?: number) =>
  JSON.stringify(speaker === undefined ? { type: "line", text, ts } : { type: "line", text, ts, speaker });
const caption = (text: string, ts: number) => JSON.stringify({ type: "caption", text, ts });

/**
 * One batch covers every scenario so the Swift toolchain runs once per suite.
 * `now` is epoch milliseconds injected into the projection: no native stopwatch.
 */
const SCENARIOS = {
  scenarios: [
    // ── geometry the AppKit shell must obey ──
    { name: "collapsed-size", kind: "surfaceSize", input: { mode: "collapsed" } },
    { name: "expanded-size", kind: "surfaceSize", input: { mode: "expanded" } },
    { name: "expanded-layout", kind: "expandedLayout", input: {} },

    // ── launcher quit protection: authoritative capture phase only ──
    ...(["idle", "starting", "capturing", "stopping", "switching-model"] as const).map((phase) => ({
      name: `quit-protection-${phase}`,
      kind: "quitProtection",
      input: { phase },
    })),

    // ── status projection: explicit, never inferred from text ──
    {
      name: "status-idle",
      kind: "view",
      input: { mode: "collapsed", events: [{ kind: "open" }, { kind: "message", payload: IDLE }], now: 1723370000000 },
    },
    {
      name: "status-starting",
      kind: "view",
      input: {
        mode: "collapsed",
        events: [{ kind: "open" }, { kind: "message", payload: STARTING }],
        now: 1723370002000,
      },
    },
    {
      name: "status-live",
      kind: "view",
      input: {
        mode: "collapsed",
        events: [{ kind: "open" }, { kind: "message", payload: CAPTURING }],
        now: 1723370065000,
      },
    },
    {
      name: "collapsed-live-render-contract",
      kind: "renderContract",
      input: {
        mode: "collapsed",
        events: [
          { kind: "open" },
          { kind: "message", payload: CAPTURING },
          { kind: "message", payload: caption("현재 논의를 기록하고 있습니다", 1723370064000) },
        ],
        now: 1723370065000,
      },
    },
    {
      name: "status-stopping",
      kind: "view",
      input: {
        mode: "collapsed",
        events: [{ kind: "open" }, { kind: "message", payload: STOPPING }],
        now: 1723370065000,
      },
    },
    {
      name: "status-switching-model",
      kind: "view",
      input: {
        mode: "collapsed",
        events: [{ kind: "open" }, { kind: "message", payload: SWITCHING }],
        now: 1723370065000,
      },
    },
    {
      name: "status-reconnecting-retains-capture-truth",
      kind: "view",
      input: {
        mode: "collapsed",
        events: [
          { kind: "open" },
          { kind: "message", payload: CAPTURING },
          { kind: "message", payload: line("첫 번째 확정 문장", 1723370010000, 1) },
          { kind: "close" },
        ],
        now: 1723370065000,
      },
    },
    {
      name: "status-error-from-decode-failure",
      kind: "view",
      input: {
        mode: "collapsed",
        events: [
          { kind: "open" },
          { kind: "message", payload: CAPTURING },
          { kind: "message", payload: '{"type":"capture","capturing":' },
        ],
        now: 1723370065000,
      },
    },
    {
      name: "status-connecting-before-any-snapshot",
      kind: "view",
      input: { mode: "collapsed", events: [], now: 1723370000000 },
    },

    // ── timer is derived from server startedAt only ──
    {
      name: "timer-from-server-started-at",
      kind: "view",
      input: {
        mode: "collapsed",
        events: [{ kind: "open" }, { kind: "message", payload: CAPTURING }],
        now: 1723370000000 + 3 * 3600_000 + 25 * 60_000 + 7000,
      },
    },
    {
      name: "timer-never-negative-on-clock-skew",
      kind: "view",
      input: {
        mode: "collapsed",
        events: [{ kind: "open" }, { kind: "message", payload: CAPTURING }],
        now: 1723370000000 - 60_000,
      },
    },
    {
      name: "timer-absent-without-started-at",
      kind: "view",
      input: {
        mode: "collapsed",
        events: [
          { kind: "open" },
          { kind: "message", payload: '{"type":"capture","capturing":true,"mode":"live"}' },
        ],
        now: 1723370065000,
      },
    },
    {
      name: "timer-frozen-while-reconnecting",
      kind: "view",
      input: {
        mode: "collapsed",
        events: [{ kind: "open" }, { kind: "message", payload: CAPTURING }, { kind: "close" }],
        now: 1723370065000,
      },
    },

    // ── transcript projection: bounded, never a store ──
    {
      name: "collapsed-shows-one-latest-line",
      kind: "view",
      input: {
        mode: "collapsed",
        events: [
          { kind: "open" },
          { kind: "message", payload: CAPTURING },
          { kind: "message", payload: line("문장 하나", 1723370010000) },
          { kind: "message", payload: line("문장 둘", 1723370011000) },
          { kind: "message", payload: line("문장 셋", 1723370012000) },
          { kind: "message", payload: line("문장 넷", 1723370013000) },
        ],
        now: 1723370065000,
      },
    },
    {
      name: "collapsed-prefers-provisional-caption",
      kind: "view",
      input: {
        mode: "collapsed",
        events: [
          { kind: "open" },
          { kind: "message", payload: CAPTURING },
          { kind: "message", payload: line("확정된 문장", 1723370010000) },
          { kind: "message", payload: caption("말하는 중", 1723370011000) },
        ],
        now: 1723370065000,
      },
    },
    {
      name: "expanded-shows-at-most-three-finals-plus-provisional",
      kind: "view",
      input: {
        mode: "expanded",
        events: [
          { kind: "open" },
          { kind: "message", payload: CAPTURING },
          { kind: "message", payload: line("문장 하나", 1723370010000, 1) },
          { kind: "message", payload: line("문장 둘", 1723370011000, 2) },
          { kind: "message", payload: line("문장 셋", 1723370012000, 1) },
          { kind: "message", payload: line("문장 넷", 1723370013000, 2) },
          { kind: "message", payload: line("문장 다섯", 1723370014000, 1) },
          { kind: "message", payload: caption("말하는 중", 1723370015000) },
        ],
        now: 1723370065000,
      },
    },
    {
      name: "caption-is-replaced-by-its-finalized-line",
      kind: "view",
      input: {
        mode: "expanded",
        events: [
          { kind: "open" },
          { kind: "message", payload: CAPTURING },
          { kind: "message", payload: caption("말하는 중", 1723370011000) },
          { kind: "message", payload: line("말하는 중입니다", 1723370011000) },
        ],
        now: 1723370065000,
      },
    },
    {
      name: "idle-clears-provisional-and-keeps-no-history",
      kind: "view",
      input: {
        mode: "expanded",
        events: [
          { kind: "open" },
          { kind: "message", payload: CAPTURING },
          { kind: "message", payload: line("문장 하나", 1723370010000) },
          { kind: "message", payload: caption("말하는 중", 1723370011000) },
          { kind: "message", payload: IDLE },
        ],
        now: 1723370065000,
      },
    },
    {
      name: "malformed-line-payload-retains-last-known-lines",
      kind: "view",
      input: {
        mode: "expanded",
        events: [
          { kind: "open" },
          { kind: "message", payload: CAPTURING },
          { kind: "message", payload: line("문장 하나", 1723370010000) },
          { kind: "message", payload: '{"type":"line","text":42,"ts":"soon"}' },
          { kind: "message", payload: "not json at all" },
        ],
        now: 1723370065000,
      },
    },
    {
      name: "reconnect-snapshot-replaces-lines-without-duplicates",
      kind: "view",
      input: {
        mode: "expanded",
        events: [
          { kind: "open" },
          { kind: "message", payload: CAPTURING },
          { kind: "message", payload: line("문장 하나", 1723370010000) },
          { kind: "message", payload: line("문장 둘", 1723370011000) },
          { kind: "close" },
          { kind: "open" },
          {
            kind: "message",
            payload: JSON.stringify({
              type: "transcript",
              reason: "snapshot",
              entries: [
                { text: "문장 하나", ts: 1723370010000 },
                { text: "문장 둘", ts: 1723370011000 },
                { text: "문장 셋", ts: 1723370012000 },
              ],
            }),
          },
          { kind: "message", payload: CAPTURING },
        ],
        now: 1723370065000,
      },
    },

    // ── controls: truthful, no fake capability ──
    {
      name: "controls-live",
      kind: "controls",
      input: { mode: "collapsed", events: [{ kind: "open" }, { kind: "message", payload: CAPTURING }] },
    },
    {
      name: "controls-idle",
      kind: "controls",
      input: { mode: "collapsed", events: [{ kind: "open" }, { kind: "message", payload: IDLE }] },
    },
    {
      name: "controls-expanded",
      kind: "controls",
      input: { mode: "expanded", events: [{ kind: "open" }, { kind: "message", payload: CAPTURING }] },
    },
    {
      name: "controls-reconnecting",
      kind: "controls",
      input: {
        mode: "collapsed",
        events: [{ kind: "open" }, { kind: "message", payload: CAPTURING }, { kind: "close" }],
      },
    },
    { name: "controls-vocabulary-is-closed", kind: "controlVocabulary", input: {} },

    // ── Stop: exactly one existing command across spam and reconnect ──
    {
      name: "stop-spam-emits-one-command",
      kind: "commands",
      input: {
        events: [
          { kind: "open" },
          { kind: "message", payload: CAPTURING },
          { kind: "stop" },
          { kind: "stop" },
          { kind: "stop" },
          { kind: "stop" },
          { kind: "stop" },
        ],
      },
    },
    {
      name: "stop-across-reconnect-emits-one-command",
      kind: "commands",
      input: {
        events: [
          { kind: "open" },
          { kind: "message", payload: CAPTURING },
          { kind: "stop" },
          { kind: "close" },
          { kind: "stop" },
          { kind: "open" },
          { kind: "message", payload: STOPPING },
          { kind: "stop" },
          { kind: "stop" },
        ],
      },
    },
    {
      name: "stop-while-idle-emits-nothing",
      kind: "commands",
      input: {
        events: [{ kind: "open" }, { kind: "message", payload: IDLE }, { kind: "stop" }, { kind: "stop" }],
      },
    },

    // ── activation policy: automatic capture never steals focus ──
    {
      name: "activation-user-started-capture",
      kind: "activation",
      input: { origin: "user", phase: "capturing" },
    },
    {
      name: "activation-automatic-capture",
      kind: "activation",
      input: { origin: "automatic", phase: "capturing" },
    },
    {
      name: "activation-automatic-then-user-stop",
      kind: "activation",
      input: { origin: "automatic", phase: "capturing", thenUserInteraction: true },
    },

    // ── mode and Escape ──
    { name: "mode-escape-collapses-expanded", kind: "mode", input: { mode: "expanded", event: "escape" } },
    { name: "mode-escape-collapsed-is-noop", kind: "mode", input: { mode: "collapsed", event: "escape" } },
    { name: "mode-toggle-expands", kind: "mode", input: { mode: "collapsed", event: "toggle" } },
    { name: "mode-toggle-collapses", kind: "mode", input: { mode: "expanded", event: "toggle" } },

    // ── window policy ──
    { name: "window-policy", kind: "windowPolicy", input: {} },

    // ── frame restoration through the shared geometry rules ──
    {
      name: "frame-default-when-nothing-saved",
      kind: "resolveFrame",
      input: {
        mode: "collapsed",
        saved: null,
        displays: [{ id: 1, x: 0, y: 0, width: 1728, height: 1117, isActive: true }],
      },
    },
    {
      name: "frame-off-display-falls-back-deterministically",
      kind: "resolveFrame",
      input: {
        mode: "collapsed",
        saved: { x: 9000, y: 9000, width: 360, height: 56 },
        displays: [{ id: 1, x: 0, y: 0, width: 1728, height: 1117, isActive: true }],
      },
    },
    {
      name: "frame-expand-keeps-saved-anchor-inside-gutters",
      kind: "resolveFrame",
      input: {
        mode: "expanded",
        saved: { x: 1300, y: 1000, width: 360, height: 56 },
        displays: [{ id: 1, x: 0, y: 0, width: 1728, height: 1117, isActive: true }],
      },
    },

    // ── accessibility payload ──
    {
      name: "accessibility-live",
      kind: "accessibility",
      input: {
        mode: "collapsed",
        events: [
          { kind: "open" },
          { kind: "message", payload: CAPTURING },
          { kind: "message", payload: line("확정된 문장", 1723370010000) },
        ],
        now: 1723370065000,
      },
    },
    {
      name: "accessibility-reduced-motion",
      kind: "motion",
      input: { reduceMotion: true },
    },
    { name: "accessibility-normal-motion", kind: "motion", input: { reduceMotion: false } },

    // ── Todo 15: announcement discipline ──
    //
    // The AppKit shell re-renders on every projection change, including every
    // one-second timer tick. If the surface republishes its status label on
    // each render, VoiceOver speaks "녹음 중" once per second forever. The
    // decision of WHETHER to announce therefore belongs in the pure layer, next
    // to the state it is about, and is asserted here as a value.
    //
    // This scenario walks one real session and reports, for each step, the
    // status and whether that step should announce.
    {
      name: "announce-sequence",
      kind: "announcements",
      input: {
        mode: "collapsed",
        steps: [
          // Before anything: the surface is connecting; the first resolved
          // state is worth one announcement.
          { events: [{ kind: "open" }], now: 1723370060000 },
          // Same status, later clock: a timer tick must NOT announce.
          { events: [{ kind: "message", payload: CAPTURING }], now: 1723370061000 },
          { events: [], now: 1723370062000 },
          { events: [], now: 1723370063000 },
          // A new finalized line changes the content but not the status: the
          // status region must stay quiet (the transcript is not a live region).
          {
            events: [{ kind: "message", payload: line("확정된 문장", 1723370064000) }],
            now: 1723370064000,
          },
          // A real status change announces exactly once.
          { events: [{ kind: "message", payload: STOPPING }], now: 1723370065000 },
          { events: [], now: 1723370066000 },
          // Transport loss is a status change, and it announces.
          { events: [{ kind: "close" }], now: 1723370067000 },
          { events: [], now: 1723370068000 },
        ],
      },
    },

    // A malformed payload must produce an ACTIONABLE error the surface can
    // speak, not a silent state flip. The reason is a machine value, so the
    // shell never has to invent copy for a failure it did not diagnose.
    {
      name: "announce-error-reason",
      kind: "announcements",
      input: {
        mode: "collapsed",
        steps: [
          { events: [{ kind: "open" }, { kind: "message", payload: CAPTURING }], now: 1723370060000 },
          { events: [{ kind: "message", payload: "{ not json" }], now: 1723370061000 },
          // Repeating the same failure must not announce a second time.
          { events: [{ kind: "message", payload: "{ not json" }], now: 1723370062000 },
          // Recovery is itself a status change and announces once.
          { events: [{ kind: "message", payload: CAPTURING }], now: 1723370063000 },
        ],
      },
    },

    // Every control the surface paints must carry a name AND a help string that
    // states its current truth, so a disabled Stop explains itself instead of
    // being an unexplained dead target.
    {
      name: "control-accessibility-live",
      kind: "controlAccessibility",
      input: {
        mode: "expanded",
        events: [{ kind: "open" }, { kind: "message", payload: CAPTURING }],
        now: 1723370065000,
      },
    },
    {
      name: "control-accessibility-idle",
      kind: "controlAccessibility",
      input: {
        mode: "expanded",
        events: [{ kind: "open" }, { kind: "message", payload: IDLE }],
        now: 1723370065000,
      },
    },
  ],
};

function run(cmd: string[], opts: { stdin?: string; cwd?: string } = {}) {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd ?? ROOT,
    stdin: opts.stdin === undefined ? undefined : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout ?? new Uint8Array()),
    stderr: new TextDecoder().decode(proc.stderr ?? new Uint8Array()),
  };
}

beforeAll(() => {
  buildDir = mkdtempSync(join(tmpdir(), "native-minibar-seam-"));
  const binary = join(buildDir, "native-minibar-driver");

  const compiled = run([
    "swiftc",
    "-O",
    "-swift-version",
    "5",
    "-o",
    binary,
    CONTRACT_SWIFT,
    LIFECYCLE_SWIFT,
    TRANSPORT_SWIFT,
    PROJECTION_SWIFT,
    DRIVER_SWIFT,
  ]);
  compileExit = compiled.exitCode;
  compileLog = `${compiled.stdout}${compiled.stderr}`;

  // The AppKit shell is not linked into the headless driver; it is typechecked
  // separately so a GUI-free process still proves it compiles.
  const shell = run([
    "swiftc",
    "-typecheck",
    "-swift-version",
    "5",
    CONTRACT_SWIFT,
    LIFECYCLE_SWIFT,
    TRANSPORT_SWIFT,
    PROJECTION_SWIFT,
    CONTROLLER_SWIFT,
    VIEW_SWIFT,
    join(ROOT, "macos", "SystemAudioCapture.swift"),
    LAUNCHER_SWIFT,
  ]);
  shellTypecheckExit = shell.exitCode;
  shellTypecheckLog = `${shell.stdout}${shell.stderr}`;

  if (compileExit !== 0) return;

  const ran = run([binary], { stdin: JSON.stringify(SCENARIOS) });
  driverExit = ran.exitCode;
  driverStdout = ran.stdout;
  driverStderr = ran.stderr;

  try {
    output = JSON.parse(driverStdout) as DriverOutput;
    byName = new Map(output.results.map((r) => [r.name, r]));
  } catch {
    output = null;
  }
  // Two `swiftc` invocations (an -O build and a typecheck) plus one driver run.
  // Bun's default 5s hook bound left no headroom over that on a warm cache and
  // none at all when the three native suites compile concurrently, so the suite
  // could fail on toolchain scheduling rather than on a contract. This bound is
  // an upper limit on real work, not a wait: nothing here sleeps or polls, and
  // a genuine hang still fails.
}, 120_000);

afterAll(() => {
  // Temporary binaries never survive the suite.
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
});

function result(name: string): DriverResult {
  const found = byName.get(name);
  if (!found) throw new Error(`driver produced no result for scenario "${name}"`);
  return found;
}

function value(name: string): Record<string, unknown> {
  const found = result(name);
  if (!found.ok) throw new Error(`scenario "${name}" failed: ${JSON.stringify(found.error)}`);
  return found.value as Record<string, unknown>;
}

function sourceOf(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

describe("native minibar seam: sources and compilation", () => {
  test("the projection module, AppKit shell and fixture driver exist", () => {
    expect(existsSync(PROJECTION_SWIFT)).toBe(true);
    expect(existsSync(CONTROLLER_SWIFT)).toBe(true);
    expect(existsSync(VIEW_SWIFT)).toBe(true);
    expect(existsSync(DRIVER_SWIFT)).toBe(true);
  });

  test("swiftc compiles the pure modules with the fixture driver", () => {
    expect(compileLog).not.toMatch(/error:/);
    expect(compileExit).toBe(0);
  });

  test("swiftc typechecks the AppKit shell against the pure modules", () => {
    expect(shellTypecheckLog).not.toMatch(/error:/);
    expect(shellTypecheckExit).toBe(0);
  });

  test("the driver runs once, exits 0 and emits machine-readable JSON", () => {
    expect(driverStderr).toBe("");
    expect(driverExit).toBe(0);
    expect(output).not.toBeNull();
    expect(output?.driver).toBe("native-minibar-driver");
  });

  test("the projection module stays pure: no AppKit, window, socket or clock", () => {
    const source = sourceOf(PROJECTION_SWIFT);
    expect(source).not.toMatch(/^\s*import\s+(AppKit|SwiftUI|WebKit|Cocoa|EventKit|AVFoundation)\b/m);
    expect(source).not.toMatch(/NSPanel|NSWindow|NSStatusItem|NSApplication|NSWorkspace|NSView/);
    expect(source).not.toMatch(/\bProcess\s*\(|URLSession|Thread\.sleep|DispatchSemaphore/);
    expect(source).not.toMatch(/Date\s*\(\s*\)|CFAbsoluteTimeGetCurrent|DispatchTime\.now/);
  });

  test("the AppKit shell imports no WebKit and hosts no second engine", () => {
    for (const path of [CONTROLLER_SWIFT, VIEW_SWIFT]) {
      const source = sourceOf(path);
      expect(source).not.toMatch(/WebKit|WKWebView|Electron|Tauri/);
      expect(source).not.toMatch(/\bProcess\s*\(/);
      // No native stopwatch: elapsed time always comes from the projection.
      expect(source).not.toMatch(/startedAtLocal|localStopwatch/);
    }
  });

  test("initial and reconnect WebSockets send the server-allowed native Origin", () => {
    const controller = sourceOf(CONTROLLER_SWIFT);
    expect(controller).toMatch(/URLRequest\(url:\s*endpoint\)/);
    expect(controller).toMatch(
      /setValue\(\s*TransportEndpoint\.webSocketOrigin\(port:\s*port\),\s*forHTTPHeaderField:\s*"Origin"\s*\)/,
    );
    expect(controller.match(/webSocketTask\(with:\s*(?:self\.)?webSocketRequest\)/g)).toHaveLength(2);
    expect(controller).not.toMatch(/webSocketTask\(with:\s*endpoint\)/);
  });

  test("the native surface becomes online only after a successful receive", () => {
    const controller = sourceOf(CONTROLLER_SWIFT);
    expect(controller.match(/transport\.handle\(\.opened\)/g)).toHaveLength(1);
    expect(controller).toMatch(
      /case let \.success\(message\):\s*if self\.transport\.projection\.connection != \.online/,
    );
    expect(controller).not.toMatch(
      /task\.resume\(\)\s*receiveNext\(\)\s*apply\(transport\.handle\(\.opened\)\)/,
    );
    expect(controller).toMatch(/private var isStopping = false/);
    expect(controller).toMatch(/guard !self\.isStopping else \{ return \}/);
  });

  test("the panel frame is authoritative so content cannot grow past the contract size", () => {
    // Real QA caught a 360x88 collapsed panel: Auto Layout content had grown the
    // window past the 360x56 contract. The frame now pins the content box.
    const controller = sourceOf(CONTROLLER_SWIFT);
    expect(controller).toMatch(/contentMinSize\s*=\s*target\.size/);
    expect(controller).toMatch(/contentMaxSize/);
    // Collapsed keeps its single line inside the one 56pt row rather than
    // stacking a second row the panel has no height for.
    const view = sourceOf(VIEW_SWIFT);
    expect(view).toMatch(/collapsedLine/);
    expect(view).toMatch(/transcriptStack\.isHidden\s*=\s*true/);
    expect(view).toMatch(/transcriptStack\.isHidden\s*=\s*false/);
    expect(view).toMatch(/MinibarLayout\.expanded/);
  });

  test("a long reconnect title cannot grow the collapsed panel beyond 360pt", () => {
    const view = sourceOf(VIEW_SWIFT);
    expect(view).toMatch(/statusTitle\.lineBreakMode\s*=\s*\.byTruncatingTail/);
    expect(view).toMatch(/statusTitle\.maximumNumberOfLines\s*=\s*1/);
    expect(view).toMatch(
      /statusTitle\.setContentCompressionResistancePriority\(\.defaultLow,\s*for:\s*\.horizontal\)/,
    );
  });

  test("the AppKit shell stays thin: geometry and status come from the pure modules", () => {
    const controller = sourceOf(CONTROLLER_SWIFT);
    expect(controller).toMatch(/NativeSurfaceGeometry\.resolveFrame/);
    // No hardcoded second copy of the contract geometry.
    expect(controller).not.toMatch(/\b360\b[\s\S]{0,40}\b56\b/);
    expect(controller).not.toMatch(/\b560\b[\s\S]{0,40}\b220\b/);
  });

  test("no native source advertises Pause, share or screen-share exclusion", () => {
    for (const path of [PROJECTION_SWIFT, CONTROLLER_SWIFT, VIEW_SWIFT, LAUNCHER_SWIFT]) {
      const source = sourceOf(path);
      expect(source).not.toMatch(/pauseCapture|"Pause"|일시정지/);
      expect(source).not.toMatch(/sharingType|SharingType\.none/);
    }
  });

  test("the bundle build compiles the minibar sources into the app executable", () => {
    const script = readFileSync(BUILD_SCRIPT, "utf8");
    expect(script).toMatch(/macos\/MinibarProjection\.swift/);
    expect(script).toMatch(/macos\/MinibarWindowController\.swift/);
    expect(script).toMatch(/macos\/MinibarView\.swift/);
    expect(script).toMatch(/macos\/NativeSurfaceContract\.swift/);
    expect(script).toMatch(/macos\/TransportClient\.swift/);
    // WebKit rejection stays in the build.
    expect(script).toMatch(/WebKit/);
  });
});

describe("native minibar seam: geometry", () => {
  test("collapsed is exactly 360x56 and expanded exactly 560x220", () => {
    expect(value("collapsed-size")).toEqual({ width: 360, height: 56 });
    expect(value("expanded-size")).toEqual({ width: 560, height: 220 });
  });

  test("expanded uses balanced status and transcript columns inside bounded content", () => {
    const layout = value("expanded-layout") as unknown as Record<
      string,
      { x: number; y: number; width: number; height: number } | number
    >;
    const surface = layout.surface as { x: number; y: number; width: number; height: number };
    const content = layout.content as typeof surface;
    const status = layout.status as typeof surface;
    const transcript = layout.transcript as typeof surface;
    const actions = layout.actions as typeof surface;
    const columnGap = layout.columnGap as number;
    const rowGap = layout.rowGap as number;

    expect(surface).toEqual({ x: 0, y: 0, width: 560, height: 220 });
    expect(content).toEqual({ x: 12, y: 12, width: 536, height: 196 });
    expect(status.x).toBe(content.x);
    expect(status.y).toBe(content.y);
    expect(status.height).toBe(content.height);
    expect(status.width).toBeGreaterThanOrEqual(176);
    expect(transcript.x).toBe(status.x + status.width + columnGap);
    expect(transcript.y).toBe(content.y);
    expect(transcript.width).toBeGreaterThanOrEqual(320);
    expect(actions.x).toBe(transcript.x);
    expect(actions.width).toBe(transcript.width);
    expect(actions.y).toBe(transcript.y + transcript.height + rowGap);
    expect(actions.y + actions.height).toBe(content.y + content.height);
    expect(transcript.x + transcript.width).toBe(content.x + content.width);
  });

  test("the deterministic default frame honours the 16px gutter on the active display", () => {
    expect(value("frame-default-when-nothing-saved")).toEqual({
      x: 1728 - 16 - 360,
      y: 1117 - 16 - 56,
      width: 360,
      height: 56,
      displayId: 1,
      usedSavedFrame: false,
    });
  });

  test("a saved frame that no longer intersects a display falls back deterministically", () => {
    expect(value("frame-off-display-falls-back-deterministically")).toEqual({
      x: 1728 - 16 - 360,
      y: 1117 - 16 - 56,
      width: 360,
      height: 56,
      displayId: 1,
      usedSavedFrame: false,
    });
  });

  test("expanding a restored frame keeps the anchor and clamps into the gutter", () => {
    expect(value("frame-expand-keeps-saved-anchor-inside-gutters")).toEqual({
      x: 1728 - 16 - 560,
      y: 1117 - 16 - 220,
      width: 560,
      height: 220,
      displayId: 1,
      usedSavedFrame: true,
    });
  });
});

describe("native minibar seam: launcher quit protection", () => {
  const expected = [
    ["idle", false],
    ["starting", true],
    ["capturing", true],
    ["stopping", true],
    ["switching-model", true],
  ] as const;

  for (const [phase, protectedFromQuit] of expected) {
    test(`${phase} quit protection is ${protectedFromQuit}`, () => {
      expect(value(`quit-protection-${phase}`)).toEqual({
        phase,
        protected: protectedFromQuit,
      });
    });
  }

  test("the AppKit controller delegates quit protection to the pure phase seam", () => {
    const controller = sourceOf(CONTROLLER_SWIFT);
    expect(controller).toMatch(/transport\.projection\.capture\.phase\.requiresQuitProtection/);
  });
});

describe("native minibar seam: explicit status projection", () => {
  test("idle, starting, live, stopping and switching-model are distinct explicit states", () => {
    expect(value("status-idle").status).toBe("idle");
    expect(value("status-starting").status).toBe("starting");
    expect(value("status-live").status).toBe("live");
    expect(value("status-stopping").status).toBe("stopping");
    expect(value("status-switching-model").status).toBe("switching-model");
  });

  test("collapsed live projection paints server semantics and enables Stop", () => {
    expect(value("collapsed-live-render-contract")).toEqual({
      status: "live",
      title: "녹음 중",
      timer: "01:05",
      line: { text: "현재 논의를 기록하고 있습니다", speaker: null, provisional: true },
      stopEnabled: true,
      stopLabel: "녹음 중지",
      stopHelp: "진행 중인 녹음을 중지합니다",
      accessibilityStatus: "녹음 중",
    });
  });

  test("before any snapshot the surface says connecting rather than idle", () => {
    expect(value("status-connecting-before-any-snapshot").status).toBe("connecting");
  });

  test("a lost socket becomes reconnecting while the known capture truth is retained", () => {
    const view = value("status-reconnecting-retains-capture-truth");
    expect(view.status).toBe("reconnecting");
    expect(view.capturePhase).toBe("capturing");
    expect(view.lines).toEqual([{ text: "첫 번째 확정 문장", speaker: 1, provisional: false }]);
  });

  test("a malformed payload surfaces error without discarding the known capture phase", () => {
    const view = value("status-error-from-decode-failure");
    expect(view.status).toBe("error");
    expect(view.capturePhase).toBe("capturing");
    expect(view.errorReason).toBe("malformedPayload");
  });

  test("every status carries a non-color glyph and a distinct title", () => {
    const names = [
      "status-idle",
      "status-starting",
      "status-live",
      "status-stopping",
      "status-switching-model",
      "status-reconnecting-retains-capture-truth",
      "status-error-from-decode-failure",
      "status-connecting-before-any-snapshot",
    ];
    const glyphs = new Set<string>();
    const titles = new Set<string>();
    for (const name of names) {
      const view = value(name);
      expect(typeof view.glyph).toBe("string");
      expect((view.glyph as string).length).toBeGreaterThan(0);
      expect(typeof view.title).toBe("string");
      expect((view.title as string).length).toBeGreaterThan(0);
      glyphs.add(view.glyph as string);
      titles.add(view.title as string);
    }
    // Status is never conveyed by color alone: each state has its own glyph+title pair.
    expect(titles.size).toBe(names.length);
    expect(glyphs.size).toBeGreaterThanOrEqual(4);
  });
});

describe("native minibar seam: timer derives from server startedAt", () => {
  test("elapsed time is computed from the server timestamp and the injected clock", () => {
    expect(value("timer-from-server-started-at").timer).toBe("3:25:07");
    expect(value("status-live").timer).toBe("01:05");
  });

  test("a clock skew never renders a negative timer", () => {
    expect(value("timer-never-negative-on-clock-skew").timer).toBe("00:00");
  });

  test("a capture without startedAt shows no invented timer", () => {
    expect(value("timer-absent-without-started-at").timer).toBeNull();
  });

  test("reconnecting keeps the last known timer basis rather than resetting it", () => {
    expect(value("timer-frozen-while-reconnecting").timer).toBe("01:05");
  });
});

describe("native minibar seam: bounded transcript projection", () => {
  test("collapsed shows exactly one line: the latest finalized sentence", () => {
    expect(value("collapsed-shows-one-latest-line").lines).toEqual([
      { text: "문장 넷", speaker: null, provisional: false },
    ]);
  });

  test("collapsed prefers the provisional caption when one is live", () => {
    expect(value("collapsed-prefers-provisional-caption").lines).toEqual([
      { text: "말하는 중", speaker: null, provisional: true },
    ]);
  });

  test("expanded shows at most three finalized lines plus one provisional row", () => {
    expect(value("expanded-shows-at-most-three-finals-plus-provisional").lines).toEqual([
      { text: "문장 셋", speaker: 1, provisional: false },
      { text: "문장 넷", speaker: 2, provisional: false },
      { text: "문장 다섯", speaker: 1, provisional: false },
      { text: "말하는 중", speaker: null, provisional: true },
    ]);
  });

  test("a finalized line replaces its provisional caption instead of duplicating it", () => {
    expect(value("caption-is-replaced-by-its-finalized-line").lines).toEqual([
      { text: "말하는 중입니다", speaker: null, provisional: false },
    ]);
  });

  test("an authoritative idle snapshot clears the surface instead of keeping meeting content", () => {
    expect(value("idle-clears-provisional-and-keeps-no-history").lines).toEqual([]);
  });

  test("a malformed transcript payload retains the last known lines", () => {
    const view = value("malformed-line-payload-retains-last-known-lines");
    expect(view.lines).toEqual([{ text: "문장 하나", speaker: null, provisional: false }]);
    // Both rejections are counted by the surface that observes them: the badly
    // typed `line` (outside the transport subset) and the non-JSON payload.
    expect(view.decodeFailures).toBe(2);
    expect(view.transportDecodeFailures).toBe(1);
    expect(view.status).toBe("error");
    expect(view.errorReason).toBe("malformedPayload");
  });

  test("a reconnect snapshot replaces the projected lines without duplicating them", () => {
    expect(value("reconnect-snapshot-replaces-lines-without-duplicates").lines).toEqual([
      { text: "문장 하나", speaker: null, provisional: false },
      { text: "문장 둘", speaker: null, provisional: false },
      { text: "문장 셋", speaker: null, provisional: false },
    ]);
  });
});

describe("native minibar seam: truthful controls", () => {
  test("collapsed exposes a persistent Stop plus a disclosure and nothing else", () => {
    expect(value("controls-live")).toEqual({
      controls: [
        { id: "stop", enabled: true, label: "녹음 중지", role: "button" },
        { id: "disclosure", enabled: true, label: "미니바 펼치기", role: "button" },
        { id: "close", enabled: true, label: "닫기", role: "button" },
      ],
    });
  });

  test("Stop stays visible and truthfully disabled when there is nothing to stop", () => {
    expect(value("controls-idle")).toEqual({
      controls: [
        { id: "stop", enabled: false, label: "녹음 중지", role: "button" },
        { id: "disclosure", enabled: true, label: "미니바 펼치기", role: "button" },
        { id: "close", enabled: true, label: "닫기", role: "button" },
      ],
    });
  });

  test("expanded adds Open Workspace and keeps the same Stop control", () => {
    expect(value("controls-expanded")).toEqual({
      controls: [
        { id: "stop", enabled: true, label: "녹음 중지", role: "button" },
        { id: "disclosure", enabled: true, label: "미니바 접기", role: "button" },
        { id: "openWorkspace", enabled: true, label: "작업 공간 열기", role: "button" },
        { id: "close", enabled: true, label: "닫기", role: "button" },
      ],
    });
  });

  test("Stop stays reachable while reconnecting but refuses to lie about being sent", () => {
    const controls = value("controls-reconnecting").controls as Array<Record<string, unknown>>;
    const stop = controls.find((c) => c.id === "stop");
    expect(stop).toBeDefined();
    expect(stop?.enabled).toBe(false);
  });

  test("the control vocabulary is closed: no Pause, no share, no second engine", () => {
    expect(value("controls-vocabulary-is-closed")).toEqual({
      controls: ["stop", "disclosure", "openWorkspace", "close"],
      outboundActions: ["stopCapture"],
    });
  });
});

describe("native minibar seam: Stop emits exactly one existing command", () => {
  test("five rapid Stop activations emit exactly one stopCapture", () => {
    expect(value("stop-spam-emits-one-command")).toEqual({
      sent: ['{"action":"stopCapture"}'],
      count: 1,
    });
  });

  test("Stop spam across a reconnect still emits exactly one stopCapture", () => {
    expect(value("stop-across-reconnect-emits-one-command")).toEqual({
      sent: ['{"action":"stopCapture"}'],
      count: 1,
    });
  });

  test("Stop while idle emits nothing at all", () => {
    expect(value("stop-while-idle-emits-nothing")).toEqual({ sent: [], count: 0 });
  });
});

describe("native minibar seam: activation policy", () => {
  test("user-started capture shows the surface and focuses the visible Stop", () => {
    expect(value("activation-user-started-capture")).toEqual({
      showsSurface: true,
      activatesApp: true,
      focusesStop: true,
    });
  });

  test("automatic calendar capture shows the surface without stealing OS focus", () => {
    expect(value("activation-automatic-capture")).toEqual({
      showsSurface: true,
      activatesApp: false,
      focusesStop: false,
    });
  });

  test("a later user interaction on an automatic capture may take focus", () => {
    expect(value("activation-automatic-then-user-stop")).toEqual({
      showsSurface: true,
      activatesApp: true,
      focusesStop: true,
    });
  });
});

describe("native minibar seam: mode and Escape", () => {
  test("Escape collapses an expanded panel and never stops a recording", () => {
    expect(value("mode-escape-collapses-expanded")).toEqual({ mode: "collapsed", emitted: [] });
  });

  test("Escape on a collapsed panel is a no-op", () => {
    expect(value("mode-escape-collapsed-is-noop")).toEqual({ mode: "collapsed", emitted: [] });
  });

  test("the disclosure toggles between the two contract sizes", () => {
    expect(value("mode-toggle-expands")).toEqual({ mode: "expanded", emitted: [] });
    expect(value("mode-toggle-collapses")).toEqual({ mode: "collapsed", emitted: [] });
  });
});

describe("native minibar seam: window policy", () => {
  test("the panel is a borderless floating non-activating ambient surface", () => {
    expect(value("window-policy")).toEqual({
      borderless: true,
      floating: true,
      nonActivating: true,
      hidesOnDeactivate: false,
      resizableWhenExpanded: true,
      resizableWhenCollapsed: false,
      dragThreshold: 4,
      joinsAllSpaces: true,
      dockIdentityChanged: false,
    });
  });

  test("the shipping view uses a readable layered native HUD material, never an opaque utility fill", () => {
    const view = readFileSync(VIEW_SWIFT, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const controller = readFileSync(CONTROLLER_SWIFT, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    expect(view).toMatch(/final class MinibarView: NSVisualEffectView/);
    expect(view).toMatch(/material\s*=\s*\.hudWindow/);
    expect(view).toMatch(/blendingMode\s*=\s*\.behindWindow/);
    expect(view).toMatch(/state\s*=\s*\.active/);
    expect(view).toMatch(/NSAppearance\(named:\s*\.vibrantDark\)/);
    expect(view).toMatch(/layer\?\.cornerRadius\s*=\s*16/);
    expect(view).toMatch(/layer\?\.borderWidth\s*=\s*1/);
    expect(view).toMatch(/transcriptStack\.layer\?\.backgroundColor/);
    expect(view).not.toMatch(/windowBackgroundColor|dirtyRect\.fill\(\)/);

    expect(controller).toMatch(/panel\.isOpaque\s*=\s*false/);
    expect(controller).toMatch(/panel\.backgroundColor\s*=\s*\.clear/);
    expect(controller).toMatch(/panel\.hasShadow\s*=\s*true/);
  });

  test("the minibar controls use one restrained monochrome palette", () => {
    const view = readFileSync(VIEW_SWIFT, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    expect(view).toMatch(/isBordered\s*=\s*false/);
    expect(view).toMatch(/layer\?\.backgroundColor/);
    expect(view).toMatch(/layer\?\.borderColor/);
    expect(view).toMatch(/final class MinibarButton: NSButton/);
    expect(view).toMatch(/focusRingType\s*=\s*\.none/);
    expect(view).toMatch(/override func becomeFirstResponder\(\) -> Bool/);
    expect(view).toMatch(/layer\?\.cornerRadius\s*=\s*10/);
    expect(view).not.toMatch(
      /\.system(?:Red|Blue|Green|Orange|Pink|Purple|Yellow|Indigo|Teal|Mint|Cyan)\b/,
    );
  });
});

describe("native minibar seam: accessibility", () => {
  test("the surface publishes a labelled group, status text and target sizes", () => {
    const ax = value("accessibility-live");
    expect(ax.role).toBe("group");
    expect(ax.label).toBe("Meeting Slides 미니바");
    // Status is spoken, not only drawn.
    expect(ax.statusAnnouncement).toBe("녹음 중");
    expect(ax.timerIsLiveRegion).toBe(false);
    expect(ax.transcriptIsLiveRegion).toBe(false);
    expect(ax.minimumTargetSize).toEqual({ width: 44, height: 44 });
    expect(ax.focusOrder).toEqual(["stop", "disclosure", "close"]);
  });

  test("reduced motion removes the transition entirely rather than shortening it", () => {
    expect(value("accessibility-reduced-motion")).toEqual({ durationSeconds: 0, animates: false });
    expect(value("accessibility-normal-motion")).toEqual({ durationSeconds: 0.2, animates: true });
  });
});

describe("native minibar seam: announcement discipline (Todo 15)", () => {
  interface AnnounceStep {
    status: string;
    announcement: string;
    announces: boolean;
    errorReason: string | null;
  }

  test("a status announces once and never repeats on a timer tick", () => {
    // `value()` is typed for the object-shaped scenarios; these two return an
    // ordered list, so the cast goes through `unknown` rather than pretending
    // the record type and the array type overlap.
    const steps = value("announce-sequence") as unknown as AnnounceStep[];
    expect(steps.length).toBe(9);

    // Step 0: the first resolved state is worth one announcement.
    expect(steps[0].announces).toBe(true);
    // Step 1: capturing is a new status, so it announces.
    expect(steps[1]).toMatchObject({ status: "live", announces: true });
    // Steps 2-3: the clock moved, the status did not. Silence.
    expect(steps[2]).toMatchObject({ status: "live", announces: false });
    expect(steps[3]).toMatchObject({ status: "live", announces: false });
    // Step 4: a finalized transcript line is not a status change.
    expect(steps[4]).toMatchObject({ status: "live", announces: false });
    // Step 5: a real status change announces exactly once...
    expect(steps[5]).toMatchObject({ status: "stopping", announces: true });
    // ...and step 6 does not repeat it.
    expect(steps[6]).toMatchObject({ status: "stopping", announces: false });
    // Step 7: transport loss is a status change the operator must hear.
    expect(steps[7]).toMatchObject({ status: "reconnecting", announces: true });
    expect(steps[8]).toMatchObject({ status: "reconnecting", announces: false });

    // Every announcing step carries readable text, never an empty string.
    for (const step of steps.filter((s) => s.announces)) {
      expect(step.announcement.length).toBeGreaterThan(0);
    }
  });

  test("an error announces its machine reason once, and recovery announces once", () => {
    const steps = value("announce-error-reason") as unknown as AnnounceStep[];
    expect(steps.length).toBe(4);

    expect(steps[0]).toMatchObject({ status: "live", announces: true, errorReason: null });
    // The failure is actionable: it surfaces WITH its machine reason.
    expect(steps[1].status).toBe("error");
    expect(steps[1].announces).toBe(true);
    expect(steps[1].errorReason).not.toBeNull();
    expect(steps[1].announcement).toContain(steps[1].errorReason!);
    // The same failure repeated is not a second event.
    expect(steps[2]).toMatchObject({ status: "error", announces: false });
    // Recovery is a status change and announces once.
    expect(steps[3]).toMatchObject({ status: "live", announces: true, errorReason: null });
  });

  test("every painted control carries a name, a value and a truthful help string", () => {
    interface ControlAX {
      id: string;
      label: string;
      help: string;
      enabled: boolean;
      minimumTargetSize: { width: number; height: number };
    }
    for (const name of ["control-accessibility-live", "control-accessibility-idle"]) {
      const controls = value(name) as unknown as ControlAX[];
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        expect(control.label.length).toBeGreaterThan(0);
        // A disabled control must say WHY it cannot act; an enabled one must
        // still describe what it will do. Either way the help is never empty.
        expect({ id: control.id, help: control.help.length > 0 })
          .toEqual({ id: control.id, help: true });
        expect(control.minimumTargetSize).toEqual({ width: 44, height: 44 });
      }
    }
    // Idle has nothing to stop, so Stop is present, disabled and explains it.
    const idle = value("control-accessibility-idle") as unknown as ControlAX[];
    const stop = idle.find((c) => c.id === "stop");
    expect(stop).toBeDefined();
    expect(stop!.enabled).toBe(false);
    expect(stop!.help.length).toBeGreaterThan(0);
  });
});
