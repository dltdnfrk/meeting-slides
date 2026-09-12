// Native launcher lifecycle / transport boundary seam (plan caret-clone-redesign, Todo 10).
//
// Compiles the pure Swift lifecycle + transport modules together with a
// deterministic fixture driver exactly once, runs the driver exactly once with a
// scenario batch on stdin, and asserts on that single machine-readable result.
//
// The driver is headless: no AppKit, no NSApplication, no real process spawn, no
// socket, no clock, no sleeps or polling. Process/launch/transport decisions are
// modeled as pure values so every state transition is deterministic.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CONTRACT_SWIFT = join(ROOT, "macos", "NativeSurfaceContract.swift");
const LIFECYCLE_SWIFT = join(ROOT, "macos", "AppLifecycle.swift");
const TRANSPORT_SWIFT = join(ROOT, "macos", "TransportClient.swift");
const DRIVER_SWIFT = join(ROOT, "tests", "fixtures", "native-launcher-driver.swift");
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
const evidenceDir = process.env.NATIVE_LAUNCHER_EVIDENCE_DIR;
let compileLog = "";
let compileExit = -1;
let driverStdout = "";
let driverStderr = "";
let driverExit = -1;
let output: DriverOutput | null = null;
let byName = new Map<string, DriverResult>();

const HEALTHY_BODY =
  "<!doctype html><html><head><title>Meeting Slides</title></head>" +
  '<body><script src="/runtime-bootstrap.js"></script></body></html>';

/**
 * One batch covers every scenario so the Swift toolchain runs once per suite.
 */
