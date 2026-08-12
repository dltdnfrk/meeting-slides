// Live native client handle for the dual-surface integration seam (Todo 16).
//
// Compiles `tests/fixtures/native-dual-surface-driver.swift` together with the
// SHIPPING pure modules (`macos/NativeSurfaceContract.swift`,
// `macos/AppLifecycle.swift`, `macos/TransportClient.swift`,
// `macos/MinibarProjection.swift`) and runs it as a real WebSocket client of the
// fixture session.
//
// Synchronisation rule, identical to the browser driver's: a state predicate is
// SUBSCRIBED to before the trigger that should satisfy it, and awaiting is
// bounded. Nothing sleeps, nothing polls, and a state that never arrives fails
// with a named error instead of letting a later assertion read stale state.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

export const NATIVE_SOURCES = [
  join(ROOT, "macos", "NativeSurfaceContract.swift"),
  join(ROOT, "macos", "AppLifecycle.swift"),
  join(ROOT, "macos", "TransportClient.swift"),
  join(ROOT, "macos", "MinibarProjection.swift"),
];
export const NATIVE_DRIVER_SOURCE = join(ROOT, "tests", "fixtures", "native-dual-surface-driver.swift");

/** Bounded deadline for one awaited native state. */
export const DEFAULT_NATIVE_TIMEOUT_MS = 5_000;

export class NativeStateTimeoutError extends Error {
  readonly missingState: string;
  readonly lastState: NativeState | null;
  constructor(missingState: string, timeoutMs: number, lastState: NativeState | null) {
    super(
      `native surface timed out after ${timeoutMs}ms waiting for "${missingState}"; last state: ${
        lastState ? JSON.stringify({ status: lastState.status, phase: lastState.capturePhase, connection: lastState.connection }) : "none"
      }`,
    );
    this.name = "NativeStateTimeoutError";
    this.missingState = missingState;
    this.lastState = lastState;
  }
}

export interface NativeLine {
  text: string;
  ts: number;
  provisional: boolean;
  speaker: number | null;
}

export interface NativeState {
  kind: "state";
  seq: number;
  reason: string;
  connection: "connecting" | "online" | "reconnecting";
  status: string;
  capturePhase: string;
  capturing: boolean;
  mode: string;
  startedAt: number | null;
  timer: string | null;
  glyph: string;
  title: string;
  lines: NativeLine[];
  stopEnabled: boolean;
  errorReason: string | null;
  decodeFailures: number;
  projectionDecodeFailures: number;
  dropCount: number;
  sent: string[];
}

export interface CompileResult {
  exitCode: number;
  log: string;
  binary: string;
  cleanup(): void;
}

export function compileNativeDualSurfaceDriver(): CompileResult {
  const buildDir = mkdtempSync(join(tmpdir(), "caret-dual-surface-"));
  const binary = join(buildDir, "dual-surface-driver");
  const proc = Bun.spawnSync([
    "swiftc",
    "-O",
    "-swift-version",
    "5",
    "-o",
    binary,
    ...NATIVE_SOURCES,
    NATIVE_DRIVER_SOURCE,
  ]);
  const decoder = new TextDecoder();
  return {
    exitCode: proc.exitCode,
    log: `${decoder.decode(proc.stdout ?? new Uint8Array())}${decoder.decode(proc.stderr ?? new Uint8Array())}`,
    binary,
    cleanup() {
      rmSync(buildDir, { recursive: true, force: true });
    },
  };
}

type Predicate = (state: NativeState) => boolean;

interface Subscription {
  id: number;
  label: string;
  predicate: Predicate;
  /** Only states emitted at or after this ordinal may satisfy the wait. */
  fromOrdinal: number;
  resolve(state: NativeState): void;
}

export interface NativeSurfaceClient {
  /** All states observed, in order. */
  readonly states: readonly NativeState[];
  readonly latest: NativeState | null;
  /** Arm a subscription BEFORE the trigger; await the returned promise after. */
  expect(label: string, predicate: Predicate, timeoutMs?: number): Promise<NativeState>;
  /** Set the injected clock; the driver reports a fresh projection afterwards. */
  setNow(value: number): Promise<NativeState>;
  connect(): Promise<NativeState>;
  disconnect(): Promise<NativeState>;
  /** Activate the Stop control; returns the state the activation produced. */
  activateStop(): Promise<NativeState>;
  /** Activate Stop without awaiting, for rapid-activation proofs. */
  activateStopNoWait(): void;
  setMode(mode: "collapsed" | "expanded"): Promise<NativeState>;
  snapshot(label: string): Promise<NativeState>;
  /** Frames this client actually put on the wire. */
  readonly sentFrames: readonly string[];
  close(): Promise<void>;
}

