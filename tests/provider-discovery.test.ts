import { afterEach, describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  inspectSubscriptionProviders,
  PROVIDER_PROBE_TIMEOUT_MS,
  type CommandResult,
} from "../src/provider-adapters.ts";

const environment = { HOME: "/nonexistent/provider-discovery", PATH: "/nonexistent/provider-discovery" };
const success: CommandResult = { status: 0, stdout: "1.2.3\n", stderr: "" };
const fixtureRoots = new Set<string>();

afterEach(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true });
    fixtureRoots.delete(root);
  }
});

describe("provider discovery characterization", () => {
  test("observes a successful version before probing auth for each adapter", async () => {
    // Given a runner that records when installation status has been consumed.
    const versionObserved = new Set<string>();
    const authCalls: string[] = [];
    const run = async (executable: string, args: readonly string[]): Promise<CommandResult> => {
      const name = basename(executable);
      if (args[0] === "--version") {
        return {
          get status() { versionObserved.add(name); return 0; },
          stdout: "", stderr: " version-on-stderr \n",
        };
      }
      expect(versionObserved.has(name)).toBe(true);
      authCalls.push(name);
      return { status: 0, stdout: '{"loggedIn":true}', stderr: "" };
    };
    // When all installed adapters are discovered.
    const states = await inspectSubscriptionProviders(environment, run);
    // Then auth is only probed for verifiable adapters, in registry result order.
    expect(authCalls).toEqual(["codex", "claude"]);
    expect(states.map(({ id, auth, version }) => [id, auth, version])).toEqual([
      ["cli:codex", "connected", "version-on-stderr"],
      ["cli:grok", "unknown", "version-on-stderr"],
      ["cli:claude", "connected", "version-on-stderr"],
      ["cli:gemini", "unknown", "version-on-stderr"],
    ]);
  });

  test.each([
    [{ status: 1, stdout: "", stderr: "" }, "disconnected"],
    [{ status: 0, stdout: '{"loggedIn":false}', stderr: "" }, "disconnected"],
    [{ status: 0, stdout: "not json", stderr: "" }, "unknown"],
    [{ status: 0, stdout: '{}', stderr: "" }, "unknown"],
    [{ status: null, stdout: "", stderr: "", error: new Error("probe failed") }, "unknown"],
  ] satisfies [CommandResult, string][])("preserves Claude auth outcome %#", async (authResult, auth) => {
    // Given installed CLIs and an independently controlled auth result.
    const run = async (_executable: string, args: readonly string[]) => args[0] === "--version" ? success : authResult;
    // When discovery parses auth.
    const states = await inspectSubscriptionProviders(environment, run);
    // Then nonzero auth differs from malformed/failed probes.
    expect(states.find((state) => state.id === "cli:claude")).toMatchObject({ installed: true, auth });
  });

  test("never runs auth after an unsuccessful version", async () => {
    // Given failed installation probes.
    const calls: string[][] = [];
    const run = async (_executable: string, args: readonly string[]): Promise<CommandResult> => {
      calls.push([...args]);
      return { status: 1, stdout: "", stderr: "" };
    };
    // When discovery runs.
    const states = await inspectSubscriptionProviders(environment, run);
    // Then only version commands ran and no provider is selectable.
    expect(calls).toEqual(Array.from({ length: 4 }, () => ["--version"]));
    expect(states.map(({ installed, auth }) => [installed, auth])).toEqual(Array.from({ length: 4 }, () => [false, "unavailable"]));
  });
});