const SCENARIOS = {
  scenarios: [
    { name: "automation-token-arguments", kind: "automationTokenArguments", input: {} },
    ...[
      ["configured", '" fixture-token "'],
      ["empty", '""'],
      ["whitespace", '"  \\n "'],
      ["malformed", 'not-json'],
    ].map(([name, tokenJSON]) => ({
      name: `automation-${name}`,
      kind: "automationRequest",
      input: { port: 9123, tokenJSON },
    })),
    // ── project + port resolution ──
    {
      name: "port-from-env-file",
      kind: "port",
      input: { env: "# comment\nHTTP_PORT=9123\nOTHER=1\n" },
    },
    { name: "port-missing-key", kind: "port", input: { env: "OTHER=1\n" } },
    { name: "port-out-of-range", kind: "port", input: { env: "HTTP_PORT=99999\n" } },
    { name: "port-not-a-number", kind: "port", input: { env: "HTTP_PORT=abc\n" } },
    { name: "port-no-env-file", kind: "port", input: { env: null } },
    { name: "bun-candidates", kind: "bunCandidates", input: { home: "/Users/tester" } },
    { name: "log-path", kind: "logPath", input: { home: "/Users/tester" } },

    // ── launch plan (single source of truth: one Bun session) ──
    {
      name: "launch-plan-healthy",
      kind: "launchPlan",
      input: { port: 8787, projectDir: "/tmp/project", bunPath: "/opt/homebrew/bin/bun" },
    },
    {
      name: "launch-plan-missing-bun",
      kind: "launchPlan",
      input: { port: 8787, projectDir: "/tmp/project", bunPath: null },
    },

    // ── startup decisions ──
    {
      name: "startup-fresh-server",
      kind: "startup",
      input: { probe: { reachable: false } },
    },
    {
      name: "startup-already-running-bun",
      kind: "startup",
      input: { canonicalProjectPath: "/checkout", probe: { reachable: true, status: 200, body: HEALTHY_BODY, identity: "/checkout" } },
    },
    {
      name: "startup-foreign-identical-html", kind: "startup",
      input: { canonicalProjectPath: "/checkout", probe: { reachable: true, status: 200, body: HEALTHY_BODY, identity: "/other-checkout" } },
    },
    {
      name: "startup-foreign-server-on-port",
      kind: "startup",
      input: { probe: { reachable: true, status: 200, body: "<html><title>nginx</title></html>" } },
    },

    // ── health signature ──
    {
      name: "health-ok",
      kind: "health",
      input: { probe: { reachable: true, status: 200, body: HEALTHY_BODY } },
    },
    {
      name: "health-bad-status",
      kind: "health",
      input: { probe: { reachable: true, status: 500, body: HEALTHY_BODY } },
    },
    {
      name: "health-wrong-body",
      kind: "health",
      input: { probe: { reachable: true, status: 200, body: "<html><title>nginx</title></html>" } },
    },
    { name: "health-unreachable", kind: "health", input: { probe: { reachable: false } } },

    // ── readiness attempt sequences (deterministic, attempt-indexed; no sleeps) ──
    {
      name: "readiness-succeeds-after-boot",
      kind: "readiness",
      input: {
        attempts: [
          { reachable: false },
          { reachable: true, status: 200, body: "<html>booting</html>" },
          { reachable: true, status: 200, body: HEALTHY_BODY },
        ],
      },
    },
    {
      name: "readiness-exhausted",
      kind: "readiness",
      input: {
        attempts: [{ reachable: false }, { reachable: false }],
      },
    },

    // ── lifecycle: exit / shutdown ──
    { name: "shutdown-clean-exit", kind: "lifecycle", input: { events: ["serverExited:0"] } },
    {
      name: "shutdown-on-quit-terminates-owned-server",
      kind: "lifecycle",
      input: { events: ["quit"] },
    },
    {
      name: "shutdown-not-owned-server-untouched",
      kind: "lifecycle",
      input: { adopted: true, events: ["quit"] },
    },
    {
      name: "shutdown-repeated-interrupts-terminate-once",
      kind: "lifecycle",
      input: { events: ["interrupt", "interrupt", "quit"] },
    },
    {
      name: "shutdown-server-crash-exit-code",
      kind: "lifecycle",
      input: { events: ["serverExited:2"] },
    },
    {
      name: "shutdown-readiness-failure-terminates-server",
      kind: "lifecycle",
      input: { events: ["readinessFailed"] },
    },

    // ── transport: connection state machine ──
    {
      name: "transport-url",
      kind: "transportURL",
      input: { port: 8787 },
    },
    {
      name: "transport-connects-and-hydrates",
      kind: "transport",
      input: {
        events: [
          { kind: "open" },
          {
            kind: "message",
            payload:
              '{"type":"capture","capturing":true,"mode":"live","phase":"capturing","startedAt":1723370000000}',
          },
        ],
      },
    },
    {
      name: "transport-reconnects-retaining-last-state",
      kind: "transport",
      input: {
        events: [
          { kind: "open" },
          {
            kind: "message",
            payload:
              '{"type":"capture","capturing":true,"mode":"live","phase":"capturing","startedAt":1723370000000}',
          },
          { kind: "close" },
        ],
      },
    },
    {
      name: "transport-authoritative-snapshot-restores-online",
      kind: "transport",
      input: {
        events: [
          { kind: "open" },
          {
            kind: "message",
            payload:
              '{"type":"capture","capturing":true,"mode":"live","phase":"capturing","startedAt":1723370000000}',
          },
          { kind: "close" },
          { kind: "open" },
          {
            kind: "message",
            payload: '{"type":"capture","capturing":false,"mode":"live","phase":"idle"}',
          },
        ],
      },
    },
    {
      name: "transport-malformed-payload-retains-state",
      kind: "transport",
      input: {
        events: [
          { kind: "open" },
          {
            kind: "message",
            payload:
              '{"type":"capture","capturing":true,"mode":"live","phase":"capturing","startedAt":1723370000000}',
          },
          { kind: "message", payload: '{"type":"capture","capturing":' },
        ],
      },
    },
    {
      name: "transport-unknown-phase-is-typed-failure",
      kind: "transport",
      input: {
        events: [
          { kind: "open" },
          {
            kind: "message",
            payload: '{"type":"capture","capturing":true,"mode":"live","phase":"teleporting"}',
          },
        ],
      },
    },
    {
      name: "transport-ignores-unobserved-messages",
      kind: "transport",
      input: {
        events: [
          { kind: "open" },
          { kind: "message", payload: '{"type":"meetings","items":[]}' },
        ],
      },
    },
    {
      name: "transport-status-message-is-transport-status",
      kind: "transport",
      input: {
        events: [
          { kind: "open" },
          { kind: "message", payload: '{"type":"status","text":"연결됨"}' },
        ],
      },
    },
    {
      name: "transport-backoff-is-bounded-and-monotonic",
      kind: "backoff",
      input: { failures: 8 },
    },

    // ── transport: outbound command emission ──
    {
      name: "commands-stop-once-under-rapid-activation",
      kind: "commands",
      input: {
        events: [
          { kind: "open" },
          {
            kind: "message",
            payload: '{"type":"capture","capturing":true,"mode":"live","phase":"capturing"}',
          },
          { kind: "stop" },
          { kind: "stop" },
          { kind: "stop" },
        ],
      },
    },
    {
      name: "commands-stop-suppressed-while-offline",
      kind: "commands",
      input: {
        events: [
          { kind: "open" },
          {
            kind: "message",
            payload: '{"type":"capture","capturing":true,"mode":"live","phase":"capturing"}',
          },
          { kind: "close" },
          { kind: "stop" },
        ],
      },
    },
    {
      name: "commands-stop-rearms-after-authoritative-capture",
      kind: "commands",
      input: {
        events: [
          { kind: "open" },
          {
            kind: "message",
            payload: '{"type":"capture","capturing":true,"mode":"live","phase":"capturing"}',
          },
          { kind: "stop" },
          {
            kind: "message",
            payload: '{"type":"capture","capturing":false,"mode":"live","phase":"idle"}',
          },
          {
            kind: "message",
            payload: '{"type":"capture","capturing":true,"mode":"live","phase":"capturing"}',
          },
          { kind: "stop" },
        ],
      },
    },
    {
      name: "commands-use-existing-protocol-spellings",
      kind: "commandEncoding",
      input: {},
    },
  ],
};

