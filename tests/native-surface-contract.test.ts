// Native surface test seam (plan caret-clone-redesign, Todo 5).
//
// Compiles the pure Swift native-surface module together with a deterministic
// fixture driver exactly once, then runs the driver exactly once with a batch of
// scenarios on stdin. Every assertion reads that single machine-readable result.
//
// No GUI session, no AppKit window creation, no SwiftPM, no sleeps/polling.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MODULE_SWIFT = join(ROOT, "macos", "NativeSurfaceContract.swift");
const DRIVER_SWIFT = join(ROOT, "tests", "fixtures", "native-surface-driver.swift");
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
let driverStdout = "";
let driverStderr = "";
let driverExit = -1;
let output: DriverOutput | null = null;
let byName = new Map<string, DriverResult>();

/**
 * Scenario batch. One process invocation covers every case so the Swift toolchain
 * is exercised once per suite run.
 */
const SCENARIOS = {
  scenarios: [
    { name: "collapsed-bounds", kind: "surfaceSize", input: { mode: "collapsed" } },
    { name: "expanded-bounds", kind: "surfaceSize", input: { mode: "expanded" } },
    {
      name: "default-frame-main-display",
      kind: "resolveFrame",
      input: {
        mode: "collapsed",
        saved: null,
        displays: [{ id: 1, x: 0, y: 0, width: 1728, height: 1117, isActive: true }],
      },
    },
    {
      name: "saved-frame-valid",
      kind: "resolveFrame",
      input: {
        mode: "collapsed",
        saved: { x: 400, y: 300, width: 360, height: 56 },
        displays: [{ id: 1, x: 0, y: 0, width: 1728, height: 1117, isActive: true }],
      },
    },
    {
      name: "saved-frame-off-display",
      kind: "resolveFrame",
      input: {
        mode: "collapsed",
        saved: { x: 5000, y: 4000, width: 360, height: 56 },
        displays: [{ id: 1, x: 0, y: 0, width: 1728, height: 1117, isActive: true }],
      },
    },
    {
      name: "saved-frame-half-off-display",
      // 49% of the 360pt width intersects the display -> below the 50% threshold.
      kind: "resolveFrame",
      input: {
        mode: "collapsed",
        saved: { x: 1728 - 176, y: 500, width: 360, height: 56 },
        displays: [{ id: 1, x: 0, y: 0, width: 1728, height: 1117, isActive: true }],
      },
    },
    {
      name: "saved-frame-clamped-into-gutter",
      kind: "resolveFrame",
      input: {
        mode: "collapsed",
        saved: { x: 1728 - 200, y: 4, width: 360, height: 56 },
        displays: [{ id: 1, x: 0, y: 0, width: 1728, height: 1117, isActive: true }],
      },
    },
    {
      name: "saved-frame-second-display",
      kind: "resolveFrame",
      input: {
        mode: "expanded",
        saved: { x: 2000, y: 200, width: 560, height: 220 },
        displays: [
          { id: 1, x: 0, y: 0, width: 1728, height: 1117, isActive: false },
          { id: 2, x: 1728, y: 0, width: 1920, height: 1080, isActive: true },
        ],
      },
    },
    {
      name: "expand-preserves-anchor",
      kind: "resolveFrame",
      input: {
        mode: "expanded",
        saved: { x: 100, y: 100, width: 360, height: 56 },
        displays: [{ id: 1, x: 0, y: 0, width: 1728, height: 1117, isActive: true }],
      },
    },
    {
      name: "impossible-display-bounds",
      kind: "resolveFrame",
      input: {
        mode: "collapsed",
        saved: null,
        displays: [{ id: 1, x: 0, y: 0, width: 0, height: 0, isActive: true }],
      },
    },
    {
      name: "no-displays",
      kind: "resolveFrame",
      input: { mode: "collapsed", saved: null, displays: [] },
    },
    {
      name: "decode-capture-capturing",
      kind: "decode",
      input: {
        payload:
          '{"type":"capture","capturing":true,"mode":"live","phase":"capturing","startedAt":1723370000000}',
      },
    },
    {
      name: "decode-capture-phaseless",
      kind: "decode",
      input: { payload: '{"type":"capture","capturing":true,"mode":"live"}' },
    },
    {
      name: "decode-capture-phaseless-idle",
      kind: "decode",
      input: { payload: '{"type":"capture","capturing":false,"mode":"live"}' },
    },
    {
      name: "decode-status",
      kind: "decode",
      input: { payload: '{"type":"status","text":"연결됨"}' },
    },
    {
      name: "decode-unknown-type",
      kind: "decode",
      input: { payload: '{"type":"meetings","items":[]}' },
    },
    {
      name: "decode-malformed-json",
      kind: "decode",
      input: { payload: '{"type":"capture","capturing":' },
    },
    {
      name: "decode-wrong-field-type",
      kind: "decode",
      input: { payload: '{"type":"capture","capturing":"yes","mode":"live"}' },
    },
    {
      name: "decode-unknown-phase",
      kind: "decode",
      input: {
        payload: '{"type":"capture","capturing":true,"mode":"live","phase":"teleporting"}',
      },
    },
    {
      name: "menu-toggle-visible-collapsed",
      kind: "presentation",
      input: { mode: "collapsed", events: ["present", "toggle", "toggle"] },
    },
    {
      name: "menu-toggle-visible-expanded",
      kind: "presentation",
      input: { mode: "expanded", events: ["present", "toggle", "toggle"] },
    },
    {
      name: "stop-once",
      kind: "stopGuard",
      input: { phase: "capturing", activations: 1 },
    },
    {
      name: "stop-duplicate-suppressed",
      kind: "stopGuard",
      input: { phase: "capturing", activations: 3 },
    },
    {
      name: "stop-while-idle",
      kind: "stopGuard",
      input: { phase: "idle", activations: 2 },
    },
    {
      name: "stop-resets-after-authoritative-idle",
      kind: "stopGuard",
      input: { phase: "capturing", activations: 2, thenIdleThenActivations: 1 },
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
  buildDir = mkdtempSync(join(tmpdir(), "native-surface-seam-"));
  const binary = join(buildDir, "native-surface-driver");

  const compiled = run([
    "swiftc",
    "-O",
    "-swift-version",
    "5",
    "-o",
    binary,
    MODULE_SWIFT,
    DRIVER_SWIFT,
  ]);
  compileExit = compiled.exitCode;
  compileLog = `${compiled.stdout}${compiled.stderr}`;

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
  // `swiftc` plus one driver run. Bun's default 5s hook bound left no headroom
  // when the three native suites compile concurrently, so the suite could fail
  // on toolchain scheduling rather than on a contract. This is an upper limit
  // on real work, not a wait: nothing here sleeps or polls.
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

describe("native surface seam: sources and compilation", () => {
  test("the pure module and fixture driver exist", () => {
    expect(existsSync(MODULE_SWIFT)).toBe(true);
    expect(existsSync(DRIVER_SWIFT)).toBe(true);
  });

  test("swiftc compiles the pure module with the fixture driver", () => {
    expect(compileLog).not.toMatch(/error:/);
    expect(compileExit).toBe(0);
  });

  test("the pure module imports no AppKit and creates no window", () => {
    const source = readFileSync(MODULE_SWIFT, "utf8");
    expect(source).not.toMatch(/^\s*import\s+(AppKit|SwiftUI|WebKit|Cocoa)\b/m);
    expect(source).not.toMatch(/NSPanel|NSWindow|NSStatusItem|NSApplication/);
  });

  test("the driver runs once, exits 0 and emits machine-readable JSON", () => {
    expect(driverStderr).toBe("");
    expect(driverExit).toBe(0);
    expect(output).not.toBeNull();
    expect(output?.driver).toBe("native-surface-driver");
  });
});

describe("native surface seam: minibar geometry", () => {
  test("collapsed bounds are exactly 360x56", () => {
    expect(value("collapsed-bounds")).toEqual({ width: 360, height: 56 });
  });

  test("expanded bounds are exactly 560x220", () => {
    expect(value("expanded-bounds")).toEqual({ width: 560, height: 220 });
  });

  test("with no saved frame the default sits inside the 16px active-display gutter", () => {
    const frame = value("default-frame-main-display") as {
      x: number;
      y: number;
      width: number;
      height: number;
      displayId: number;
      usedSavedFrame: boolean;
    };
    expect(frame.width).toBe(360);
    expect(frame.height).toBe(56);
    expect(frame.displayId).toBe(1);
    expect(frame.usedSavedFrame).toBe(false);
    expect(frame.x + frame.width).toBe(1728 - 16);
    expect(frame.y + frame.height).toBe(1117 - 16);
  });

  test("a fully on-display saved frame is restored verbatim", () => {
    expect(value("saved-frame-valid")).toEqual({
      x: 400,
      y: 300,
      width: 360,
      height: 56,
      displayId: 1,
      usedSavedFrame: true,
    });
  });

  test("a saved frame entirely off-display falls back to the deterministic default", () => {
    expect(value("saved-frame-off-display")).toEqual(value("default-frame-main-display"));
  });

  test("a saved frame with less than 50% display intersection returns the default frame", () => {
    const half = value("saved-frame-half-off-display");
    expect(half.usedSavedFrame).toBe(false);
    expect(half).toEqual(value("default-frame-main-display"));
  });

  test("a mostly-visible saved frame is clamped into the 16px gutters, not discarded", () => {
    const frame = value("saved-frame-clamped-into-gutter") as {
      x: number;
      y: number;
      width: number;
      height: number;
      usedSavedFrame: boolean;
    };
    expect(frame.usedSavedFrame).toBe(true);
    expect(frame.x + frame.width).toBe(1728 - 16);
    expect(frame.y).toBe(16);
    expect(frame.width).toBe(360);
    expect(frame.height).toBe(56);
  });

  test("a saved frame on a secondary display stays on that display", () => {
    const frame = value("saved-frame-second-display") as {
      x: number;
      displayId: number;
      width: number;
      height: number;
    };
    expect(frame.displayId).toBe(2);
    expect(frame.x).toBeGreaterThanOrEqual(1728 + 16);
    expect(frame.width).toBe(560);
    expect(frame.height).toBe(220);
  });

  test("expanding keeps the surface on the saved display with expanded bounds", () => {
    const frame = value("expand-preserves-anchor") as {
      width: number;
      height: number;
      x: number;
      y: number;
    };
    expect(frame.width).toBe(560);
    expect(frame.height).toBe(220);
    expect(frame.x).toBeGreaterThanOrEqual(16);
    expect(frame.y).toBeGreaterThanOrEqual(16);
  });

  test("impossible display bounds yield a typed failure instead of a crash", () => {
    const impossible = result("impossible-display-bounds");
    expect(impossible.ok).toBe(false);
    expect(impossible.error?.kind).toBe("invalidDisplayBounds");
  });

  test("an empty display list yields a typed failure instead of a crash", () => {
    const none = result("no-displays");
    expect(none.ok).toBe(false);
    expect(none.error?.kind).toBe("noActiveDisplay");
  });
});

describe("native surface seam: menu-bar presentation", () => {
  for (const mode of ["collapsed", "expanded"] as const) {
    test(`first toggle hides and second toggle restores without changing ${mode} mode`, () => {
      expect(value(`menu-toggle-visible-${mode}`)).toEqual({
        effects: ["show", "hide", "show"],
        states: ["visible", "hidden", "visible"],
        mode,
      });
    });
  }

  test("the shipping controller owns presentation state instead of querying NSWindow visibility", () => {
    const controller = readFileSync(join(ROOT, "macos", "MinibarWindowController.swift"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(controller).toMatch(/MinibarPresentationState/);
    expect(controller).toMatch(/\.handle\(\.toggle\)/);
    expect(controller).toMatch(/panel\.orderOut\(/);
    expect(controller).not.toMatch(/panel\.isVisible|window\.isVisible/);
  });
});

describe("native surface seam: server payload decode subset", () => {
  test("a capture update decodes phase, mode and startedAt", () => {
    expect(value("decode-capture-capturing")).toEqual({
      event: "capture",
      capturing: true,
      mode: "live",
      phase: "capturing",
      startedAt: 1723370000000,
    });
  });

  test("a phase-less capturing update maps compatibly to capturing", () => {
    const decoded = value("decode-capture-phaseless") as { phase: string; startedAt: unknown };
    expect(decoded.phase).toBe("capturing");
    expect(decoded.startedAt).toBeNull();
  });

  test("a phase-less idle update maps compatibly to idle", () => {
    expect((value("decode-capture-phaseless-idle") as { phase: string }).phase).toBe("idle");
  });

  test("a status update decodes as transport status", () => {
    expect(value("decode-status")).toEqual({ event: "status", text: "연결됨" });
  });

  test("a message outside the observed subset is ignored, not an error", () => {
    expect(value("decode-unknown-type")).toEqual({ event: "ignored", type: "meetings" });
  });

  test("malformed JSON yields a typed failure without crashing", () => {
    const bad = result("decode-malformed-json");
    expect(bad.ok).toBe(false);
    expect(bad.error?.kind).toBe("malformedPayload");
  });

  test("a wrongly typed field yields a typed failure without crashing", () => {
    const bad = result("decode-wrong-field-type");
    expect(bad.ok).toBe(false);
    expect(bad.error?.kind).toBe("malformedPayload");
  });

  test("an unknown capture phase yields a typed failure without crashing", () => {
    const bad = result("decode-unknown-phase");
    expect(bad.ok).toBe(false);
    expect(bad.error?.kind).toBe("unknownPhase");
  });
});

describe("native surface seam: one-command guards", () => {
  test("a single Stop activation while capturing emits one stopCapture", () => {
    expect(value("stop-once")).toEqual({ emitted: 1, actions: ["stopCapture"] });
  });

  test("rapid duplicate Stop activations emit exactly one stopCapture", () => {
    expect(value("stop-duplicate-suppressed")).toEqual({ emitted: 1, actions: ["stopCapture"] });
  });

  test("Stop while idle emits nothing", () => {
    expect(value("stop-while-idle")).toEqual({ emitted: 0, actions: [] });
  });

  test("the guard rearms only after an authoritative idle snapshot", () => {
    expect(value("stop-resets-after-authoritative-idle")).toEqual({
      emitted: 1,
      actions: ["stopCapture"],
    });
  });
});

describe("native surface seam: launcher and build invariants", () => {
  const launcher = () => readFileSync(LAUNCHER_SWIFT, "utf8");
  const build = () => readFileSync(BUILD_SCRIPT, "utf8");

  test("the launcher keeps the browser workspace and never imports WebKit", () => {
    const source = launcher();
    expect(source).not.toMatch(/^\s*import\s+WebKit\b/m);
    expect(source).not.toMatch(/WKWebView\s*\(/);
    expect(source).toMatch(/NSWorkspace\.shared\.open/);
  });

  test("the launcher keeps its port, readiness and auto-capture contract", () => {
    // Todo 10 moved the port/readiness/launch rules into the pure lifecycle
    // module; the invariants are unchanged, only their home is. The launcher
    // entry point still owns EventKit auto-capture.
    const source = launcher();
    const lifecycle = readFileSync(join(ROOT, "macos", "AppLifecycle.swift"), "utf8");
    expect(source).toMatch(/api\/auto-capture/);
    expect(lifecycle).toMatch(/HTTP_PORT/);
    expect(lifecycle).toMatch(/defaultHTTPPort = 8787/);
    expect(lifecycle).toMatch(/runtime-bootstrap/);
    expect(lifecycle).toMatch(/OPEN_BROWSER/);
  });

  test("the build script compiles the launcher and rejects WebKit linkage", () => {
    const source = build();
    expect(source).toMatch(/swiftc -O -o "\$MACOS_DIR\/meeting-slides"/);
    expect(source).toMatch(/macos\/launcher\.swift/);
    expect(source).toMatch(/codesign --verify --deep --strict/);
    expect(source).toMatch(/build still links WebKit/);
    expect(source).toMatch(/CFBundleIdentifier<\/key><string>com\.meetingslides\.app/);
  });

  test("the pure module is packaged through the minibar, never through a second engine", () => {
    // Todo 14 wires the minibar, so the contract module now ships. What must
    // stay true is that it ships as part of the one native executable: no
    // WKWebView, no second binary, no separate helper process.
    const source = build();
    expect(source).toMatch(/macos\/NativeSurfaceContract\.swift/);
    // One swiftc invocation, one executable: no second binary or helper engine.
    expect(source.match(/swiftc -O -o/g) ?? []).toHaveLength(1);
    // WebKit appears only in the rejection guard, never as a linked framework.
    expect(source).not.toMatch(/-framework\s+WebKit/);
  });
});