function cliFixture(codexBody: string) {
  const root = mkdtempSync(join(tmpdir(), "provider-discovery-"));
  // Own the directory before fixture setup can throw.
  fixtureRoots.add(root);
  console.info(`PROVIDER_FIXTURE ${root}`);
  for (const name of ["codex", "grok", "claude", "gemini"]) {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\n${name === "codex" ? codexBody : "exit 1"}\n`);
    chmodSync(path, 0o755);
  }
  return { HOME: root, PATH: root };
}

test("the real command timeout leaves the event loop responsive", async () => {
  // Given a silent executable with no natural completion and a subscribed loop turn.
  const env = cliFixture("exec /usr/bin/tail -f /dev/null");
  let yielded = false;
  const heartbeat = new Promise<void>((resolve) => setImmediate(() => { yielded = true; resolve(); }));
  // When the fixed production timeout terminates discovery.
  const states = await inspectSubscriptionProviders(env);
  // Then discovery was asynchronous even while the command was blocked.
  const yieldedBeforeCompletion = yielded;
  await heartbeat;
  expect(PROVIDER_PROBE_TIMEOUT_MS).toBe(5_000);
  expect(yieldedBeforeCompletion).toBe(true);
  expect(states[0]).toMatchObject({ installed: false, auth: "unavailable" });
}, 8_000);

function bunFixture(body: string) {
  const env = cliFixture(`exec '${process.execPath}' "$HOME/probe.ts" "$@"`);
  writeFileSync(join(env.HOME, "probe.ts"), body);
  return env;
}

test.each(["version", "auth"])("drains complete UTF-8 output before parsing %s", async (phase) => {
  // Given output larger than a pipe buffer, written in byte-split UTF-8 chunks.
  const text = "한".repeat(80_000);
  const env = bunFixture(`
    import { writeSync } from "node:fs";
    const bytes = Buffer.from(process.argv[2] === "--version" ? ${JSON.stringify(text)} : "ok");
    for (let i = 0; i < bytes.length; i += 4097) writeSync(${phase === "version" ? 1 : 2}, bytes.subarray(i, i + 4097));
  `);
  // When real processes exit with buffered output remaining.
  const states = await inspectSubscriptionProviders(env);
  // Then stdout and stderr version fallbacks are complete, not truncated at exit.
  expect(states[0]).toMatchObject({ installed: true, auth: "connected", version: text });
});

test.each(["version", "auth"])("bounds combined stdout/stderr during %s", async (phase) => {
  // Given individually sub-limit streams whose combined size exceeds 1 MiB.
  const env = bunFixture(`
    import { writeSync } from "node:fs";
    if (${JSON.stringify(phase)} === "auth" && process.argv[2] === "--version") console.log("1.2.3");
    else { writeSync(1, Buffer.alloc(600_000, 120)); writeSync(2, Buffer.alloc(600_000, 121)); }
  `);
  // When a real command exceeds the output budget.
  const states = await inspectSubscriptionProviders(env);
  // Then truncation cannot masquerade as installation or verified auth.
  expect(states[0]).toMatchObject(phase === "auth" ? { installed: true, auth: "unknown" } : { installed: false, auth: "unavailable" });
});

test.each([
  { phase: "version", cancel: true, leaderExits: false },
  { phase: "auth", cancel: true, leaderExits: false },
  { phase: "version", cancel: false, leaderExits: true },
  { phase: "version", cancel: false, leaderExits: false },
])("closes owned process trees %#", async ({ phase, cancel, leaderExits }) => {
  // Given root/descendant sockets subscribed before probes launch; no timing waits.
  const ready = deferred<void>();
  const closed: Promise<unknown>[] = [];
  const pids: number[] = [];
  const server = createServer((socket) => {
    closed.push(once(socket, "close"));
    socket.once("data", (bytes) => {
      pids.push(Number(bytes.toString().trim()));
      if (pids.length === (leaderExits ? 1 : 2)) ready.resolve();
    });
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  const env = bunFixture(`
    import { connect } from "node:net";
    import { spawn } from "node:child_process";
    if (${JSON.stringify(phase)} === "auth" && process.argv[2] === "--version") console.log("1.2.3");
    else {
      process.on("SIGTERM", () => {});
      if (process.argv[2] !== "child") {
        spawn(process.execPath, [process.argv[1], "child"], { stdio: "inherit" });
        if (${leaderExits}) process.exit(0);
      }
      const socket = connect(${address.port}, "127.0.0.1");
      socket.on("connect", () => socket.write(String(process.pid) + "\\n"));
    }
  `);
  const controller = new AbortController();
  const discovery = inspectSubscriptionProviders(env, undefined, controller.signal);
  try {
    await Promise.race([ready.promise, discovery.then(() => { throw new Error("Probe completed before children reported readiness"); })]);
    // When cancellation or the production deadline terminates the owned group.
    if (cancel) controller.abort();
    const states = await discovery;
    await Promise.all(closed);
    // Then even inherited-pipe children release resources before the check completes.
    expect(states[0]).toMatchObject(phase === "auth" ? { installed: true, auth: "unknown" } : { installed: false, auth: "unavailable" });
    expect(pids).toHaveLength(leaderExits ? 1 : 2);
    console.info(`PROVIDER_CLOSED_PIDS ${pids.join(",")} cwd=${process.cwd()} fixture=${env.HOME}`);
  } finally {
    controller.abort();
    await discovery;
    const serverClosed = once(server, "close");
    server.close();
    await serverClosed;
  }
}, 8_000);

function deferred<T>() {
  return Promise.withResolvers<T>();
}

describe("asynchronous provider discovery", () => {
  test("starts adapters concurrently but waits for each version before auth and returns registry order", async () => {
    // Given independently deferred command results and subscribed auth-start signals.
    const pending = new Map<string, ReturnType<typeof deferred<CommandResult>>>();
    const codexAuth = deferred<void>();
    const claudeAuth = deferred<void>();
    const calls: string[] = [];
    const run = (executable: string, args: readonly string[]) => {
      const key = `${basename(executable)}:${args.join(" ")}`;
      calls.push(key);
      const result = deferred<CommandResult>();
      pending.set(key, result);
      if (key === "codex:login status") codexAuth.resolve();
      if (key === "claude:auth status --json") claudeAuth.resolve();
      return result.promise;
    };
    // When discovery starts, all version probes must be in flight without auth.
    const discovery = inspectSubscriptionProviders(environment, run);
    expect(discovery).toBeInstanceOf(Promise);
    expect(calls).toEqual(["codex:--version", "grok:--version", "claude:--version", "gemini:--version"]);
    pending.get("claude:--version")?.resolve(success);
    await claudeAuth.promise;
    expect(calls).not.toContain("codex:login status");
    pending.get("claude:auth status --json")?.resolve({ status: 0, stdout: '{"loggedIn":false}', stderr: "" });
    pending.get("gemini:--version")?.resolve(success);
    pending.get("grok:--version")?.resolve(success);
    pending.get("codex:--version")?.resolve(success);
    await codexAuth.promise;
    pending.get("codex:login status")?.resolve(success);
    // Then completion order never changes registry output order or auth truth.
    const states = await discovery;
    expect(states.map(({ id, auth }) => [id, auth])).toEqual([
      ["cli:codex", "connected"], ["cli:grok", "unknown"],
      ["cli:claude", "disconnected"], ["cli:gemini", "unknown"],
    ]);
  }, 2_000);

  test("does not launch commands when already cancelled", async () => {
    // Given cancellation before discovery owns any processes.
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    // When discovery is requested.
    const states = await inspectSubscriptionProviders(environment, (executable) => {
      calls.push(executable);
      return Promise.resolve(success);
    }, controller.signal);
    // Then no executable ran and none is reported installed.
    expect(calls).toEqual([]);
    expect(states.every((state) => !state.installed && state.auth === "unavailable")).toBe(true);
  });

  test("cancellation between version and auth preserves installed but unknown state", async () => {
    // Given a runner completing versions while cancellation is requested.
    const controller = new AbortController();
    const calls: string[][] = [];
    // When version succeeds at the cancellation boundary.
    const states = await inspectSubscriptionProviders(environment, async (_executable, args) => {
      calls.push([...args]);
      controller.abort();
      return success;
    }, controller.signal);
    // Then the successful version is retained but no auth command may start.
    expect(states[0]).toMatchObject({ installed: true, auth: "unknown", version: "1.2.3" });
    expect(calls.every((args) => args[0] === "--version")).toBe(true);
  });
});