function run(cmd: string[], opts: { stdin?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd ?? ROOT,
    env: opts.env,
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
  buildDir = mkdtempSync(join(evidenceDir ?? tmpdir(), "native-launcher-seam-"));
  const binary = join(buildDir, "native-launcher-driver");

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
    DRIVER_SWIFT,
  ]);
  compileExit = compiled.exitCode;
  compileLog = `${compiled.stdout}${compiled.stderr}`;

  if (compileExit !== 0) return;

  const ran = run([binary], { stdin: JSON.stringify(SCENARIOS) });
  driverExit = ran.exitCode;
  driverStdout = ran.stdout;
  driverStderr = ran.stderr;
  if (evidenceDir) {
    writeFileSync(join(buildDir, "driver-output.json"), driverStdout);
    writeFileSync(join(buildDir, "compile.log"), compileLog);
  }

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
  if (buildDir && !evidenceDir) rmSync(buildDir, { recursive: true, force: true });
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

describe("native launcher seam: sources and compilation", () => {
  test("the lifecycle module, transport module and fixture driver exist", () => {
    expect(existsSync(LIFECYCLE_SWIFT)).toBe(true);
    expect(existsSync(TRANSPORT_SWIFT)).toBe(true);
    expect(existsSync(DRIVER_SWIFT)).toBe(true);
  });

  test("swiftc compiles the pure modules with the fixture driver", () => {
    expect(compileLog).not.toMatch(/error:/);
    expect(compileExit).toBe(0);
  });

  test("the pure modules stay free of AppKit, EventKit and window/process APIs", () => {
    for (const path of [LIFECYCLE_SWIFT, TRANSPORT_SWIFT]) {
      // Comments describe the boundary; only executable lines are constrained.
      const source = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      expect(source).not.toMatch(/^\s*import\s+(AppKit|SwiftUI|WebKit|Cocoa|EventKit|AVFoundation)\b/m);
      expect(source).not.toMatch(/NSPanel|NSWindow|NSStatusItem|NSApplication|NSWorkspace/);
      expect(source).not.toMatch(/\bProcess\s*\(|URLSession|Thread\.sleep|DispatchSemaphore/);
    }
  });

  test("the driver runs once, exits 0 and emits machine-readable JSON", () => {
    expect(driverStderr).toBe("");
    expect(driverExit).toBe(0);
    expect(output).not.toBeNull();
    expect(output?.driver).toBe("native-launcher-driver");
  });
});

describe("native launcher seam: project and port resolution", () => {
  test("HTTP_PORT in .env wins", () => {
    expect(value("port-from-env-file")).toEqual({ port: 9123 });
  });

  test("a missing key, out-of-range value, unparsable value or missing file falls back to 8787", () => {
    expect(value("port-missing-key")).toEqual({ port: 8787 });
    expect(value("port-out-of-range")).toEqual({ port: 8787 });
    expect(value("port-not-a-number")).toEqual({ port: 8787 });
    expect(value("port-no-env-file")).toEqual({ port: 8787 });
  });

  test("the bun lookup order is preserved", () => {
    expect(value("bun-candidates")).toEqual({
      paths: ["/Users/tester/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"],
    });
  });

  test("the launcher log stays at the documented user log path", () => {
    expect(value("log-path")).toEqual({
      path: "/Users/tester/Library/Logs/Meeting Slides/launcher.log",
    });
  });
});

describe("native launcher seam: Bun launch plan", () => {
  test("the launch plan reproduces the existing bun invocation and environment", () => {
    expect(value("launch-plan-healthy")).toEqual({
      executable: "/opt/homebrew/bin/bun",
      arguments: ["run", "server.ts"],
      workingDirectory: "/tmp/project",
      environment: { OPEN_BROWSER: "false", HTTP_PORT: "8787" },
      browserURL: "http://localhost:8787/",
    });
  });

  test("a missing bun binary is a typed failure, not a crash", () => {
    const missing = result("launch-plan-missing-bun");
    expect(missing.ok).toBe(false);
    expect(missing.error?.kind).toBe("bunNotFound");
  });
});

describe("native calendar automation request", () => {
  test.each([
    { name: "quoted base dotenv", files: { ".env": 'MEETING_SLIDES_AUTOMATION_TOKEN=" base-token "\n' }, inherited: {}, expected: "base-token" },
    { name: "dotenv expansion", files: { ".env": 'PREFIX=expanded\nMEETING_SLIDES_AUTOMATION_TOKEN=$PREFIX-token\n' }, inherited: {}, expected: "expanded-token" },
    { name: "production and local precedence", files: { ".env": 'MEETING_SLIDES_AUTOMATION_TOKEN=base\n', ".env.production": 'MEETING_SLIDES_AUTOMATION_TOKEN=production\n', ".env.local": 'MEETING_SLIDES_AUTOMATION_TOKEN=local-token\n' }, inherited: {}, expected: "local-token" },
    { name: "inherited override", files: { ".env": 'MEETING_SLIDES_AUTOMATION_TOKEN=base\n', ".env.local": 'MEETING_SLIDES_AUTOMATION_TOKEN=local\n' }, inherited: { MEETING_SLIDES_AUTOMATION_TOKEN: "inherited-token" }, expected: "inherited-token" },
    { name: "missing token", files: {}, inherited: {}, expected: "" },
    { name: "explicit empty inherited override", files: { ".env": 'MEETING_SLIDES_AUTOMATION_TOKEN=base\n' }, inherited: { MEETING_SLIDES_AUTOMATION_TOKEN: "" }, expected: "" },
  ])("Bun-loaded $name reaches the real Swift URLRequest", ({ files, inherited, expected }) => {
    // Given: isolated dotenv files, no inherited user secrets, and production argv.
    const cwd = mkdtempSync(join(buildDir, "dotenv-"));
    for (const [name, text] of Object.entries(files)) {
      if (text !== undefined) writeFileSync(join(cwd, name), text);
    }
    const args = result("automation-token-arguments").value;
    if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) {
      throw new Error("Swift driver did not emit token loader arguments");
    }
    // When: the real Bun dotenv loader feeds its JSON directly into the Swift builder.
    const loaded = run([process.execPath, ...args], {
      cwd,
      env: { NODE_ENV: "production", OPEN_BROWSER: "false", HTTP_PORT: "9123", ...inherited },
    });
    expect(loaded.exitCode).toBe(0);
    expect(loaded.stderr).toBe("");
    expect(JSON.parse(loaded.stdout)).toBe(expected);
    const built = run([join(buildDir, "native-launcher-driver")], {
      stdin: JSON.stringify({ scenarios: [{ name: "loaded", kind: "automationRequest", input: { port: 9123, tokenJSON: loaded.stdout } }] }),
    });
    // Then: inspect the actual Foundation request, not source spelling.
    expect(built.exitCode).toBe(0);
    expect(built.stderr).toBe("");
    expect(JSON.parse(built.stdout).results[0]).toMatchObject({
      ok: true,
      value: expected ? { enabled: true, authorization: `Bearer ${expected}`, contentType: "application/json", body: {} } : { enabled: false },
    });
  });

  test("configured token produces an authenticated JSON POST to the configured port", () => {
    expect(value("automation-configured")).toEqual({
      enabled: true,
      url: "http://127.0.0.1:9123/api/auto-capture",
      method: "POST",
      authorization: "Bearer fixture-token",
      contentType: "application/json",
      origin: null,
      body: {},
    });
  });

  test("empty and whitespace tokens disable automation without creating a request", () => {
    expect(value("automation-empty")).toEqual({ enabled: false });
    expect(value("automation-whitespace")).toEqual({ enabled: false });
  });

  test("malformed token loader output is an explicit failure", () => {
    expect(result("automation-malformed").ok).toBe(false);
  });
});