export async function startNativeSurfaceClient(
  binary: string,
  wsUrl: string,
): Promise<NativeSurfaceClient> {
  const proc = Bun.spawn([binary, wsUrl], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const states: NativeState[] = [];
  const subscriptions = new Map<number, Subscription>();
  let subscriptionId = 0;
  let ordinal = 0;
  // Resolved by the first `ready` line the driver prints. Declared as a mutable
  // holder so clearing it after the first use cannot narrow the call signature
  // away.
  const readyGate: { resolve: (() => void) | null } = { resolve: null };
  const readyPromise = new Promise<void>((resolveReady) => {
    readyGate.resolve = resolveReady;
  });

  const decoder = new TextDecoder();
  let buffer = "";
  const reader = proc.stdout.getReader();

  function deliver(state: NativeState): void {
    states.push(state);
    for (const subscription of [...subscriptions.values()]) {
      if (state.seq < subscription.fromOrdinal) continue;
      if (!subscription.predicate(state)) continue;
      subscriptions.delete(subscription.id);
      subscription.resolve(state);
    }
  }

  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!rawLine.trim()) continue;
        let parsed: { kind?: string } & Record<string, unknown>;
        try {
          parsed = JSON.parse(rawLine);
        } catch {
          continue;
        }
        if (parsed.kind === "ready") {
          readyGate.resolve?.();
          readyGate.resolve = null;
        } else if (parsed.kind === "state") {
          const state = parsed as unknown as NativeState;
          ordinal = state.seq;
          deliver(state);
        }
      }
    }
  })();

  await readyPromise;

  function send(command: Record<string, unknown>): void {
    proc.stdin.write(`${JSON.stringify(command)}\n`);
    proc.stdin.flush();
  }

  function expect(label: string, predicate: Predicate, timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS): Promise<NativeState> {
    // Armed at call time: a state produced after this point can satisfy it, and
    // an already-observed state cannot (the trigger has not fired yet).
    const id = (subscriptionId += 1);
    const fromOrdinal = ordinal + 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Promise<NativeState>((resolvePromise, reject) => {
      subscriptions.set(id, {
        id,
        label,
        predicate,
        fromOrdinal,
        resolve(state) {
          if (timer !== undefined) clearTimeout(timer);
          resolvePromise(state);
        },
      });
      timer = setTimeout(() => {
        subscriptions.delete(id);
        reject(new NativeStateTimeoutError(label, timeoutMs, states.at(-1) ?? null));
      }, timeoutMs);
    });
  }

  async function command(label: string, payload: Record<string, unknown>, predicate: Predicate): Promise<NativeState> {
    const settled = expect(label, predicate);
    send(payload);
    return settled;
  }

  return {
    get states() {
      return states;
    },
    get latest() {
      return states.at(-1) ?? null;
    },
    get sentFrames() {
      return states.at(-1)?.sent ?? [];
    },
    expect,
    setNow(value) {
      return command(`now=${value}`, { op: "now", value }, (state) => state.reason === "now");
    },
    connect() {
      return command("native:open", { op: "connect" }, (state) => state.reason === "open");
    },
    disconnect() {
      return command(
        "native:disconnect",
        { op: "disconnect" },
        (state) => state.connection === "reconnecting",
      );
    },
    activateStop() {
      return command("native:stop-activated", { op: "stop" }, (state) => state.reason === "stop-activated");
    },
    activateStopNoWait() {
      send({ op: "stop" });
    },
    setMode(mode) {
      return command(`native:mode=${mode}`, { op: "mode", value: mode }, (state) => state.reason === "mode");
    },
    snapshot(label) {
      return command(`native:snapshot=${label}`, { op: "snapshot", label }, (state) => state.reason === label);
    },
    async close() {
      send({ op: "quit" });
      await proc.exited;
      await pump.catch(() => {});
    },
  };
}