describe("native launcher seam: startup decision uses one Bun session", () => {
  test("an unreachable port starts a server owned by the launcher", () => {
    expect(value("startup-fresh-server")).toEqual({ decision: "startServer", ownsServer: true });
  });

  test("an already-running healthy Bun session is adopted instead of duplicated", () => {
    expect(value("startup-already-running-bun")).toEqual({
      decision: "adoptRunningServer",
      ownsServer: false,
    });
  });

  test("identical HTML from a different checkout is rejected", () => {
    const conflict = result("startup-foreign-identical-html");
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.kind).toBe("portOccupiedByForeignServer");
  });

  test("a foreign listener on the port is a typed port conflict, never a second server", () => {
    const conflict = result("startup-foreign-server-on-port");
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.kind).toBe("portOccupiedByForeignServer");
  });
});

describe("native launcher seam: health signature", () => {
  test("the existing title + runtime-bootstrap signature marks the webapp healthy", () => {
    expect(value("health-ok")).toEqual({ healthy: true, reason: "ok" });
  });

  test("a non-200 status, foreign body or unreachable port is unhealthy with a machine reason", () => {
    expect(value("health-bad-status")).toEqual({ healthy: false, reason: "badStatus" });
    expect(value("health-wrong-body")).toEqual({ healthy: false, reason: "signatureMismatch" });
    expect(value("health-unreachable")).toEqual({ healthy: false, reason: "unreachable" });
  });
});

describe("native launcher seam: readiness without sleeps", () => {
  test("readiness resolves on the first healthy attempt and reports the attempt index", () => {
    expect(value("readiness-succeeds-after-boot")).toEqual({ ready: true, attempts: 3 });
  });

  test("an exhausted attempt sequence reports not-ready instead of hanging", () => {
    expect(value("readiness-exhausted")).toEqual({ ready: false, attempts: 2 });
  });
});

describe("native launcher seam: process ownership and shutdown", () => {
  test("a clean server exit propagates its status without terminating twice", () => {
    expect(value("shutdown-clean-exit")).toEqual({
      terminations: 0,
      exitCode: 0,
      state: "exited",
    });
  });

  test("quitting terminates the launcher-owned server exactly once", () => {
    expect(value("shutdown-on-quit-terminates-owned-server")).toEqual({
      terminations: 1,
      exitCode: 0,
      state: "exited",
    });
  });

  test("an adopted server is never terminated by this launcher", () => {
    expect(value("shutdown-not-owned-server-untouched")).toEqual({
      terminations: 0,
      exitCode: 0,
      state: "exited",
    });
  });

  test("repeated interrupts terminate the child exactly once", () => {
    expect(value("shutdown-repeated-interrupts-terminate-once")).toEqual({
      terminations: 1,
      exitCode: 0,
      state: "exited",
    });
  });

  test("a crashed server propagates its non-zero status", () => {
    expect(value("shutdown-server-crash-exit-code")).toEqual({
      terminations: 0,
      exitCode: 2,
      state: "exited",
    });
  });

  test("a readiness failure terminates the owned server and exits non-zero", () => {
    expect(value("shutdown-readiness-failure-terminates-server")).toEqual({
      terminations: 1,
      exitCode: 1,
      state: "exited",
    });
  });
});

describe("native launcher seam: transport boundary", () => {
  test("the transport targets the existing local /ws endpoint", () => {
    expect(value("transport-url")).toEqual({
      url: "ws://127.0.0.1:8787/ws",
      origin: "http://127.0.0.1:8787",
    });
  });

  test("an open socket plus a capture snapshot hydrates online state", () => {
    expect(value("transport-connects-and-hydrates")).toEqual({
      connection: "online",
      phase: "capturing",
      startedAt: 1723370000000,
      failures: 0,
      decodeFailures: 0,
    });
  });

  test("a dropped socket becomes reconnecting while retaining the last known capture state", () => {
    expect(value("transport-reconnects-retaining-last-state")).toEqual({
      connection: "reconnecting",
      phase: "capturing",
      startedAt: 1723370000000,
      failures: 1,
      decodeFailures: 0,
    });
  });

  test("an authoritative snapshot after reconnect restores online state", () => {
    expect(value("transport-authoritative-snapshot-restores-online")).toEqual({
      connection: "online",
      phase: "idle",
      startedAt: null,
      failures: 1,
      decodeFailures: 0,
    });
  });

  test("a malformed payload is counted as a typed decode failure and never clears state", () => {
    expect(value("transport-malformed-payload-retains-state")).toEqual({
      connection: "online",
      phase: "capturing",
      startedAt: 1723370000000,
      failures: 0,
      decodeFailures: 1,
      lastDecodeError: "malformedPayload",
    });
  });

  test("an unknown capture phase is a typed decode failure, not a crash or a guess", () => {
    expect(value("transport-unknown-phase-is-typed-failure")).toEqual({
      connection: "online",
      phase: "idle",
      startedAt: null,
      failures: 0,
      decodeFailures: 1,
      lastDecodeError: "unknownPhase",
    });
  });

  test("messages outside the observed subset leave the projection untouched", () => {
    expect(value("transport-ignores-unobserved-messages")).toEqual({
      connection: "online",
      phase: "idle",
      startedAt: null,
      failures: 0,
      decodeFailures: 0,
    });
  });

  test("a status message updates transport status text only", () => {
    expect(value("transport-status-message-is-transport-status")).toEqual({
      connection: "online",
      phase: "idle",
      startedAt: null,
      failures: 0,
      decodeFailures: 0,
      status: "연결됨",
    });
  });

  test("reconnect backoff is monotonic and bounded", () => {
    const backoff = value("transport-backoff-is-bounded-and-monotonic") as {
      delays: number[];
      max: number;
    };
    expect(backoff.delays.length).toBe(8);
    expect(backoff.delays[0]).toBeGreaterThan(0);
    for (let i = 1; i < backoff.delays.length; i += 1) {
      expect(backoff.delays[i]).toBeGreaterThanOrEqual(backoff.delays[i - 1]!);
    }
    expect(Math.max(...backoff.delays)).toBeLessThanOrEqual(backoff.max);
  });
});

describe("native launcher seam: outbound command emission", () => {
  test("rapid Stop activations emit exactly one existing stopCapture action", () => {
    expect(value("commands-stop-once-under-rapid-activation")).toEqual({
      sent: ['{"action":"stopCapture"}'],
    });
  });

  test("Stop while the socket is down emits nothing", () => {
    expect(value("commands-stop-suppressed-while-offline")).toEqual({ sent: [] });
  });

  test("the Stop guard rearms only after an authoritative capture snapshot", () => {
    expect(value("commands-stop-rearms-after-authoritative-capture")).toEqual({
      sent: ['{"action":"stopCapture"}', '{"action":"stopCapture"}'],
    });
  });

  test("the native surface invents no protocol spelling", () => {
    expect(value("commands-use-existing-protocol-spellings")).toEqual({
      actions: ["stopCapture"],
    });
  });
});

describe("native launcher seam: launcher entry point and build wiring", () => {
  const launcher = () => readFileSync(LAUNCHER_SWIFT, "utf8");
  const build = () => readFileSync(BUILD_SCRIPT, "utf8");

  test("the launcher keeps the browser workspace and never imports WebKit", () => {
    const source = launcher();
    expect(source).not.toMatch(/^\s*import\s+WebKit\b/m);
    expect(source).not.toMatch(/WKWebView\s*\(/);
    expect(source).toMatch(/NSWorkspace\.shared\.open/);
  });

  test("the launcher keeps mic permission, calendar auto-capture and bun supervision", () => {
    const source = launcher();
    expect(source).toMatch(/AVCaptureDevice/);
    expect(source).toMatch(/EKEventStore/);
    expect(source).toMatch(/LauncherIO\.calendarAutoCapture\(request: request\)/);
    // The bun invocation, including OPEN_BROWSER=false, now comes from the plan.
    expect(source).toMatch(/plan\.environmentOverlay/);
    expect(source).toMatch(/plan\.arguments/);
    expect(readFileSync(LIFECYCLE_SWIFT, "utf8")).toMatch(/"OPEN_BROWSER": "false"/);
  });

  test("the launcher delegates decisions to the pure modules instead of re-deriving them", () => {
    const source = launcher();
    expect(source).toMatch(/LauncherEnvironment\.httpPort\(/);
    expect(source).toMatch(/LauncherEnvironment\.serverLaunchPlan\(/);
    expect(source).toMatch(/ServerHealth\.evaluate\(/);
    // The pure modules own these rules now; the entry point must not duplicate them.
    expect(source).not.toMatch(/return 8787/);
    expect(source).not.toMatch(/runtime-bootstrap/);
  });

  test("the entry point holds side effects only, never lifecycle rules", () => {
    const source = launcher();
    // Rules that must live in the pure module: port fallback, health signature,
    // bun invocation, adoption/ownership decision, termination policy.
    expect(source).not.toMatch(/8787/);
    expect(source).not.toMatch(/<title>Meeting Slides/);
    expect(source).not.toMatch(/"run", "server\.ts"/);
    expect(source).not.toMatch(/OPEN_BROWSER"\]\s*=/);
    // Termination is only ever an effect handed down by ServerLifecycle.
    const terminateSites = source.match(/\.terminate\(\)/g) ?? [];
    expect(terminateSites.length).toBe(1);
    expect(source).toMatch(/case \.terminateServer:/);
  });

  test("the build script compiles every native source the entry point needs", () => {
    const source = build();
    expect(source).toMatch(/macos\/launcher\.swift/);
    expect(source).toMatch(/macos\/AppLifecycle\.swift/);
    expect(source).toMatch(/codesign --verify --deep --strict/);
    expect(source).toMatch(/build still links WebKit/);
    expect(source).toMatch(/CFBundleIdentifier<\/key><string>com\.meetingslides\.app/);
  });

  test("the shipped bundle links the transport into exactly one executable", () => {
    // Todo 14 wires the minibar, so the transport client now ships. The
    // invariant that survives: one native executable holds the whole native
    // surface, so there is still exactly one Bun session and one transport.
    const source = build();
    expect(source).toMatch(/macos\/NativeSurfaceContract\.swift/);
    expect(source).toMatch(/macos\/TransportClient\.swift/);
    expect(source).toMatch(/macos\/SystemAudioCapture\.swift/);
    expect(source.match(/swiftc -O -o/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/CFBundleExecutable<\/key><string>meeting-slides/);
  });
});
