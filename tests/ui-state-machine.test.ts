// Pure canonical UI state reducer contract (plan Todo 7).
//
// Two layers of assertions live here:
//
//   1. Characterization of machine-consumed state projections, independent of
//      the source file or local variables used by the browser controllers.
//
//   2. The canonical reducer contract itself: every named UI state, the whole
//      transition table, typed parse failures at the boundary, determinism,
//      reconnect/out-of-order handling, Stop truthfulness and stale-error
//      clearing.
//
// The reducer is pure: no DOM, no clock, no network, no storage, no globals.
// Wall-clock values only ever enter through explicit event payloads.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerMessage } from "../src/protocol.ts";

import {
  initialUiState,
  parseServerEvent,
  reduce,
  reduceAll,
  type UiEvent,
  type UiState,
  type UiStateName,
} from "../public/ui-state-machine.ts";

const root = join(import.meta.dir, "..");

// ── deterministic fixture data (no clock, no randomness) ────────────────────

const T0 = 1_710_376_860_000;

const CAPTURE_IDLE = { type: "capture", capturing: false, mode: "mic", phase: "idle" } as const;
const CAPTURE_STARTING = { type: "capture", capturing: false, mode: "mic", phase: "starting" } as const;
const CAPTURE_LIVE = {
  type: "capture",
  capturing: true,
  mode: "mic",
  phase: "capturing",
  startedAt: T0 - 125_000,
} as const;
const CAPTURE_STOPPING = {
  type: "capture",
  capturing: true,
  mode: "mic",
  phase: "stopping",
  startedAt: T0 - 125_000,
} as const;
/** Phase-less capture message: still shipped by servers that predate `phase`. */
const CAPTURE_LIVE_NO_PHASE = { type: "capture", capturing: true, mode: "mic", startedAt: T0 - 125_000 } as const;
const CAPTURE_IDLE_NO_PHASE = { type: "capture", capturing: false, mode: "mic" } as const;

const MEETINGS = {
  type: "meetings",
  items: [
    { id: 101, title: "제품 로드맵 정렬", started_at: T0 - 86_400_000, status: "ended" },
    { id: 102, title: "고객 온보딩 리뷰", started_at: T0 - 172_800_000, status: "ended" },
  ],
} as const;

const MEETING_101 = {
  type: "meeting",
  meetingId: 101,
  title: "제품 로드맵 정렬",
  transcript: [],
  current: null,
  history: [],
  compiled: null,
} as const;

const MEETING_102 = { ...MEETING_101, meetingId: 102, title: "고객 온보딩 리뷰" } as const;

const COMPILE_JOB = "compile-fixture-0001";

function serverEvent(message: unknown): UiEvent {
  const parsed = parseServerEvent(message);
  if (!parsed.ok) throw new Error(`fixture is not a valid server event: ${parsed.error.reason}`);
  return parsed.event;
}

function run(events: readonly UiEvent[], from: UiState = initialUiState()): UiState {
  return reduceAll(from, events);
}

function names(events: readonly UiEvent[], from: UiState = initialUiState()): UiStateName[] {
  const seen: UiStateName[] = [];
  let state = from;
  for (const event of events) {
    state = reduce(state, event);
    seen.push(state.name);
  }
  return seen;
}

/** Connected + hydrated + library listed: the common prelude for most cases. */
function online(): UiState {
  return run([
    { kind: "transport", status: "open" },
    serverEvent(CAPTURE_IDLE),
    serverEvent(MEETINGS),
  ]);
}

/** Connected + hydrated into a live capture. */
function live(): UiState {
  return run([
    { kind: "transport", status: "open" },
    serverEvent(CAPTURE_LIVE),
    serverEvent(MEETINGS),
  ]);
}

// ── 1. machine-consumed state projections ──────────────────────────────────

describe("visible state projections", () => {
  test("an authoritative live capture projects its phase, shell and timer origin", () => {
    const state = run([serverEvent(CAPTURE_LIVE)], online());
    expect({ capture: state.capture, shell: state.shell, startedAt: state.captureStartedAt })
      .toEqual({ capture: "capturing", shell: "live", startedAt: T0 - 125_000 });
  });

  test("hydration does not invent a selection, preview or active job", () => {
    const state = online();
    expect({ hydrated: state.hydrated, selected: state.selectedMeetingId, preview: state.preview, job: state.activeJobId })
      .toEqual({ hydrated: true, selected: null, preview: null, job: null });
  });

  test("transport signals project distinct machine connection values", () => {
    const signals = ["connecting", "open", "closed", "error"] as const;
    const states = signals.map((status) => reduce(live(), { kind: "transport", status }).connection);
    expect(states).toEqual(["connecting", "connecting", "reconnecting", "error"]);
  });

  test("out-of-order meeting and job responses cannot replace the selected work", () => {
    const running = run([
      { kind: "selectMeeting", meetingId: 102 },
      serverEvent(MEETING_102),
      serverEvent({ type: "compile", status: "started", jobId: COMPILE_JOB, meetingId: 102 }),
    ], online());
    const stale = run([
      serverEvent(MEETING_101),
      serverEvent({ type: "compile", status: "success", jobId: "compile-old", meetingId: 101 }),
    ], running);
    expect({ selected: stale.selectedMeetingId, loaded: stale.loadedMeetingId, job: stale.activeJobId })
      .toEqual({ selected: 102, loaded: 102, job: COMPILE_JOB });
  });

  test("malformed traffic produces a typed protocol error without ending capture", () => {
    const state = reduce(live(), { kind: "malformed", reason: "INVALID_FRAME" });
    expect({ capture: state.capture, error: state.lastError })
      .toEqual({ capture: "capturing", error: { scope: "protocol", reason: "INVALID_FRAME" } });
  });
});

// ── 2. purity ───────────────────────────────────────────────────────────────

describe("reducer purity", () => {
  const source = readFileSync(join(root, "public/ui-state-machine.ts"), "utf8");

  test("uses no DOM, clock, network, storage or global ambient value", () => {
    for (const forbidden of [
      "document",
      "window",
      "localStorage",
      "sessionStorage",
      "WebSocket",
      "fetch(",
      "Date.now",
      "new Date",
      "performance.now",
      "setTimeout",
      "setInterval",
      "Math.random",
      "globalThis",
      "process.",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  test("declares no `any` and no unsafe cast", () => {
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    // `any` as a type position: after `:`, `<`, `as`, or in a union.
    expect(code).not.toMatch(/(?::|<|\bas\b|\|)\s*any\b/);
    expect(code).not.toContain("as unknown as");
    expect(code).not.toContain("@ts-");
    // Non-null assertions and unchecked index access.
    expect(code).not.toMatch(/[A-Za-z_$\])]!\s*[.[]/);
  });

  test("does not mutate the state it is given", () => {
    const before = online();
    const snapshot = JSON.stringify(before);
    reduce(before, serverEvent(CAPTURE_LIVE));
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(Object.isFrozen(before)).toBe(true);
  });

  test("initial state is startup and is a fresh value each call", () => {
    const a = initialUiState();
    const b = initialUiState();
    expect(a.name).toBe("startup");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

// ── 3. parse boundary ───────────────────────────────────────────────────────

describe("parse boundary", () => {
  test("a valid refine response leaves capture, selection and job state untouched", () => {
    const before = live();
    const frame = { type: "refine", requestId: "refine-contract", slideId: "s1", path: "title",
      before: "BEFORE", after: "AFTER", claimIds: [] } satisfies ServerMessage;
    expect(reduce(before, serverEvent(frame))).toEqual(before);
  });

  test("accepts every server message type the protocol declares", () => {
    const contract = JSON.parse(
      readFileSync(join(root, "tests/fixtures/public-protocol-contract.json"), "utf8"),
    ) as { serverMessages: Array<{ type: string; handledByClient: boolean }> };
    const handled = contract.serverMessages.filter((m) => m.handledByClient).map((m) => m.type);
    for (const type of handled) {
      const parsed = parseServerEvent({ type, ...sampleBodyFor(type) });
      expect([type, parsed.ok]).toEqual([type, true]);
    }
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "capture"],
    ["number", 7],
    ["array", []],
    ["missing type", { capturing: true }],
    ["numeric type", { type: 3 }],
    ["unknown type", { type: "teleport" }],
    ["capture without capturing", { type: "capture", mode: "mic" }],
    ["capture with non-boolean capturing", { type: "capture", capturing: "yes", mode: "mic" }],
    ["capture with unknown phase", { type: "capture", capturing: true, mode: "mic", phase: "warping" }],
    ["meeting without meetingId", { type: "meeting", title: "x" }],
    ["meetings without items", { type: "meetings" }],
    ["compile without status", { type: "compile", jobId: COMPILE_JOB }],
    ["compile with unknown status", { type: "compile", status: "melted", jobId: COMPILE_JOB }],
  ])("rejects %s as a typed failure", (_label, input) => {
    const parsed = parseServerEvent(input);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(typeof parsed.error.reason).toBe("string");
    expect(parsed.error.reason.length).toBeGreaterThan(0);
  });

  test("a rejected frame never reaches the reducer and never changes state", () => {
    const before = live();
    const parsed = parseServerEvent({ type: "capture", capturing: "yes", mode: "mic" });
    expect(parsed.ok).toBe(false);
    // The only way to feed a malformed frame in is the explicit typed event.
    const after = reduce(before, { kind: "malformed", reason: "capture.capturing is not a boolean" });
    expect(after.name).toBe(before.name);
    expect(after.capture).toEqual(before.capture);
    expect(after.lastError).toEqual({ scope: "protocol", reason: "capture.capturing is not a boolean" });
  });
});

// ── 4. named states and the transition table ───────────────────────────────

const ALL_STATE_NAMES: readonly UiStateName[] = [
  "startup",
  "reconnect",
  "idle-library",
  "idle-live",
  "capture-starting",
  "capture-live",
  "capture-stopping",
  "capture-error",
  "meeting-switching",
  "history-preview",
  "compile-running",
  "compile-complete",
];

describe("canonical states", () => {
  test("every state in the contract is reachable from startup", () => {
    const reached = new Set<UiStateName>(["startup"]);

    reached.add(run([{ kind: "transport", status: "open" }, serverEvent(CAPTURE_IDLE)]).name);
    reached.add(run([{ kind: "transport", status: "closed" }], live()).name);
    reached.add(run([serverEvent(CAPTURE_IDLE), serverEvent(MEETING_101)], live()).name);
    reached.add(run([{ kind: "activateCapture" }], online()).name);
    reached.add(run([serverEvent(CAPTURE_LIVE)], online()).name);
    reached.add(run([{ kind: "activateCapture" }], live()).name);
    reached.add(run([{ kind: "captureFailed", reason: "mic busy" }], online()).name);
    reached.add(run([{ kind: "selectMeeting", meetingId: 101 }], online()).name);
    reached.add(run([{ kind: "previewSlide", index: 2 }], live()).name);
    reached.add(
      run([
        { kind: "selectMeeting", meetingId: 101 },
        serverEvent(MEETING_101),
        serverEvent({ type: "compile", status: "started", jobId: COMPILE_JOB, meetingId: 101 }),
      ], online()).name,
    );
    reached.add(
      run([
        { kind: "selectMeeting", meetingId: 101 },
        serverEvent(MEETING_101),
        serverEvent({ type: "compile", status: "started", jobId: COMPILE_JOB, meetingId: 101 }),
        serverEvent({ type: "compile", status: "success", jobId: COMPILE_JOB, meetingId: 101, path: "/tmp/a.pptx" }),
      ], online()).name,
    );

    expect([...reached].sort()).toEqual([...ALL_STATE_NAMES].sort());
  });

  test("state name is always consistent with the capture and shell projection", () => {
    const cases: Array<[UiState, UiStateName]> = [
      [initialUiState(), "startup"],
      [online(), "idle-library"],
      [live(), "capture-live"],
      [run([{ kind: "activateCapture" }], online()), "capture-starting"],
      [run([{ kind: "activateCapture" }], live()), "capture-stopping"],
    ];
    for (const [state, name] of cases) expect(state.name).toBe(name);

    expect(online().shell).toBe("library");
    expect(live().shell).toBe("live");
    expect(run([{ kind: "activateCapture" }], online()).capture).toBe("starting");
    expect(run([{ kind: "activateCapture" }], live()).capture).toBe("stopping");
  });

  test("reduce is exhaustive: every event kind is handled from every state", () => {
    const events: UiEvent[] = [
      { kind: "transport", status: "connecting" },
      { kind: "transport", status: "open" },
      { kind: "transport", status: "closed" },
      { kind: "transport", status: "error" },
      { kind: "activateCapture" },
      { kind: "captureFailed", reason: "mic busy" },
      { kind: "selectMeeting", meetingId: 102 },
      { kind: "returnToLibrary" },
      { kind: "previewSlide", index: 1 },
      { kind: "exitPreview" },
      { kind: "dismissError" },
      { kind: "malformed", reason: "bad frame" },
      serverEvent(CAPTURE_IDLE),
      serverEvent(CAPTURE_STARTING),
      serverEvent(CAPTURE_LIVE),
      serverEvent(CAPTURE_STOPPING),
      serverEvent(MEETINGS),
      serverEvent(MEETING_101),
      serverEvent({ type: "status", text: "x" }),
      serverEvent({ type: "compile", status: "started", jobId: COMPILE_JOB, meetingId: 101 }),
      serverEvent({ type: "compile", status: "progress", jobId: COMPILE_JOB, meetingId: 101, completed: 1, total: 4 }),
      serverEvent({ type: "compile", status: "success", jobId: COMPILE_JOB, meetingId: 101, path: "/tmp/a.pptx" }),
      serverEvent({ type: "compile", status: "error", jobId: COMPILE_JOB, meetingId: 101, error: "nope" }),
    ];

    const seeds: UiState[] = [
      initialUiState(),
      online(),
      live(),
      run([{ kind: "activateCapture" }], online()),
      run([{ kind: "activateCapture" }], live()),
      run([{ kind: "captureFailed", reason: "mic busy" }], online()),
      run([{ kind: "transport", status: "closed" }], live()),
      run([{ kind: "selectMeeting", meetingId: 101 }], online()),
      run([{ kind: "previewSlide", index: 2 }], live()),
    ];

    for (const seed of seeds) {
      for (const event of events) {
        const next = reduce(seed, event);
        expect(ALL_STATE_NAMES).toContain(next.name);
        expect(Object.isFrozen(next)).toBe(true);
      }
    }
  });
});

// ── 5. capture lifecycle ────────────────────────────────────────────────────

describe("capture lifecycle", () => {
  test("happy path: activate → starting → live → stop → stopping → idle", () => {
    const sequence: UiEvent[] = [
      { kind: "activateCapture" },
      serverEvent(CAPTURE_STARTING),
      serverEvent(CAPTURE_LIVE),
      { kind: "activateCapture" },
      serverEvent(CAPTURE_STOPPING),
      serverEvent(CAPTURE_IDLE),
    ];
    // The tail is `idle-live`, not `idle-library`: after a capture ends the
    // surface keeps the just-ended meeting in the live shell until the user
    // explicitly returns to the library.
    expect(names(sequence, online())).toEqual([
      "capture-starting",
      "capture-starting",
      "capture-live",
      "capture-stopping",
      "capture-stopping",
      "idle-live",
    ]);
  });

  test("start emits exactly one startCapture no matter how often it is activated", () => {
    let state = online();
    const emitted: string[] = [];
    for (const event of [{ kind: "activateCapture" }, { kind: "activateCapture" }, { kind: "activateCapture" }] as UiEvent[]) {
      state = reduce(state, event);
      emitted.push(...state.outbox.map((command) => command.action));
    }
    expect(emitted).toEqual(["startCapture"]);
  });

  test("stop emits exactly one stopCapture from every server-confirmed capture substate", () => {
    const confirmed: Array<[string, UiState]> = [
      ["starting", run([{ kind: "activateCapture" }, serverEvent(CAPTURE_STARTING)], online())],
      ["capturing", live()],
      [
        "switching-model",
        run([serverEvent({ type: "capture", capturing: true, mode: "mic", phase: "switching-model", startedAt: T0 })], live()),
      ],
      ["stopping", run([serverEvent(CAPTURE_STOPPING)], live())],
    ];
    for (const [phase, seed] of confirmed) {
      let state = seed;
      const emitted: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        state = reduce(state, { kind: "activateCapture" });
        emitted.push(...state.outbox.map((command) => command.action));
      }
      // `stopping` already has the stop in flight, so it must not re-send.
      expect([phase, emitted]).toEqual([phase, phase === "stopping" ? [] : ["stopCapture"]]);
      expect([phase, state.capture]).toEqual([phase, "stopping"]);
    }
  });

  test("a start the server has not confirmed can neither restart nor stop", () => {
    const pending = reduce(online(), { kind: "activateCapture" });
    expect(pending.startRequested).toBe(true);
    const again = reduce(pending, { kind: "activateCapture" });
    expect(again.outbox).toEqual([]);
    expect(again.capture).toBe("starting");
    expect(again.stopRequested).toBe(false);

    // Once the server confirms the phase, Stop becomes legal immediately.
    const confirmed = reduce(again, serverEvent(CAPTURE_STARTING));
    expect(reduce(confirmed, { kind: "activateCapture" }).outbox).toEqual([{ action: "stopCapture" }]);
  });

  test("startCapture carries the wire spelling meeting_id and nothing else", () => {
    const state = reduce(run([{ kind: "selectMeeting", meetingId: 101 }], online()), { kind: "activateCapture" });
    expect(state.outbox).toEqual([{ action: "startCapture", meeting_id: 101 }]);
  });

  test("startCapture omits meeting_id when no meeting is prepared", () => {
    expect(reduce(online(), { kind: "activateCapture" }).outbox).toEqual([{ action: "startCapture" }]);
  });

  test("stopCapture carries no payload", () => {
    expect(reduce(live(), { kind: "activateCapture" }).outbox).toEqual([{ action: "stopCapture" }]);
  });

  test("Stop stays truthful: a stop request alone never claims capture ended", () => {
    const state = reduce(live(), { kind: "activateCapture" });
    expect(state.name).toBe("capture-stopping");
    expect(state.capture).toBe("stopping");
    expect(state.stopRequested).toBe(true);
    // Only the authoritative idle snapshot may end capture.
    expect(reduce(state, { kind: "transport", status: "closed" }).capture).toBe("stopping");
    expect(reduce(state, serverEvent(CAPTURE_IDLE)).capture).toBe("idle");
  });

  test("start failure moves to capture-error and clears the pending request", () => {
    const state = run([{ kind: "activateCapture" }, { kind: "captureFailed", reason: "mic busy" }], online());
    expect(state.name).toBe("capture-error");
    expect(state.capture).toBe("error");
    expect(state.lastError).toEqual({ scope: "capture", reason: "mic busy" });
    expect(state.startRequested).toBe(false);
  });

  test("a stale capture error is cleared by the next authoritative capture snapshot", () => {
    const errored = run([{ kind: "activateCapture" }, { kind: "captureFailed", reason: "mic busy" }], online());
    const recovered = reduce(errored, serverEvent(CAPTURE_LIVE));
    expect(recovered.name).toBe("capture-live");
    expect(recovered.lastError).toBeNull();
  });

  test("capture-error is also clearable by an explicit dismissal", () => {
    const errored = run([{ kind: "captureFailed", reason: "mic busy" }], online());
    const dismissed = reduce(errored, { kind: "dismissError" });
    expect(dismissed.name).toBe("idle-library");
    expect(dismissed.lastError).toBeNull();
  });

  test("activating capture from capture-error retries once and clears the error", () => {
    const errored = run([{ kind: "captureFailed", reason: "mic busy" }], online());
    const retried = reduce(errored, { kind: "activateCapture" });
    expect(retried.name).toBe("capture-starting");
    expect(retried.lastError).toBeNull();
    expect(retried.outbox).toEqual([{ action: "startCapture" }]);
  });

  test("phase-less capture messages map compatibly", () => {
    expect(run([serverEvent(CAPTURE_LIVE_NO_PHASE)], online()).capture).toBe("capturing");
    expect(run([serverEvent(CAPTURE_IDLE_NO_PHASE)], live()).capture).toBe("idle");
  });

  test("capture timer origin comes only from the server startedAt payload", () => {
    const state = live();
    expect(state.captureStartedAt).toBe(T0 - 125_000);
    expect(run([serverEvent(CAPTURE_IDLE)], state).captureStartedAt).toBeNull();
  });

  test("switching-model is a capture phase, not a hidden idle", () => {
    const state = run([serverEvent({ type: "capture", capturing: true, mode: "mic", phase: "switching-model", startedAt: T0 })], live());
    expect(state.capture).toBe("switching-model");
    expect(state.name).toBe("capture-live");
  });
});

// ── 6. connection, reconnect and restore ────────────────────────────────────

describe("connection and restore", () => {
  test("startup hydrates only after the first authoritative capture snapshot", () => {
    const connecting = reduce(initialUiState(), { kind: "transport", status: "connecting" });
    expect(connecting.name).toBe("startup");
    expect(connecting.hydrated).toBe(false);

    const opened = reduce(connecting, { kind: "transport", status: "open" });
    expect(opened.name).toBe("startup");
    expect(opened.hydrated).toBe(false);

    const hydrated = reduce(opened, serverEvent(CAPTURE_IDLE));
    expect(hydrated.hydrated).toBe(true);
    expect(hydrated.name).toBe("idle-library");
  });

  test("pre-hydration slide and transcript frames are ignored", () => {
    const opened = run([{ kind: "transport", status: "open" }]);
    const stale = reduce(opened, serverEvent({ type: "meetings", items: [] }));
    expect(stale.hydrated).toBe(false);
    expect(stale.name).toBe("startup");
  });

  test("transport loss during capture enters reconnect and preserves capture", () => {
    const dropped = reduce(live(), { kind: "transport", status: "closed" });
    expect(dropped.name).toBe("reconnect");
    expect(dropped.connection).toBe("reconnecting");
    expect(dropped.capture).toBe("capturing");
    expect(dropped.captureStartedAt).toBe(T0 - 125_000);
    expect(dropped.restore).toEqual({ name: "capture-live", meetingId: null });
  });

  test("reconnect restores the exact capture substate the server reports", () => {
    const dropped = reduce(live(), { kind: "transport", status: "closed" });
    const reopened = reduce(dropped, { kind: "transport", status: "open" });
    expect(reopened.name).toBe("reconnect");
    expect(reopened.connection).toBe("connecting");

    const restored = reduce(reopened, serverEvent(CAPTURE_LIVE));
    expect(restored.name).toBe("capture-live");
    expect(restored.connection).toBe("online");
    expect(restored.restore).toBeNull();
  });

  test("reconnect that returns an idle server is honoured, not overridden by the old capture", () => {
    const dropped = reduce(live(), { kind: "transport", status: "closed" });
    const restored = run([{ kind: "transport", status: "open" }, serverEvent(CAPTURE_IDLE)], dropped);
    expect(restored.name).toBe("idle-live");
    expect(restored.capture).toBe("idle");
    expect(restored.captureStartedAt).toBeNull();
  });

  test("reconnect during a pending stop keeps the stop pending and re-sends it once", () => {
    const stopping = reduce(live(), { kind: "activateCapture" });
    const dropped = reduce(stopping, { kind: "transport", status: "closed" });
    expect(dropped.capture).toBe("stopping");
    expect(dropped.stopRequested).toBe(true);

    const reopened = reduce(dropped, { kind: "transport", status: "open" });
    expect(reopened.outbox).toEqual([{ action: "stopCapture" }]);

    const still = reduce(reopened, serverEvent(CAPTURE_STOPPING));
    expect(still.name).toBe("capture-stopping");
    expect(reduce(still, serverEvent(CAPTURE_IDLE)).name).toBe("idle-live");
  });

  test("reconnect from every capture substate is deterministic", () => {
    const substates: Array<[UiState, string]> = [
      [run([{ kind: "activateCapture" }], online()), "starting"],
      [live(), "capturing"],
      [run([{ kind: "activateCapture" }], live()), "stopping"],
    ];
    for (const [seed, phase] of substates) {
      const dropped = reduce(seed, { kind: "transport", status: "closed" });
      expect([phase, dropped.name]).toEqual([phase, "reconnect"]);
      expect([phase, dropped.capture]).toEqual([phase, phase]);
      const back = run([{ kind: "transport", status: "open" }, serverEvent(CAPTURE_LIVE)], dropped);
      expect([phase, back.name]).toEqual([phase, "capture-live"]);
    }
  });

  test("capture activation is refused while the transport is not online", () => {
    for (const offline of [
      reduce(live(), { kind: "transport", status: "closed" }),
      run([{ kind: "transport", status: "closed" }, { kind: "transport", status: "open" }], live()),
      reduce(live(), { kind: "transport", status: "error" }),
      reduce(initialUiState(), { kind: "transport", status: "open" }),
    ]) {
      const activated = reduce(offline, { kind: "activateCapture" });
      expect(activated.outbox).toEqual([]);
      expect(activated.capture).toBe(offline.capture);
      expect(activated.stopRequested).toBe(offline.stopRequested);

      // No outbound command may be issued over a transport that cannot deliver it.
      const selected = reduce(offline, { kind: "selectMeeting", meetingId: 101 });
      expect(selected.outbox).toEqual([]);
      expect(selected.selectedMeetingId).toBe(offline.selectedMeetingId);
    }
  });

  test("transport error surfaces a typed error without inventing an idle capture", () => {
    const failed = reduce(live(), { kind: "transport", status: "error" });
    expect(failed.connection).toBe("error");
    expect(failed.capture).toBe("capturing");
    expect(failed.lastError).toEqual({ scope: "transport", reason: "connection-error" });
    // A dead socket is never presented as a live capture.
    expect(failed.name).toBe("reconnect");
  });

  test("no state below `online` is ever named as a settled surface", () => {
    for (const status of ["connecting", "closed", "error"] as const) {
      for (const seed of [online(), live(), run([{ kind: "activateCapture" }], live())]) {
        expect([status, reduce(seed, { kind: "transport", status }).name]).toEqual([status, "reconnect"]);
      }
    }
  });

  test("an authoritative snapshot after a transport error restores the online surface", () => {
    const failed = reduce(live(), { kind: "transport", status: "error" });
    const recovered = reduce(failed, serverEvent(CAPTURE_LIVE));
    expect(recovered.connection).toBe("online");
    expect(recovered.name).toBe("capture-live");
    expect(recovered.lastError).toBeNull();
  });

  test("a transport error is cleared once the socket is online again", () => {
    const failed = reduce(live(), { kind: "transport", status: "error" });
    const back = run([{ kind: "transport", status: "open" }, serverEvent(CAPTURE_LIVE)], failed);
    expect(back.lastError).toBeNull();
    expect(back.connection).toBe("online");
  });
});

// ── 7. meeting selection, preview and jobs ─────────────────────────────────

describe("meeting selection and preview", () => {
  test("selecting a meeting enters meeting-switching and emits selectMeeting", () => {
    const state = reduce(online(), { kind: "selectMeeting", meetingId: 101 });
    expect(state.name).toBe("meeting-switching");
    expect(state.outbox).toEqual([{ action: "selectMeeting", meetingId: 101 }]);
    expect(state.selectedMeetingId).toBe(101);
  });

  test("the matching detail resolves the switch, an out-of-order one does not", () => {
    const switching = reduce(online(), { kind: "selectMeeting", meetingId: 102 });
    const stale = reduce(switching, serverEvent(MEETING_101));
    expect(stale.name).toBe("meeting-switching");
    expect(stale.loadedMeetingId).toBeNull();

    const fresh = reduce(stale, serverEvent(MEETING_102));
    expect(fresh.name).toBe("idle-library");
    expect(fresh.loadedMeetingId).toBe(102);
  });

  test("rapid selection keeps only the newest request and one action per selection", () => {
    let state = online();
    const emitted: Array<Record<string, unknown>> = [];
    for (const id of [101, 102, 101]) {
      state = reduce(state, { kind: "selectMeeting", meetingId: id });
      emitted.push(...state.outbox);
    }
    expect(emitted).toEqual([
      { action: "selectMeeting", meetingId: 101 },
      { action: "selectMeeting", meetingId: 102 },
      { action: "selectMeeting", meetingId: 101 },
    ]);
    expect(state.selectedMeetingId).toBe(101);
    // The in-flight answer for 102 must not win.
    expect(reduce(state, serverEvent(MEETING_102)).loadedMeetingId).toBeNull();
  });

  test("re-selecting the meeting already in flight does not re-emit", () => {
    const first = reduce(online(), { kind: "selectMeeting", meetingId: 101 });
    const again = reduce(first, { kind: "selectMeeting", meetingId: 101 });
    expect(again.outbox).toEqual([]);
    expect(again.name).toBe("meeting-switching");
  });

  test("returning to the library clears the selection", () => {
    const loaded = run([{ kind: "selectMeeting", meetingId: 101 }, serverEvent(MEETING_101)], online());
    const back = reduce(loaded, { kind: "returnToLibrary" });
    expect(back.name).toBe("idle-library");
    expect(back.selectedMeetingId).toBeNull();
    expect(back.loadedMeetingId).toBeNull();
  });

  test("history preview suspends live follow and exits back to the live state", () => {
    const preview = reduce(live(), { kind: "previewSlide", index: 2 });
    expect(preview.name).toBe("history-preview");
    expect(preview.preview).toEqual({ index: 2 });
    expect(preview.capture).toBe("capturing");

    const exited = reduce(preview, { kind: "exitPreview" });
    expect(exited.name).toBe("capture-live");
    expect(exited.preview).toBeNull();
  });

  test("preview survives live slide traffic and ends on authoritative idle", () => {
    const preview = reduce(live(), { kind: "previewSlide", index: 2 });
    const stillPreview = reduce(preview, serverEvent({ type: "slide", current: null, history: [] }));
    expect(stillPreview.name).toBe("history-preview");

    const stopped = reduce(stillPreview, serverEvent(CAPTURE_IDLE));
    expect(stopped.capture).toBe("idle");
    expect(stopped.name).toBe("history-preview");
    expect(reduce(stopped, { kind: "exitPreview" }).name).toBe("idle-live");
  });

  test("idle-live is the just-ended meeting shell, distinct from the library", () => {
    const justEnded = run([serverEvent(CAPTURE_IDLE)], live());
    expect(justEnded.name).toBe("idle-live");
    expect(justEnded.shell).toBe("live");
    expect(reduce(justEnded, { kind: "returnToLibrary" }).name).toBe("idle-library");
  });
});

describe("compile jobs", () => {
  const withMeeting = (): UiState =>
    run([{ kind: "selectMeeting", meetingId: 101 }, serverEvent(MEETING_101)], online());

  test("started → progress → success walks compile-running to compile-complete", () => {
    const state = withMeeting();
    const seen = names([
      serverEvent({ type: "compile", status: "started", jobId: COMPILE_JOB, meetingId: 101 }),
      serverEvent({ type: "compile", status: "progress", jobId: COMPILE_JOB, meetingId: 101, completed: 2, total: 6 }),
      serverEvent({ type: "compile", status: "success", jobId: COMPILE_JOB, meetingId: 101, path: "/tmp/a.pptx" }),
    ], state);
    expect(seen).toEqual(["compile-running", "compile-running", "compile-complete"]);
  });

  test("a compile answer for a superseded job is ignored", () => {
    const running = reduce(
      withMeeting(),
      serverEvent({ type: "compile", status: "started", jobId: COMPILE_JOB, meetingId: 101 }),
    );
    const stale = reduce(
      running,
      serverEvent({ type: "compile", status: "success", jobId: "compile-old-0000", meetingId: 101, path: "/tmp/old.pptx" }),
    );
    expect(stale.name).toBe("compile-running");
    expect(stale.activeJobId).toBe(COMPILE_JOB);
  });

  test("compile failure records a typed error and releases the job", () => {
    const running = reduce(
      withMeeting(),
      serverEvent({ type: "compile", status: "started", jobId: COMPILE_JOB, meetingId: 101 }),
    );
    const failed = reduce(running, serverEvent({ type: "compile", status: "error", jobId: COMPILE_JOB, meetingId: 101, error: "compile failed" }));
    expect(failed.activeJobId).toBeNull();
    expect(failed.completedJobId).toBeNull();
    expect(failed.lastError).toEqual({ scope: "compile", reason: "compile failed" });
    expect(failed.name).toBe("idle-library");
  });

  test("compile never blocks Stop", () => {
    const running = reduce(live(), serverEvent({ type: "compile", status: "started", jobId: COMPILE_JOB, meetingId: 101 }));
    expect(running.name).toBe("compile-running");
    const stopping = reduce(running, { kind: "activateCapture" });
    expect(stopping.outbox).toEqual([{ action: "stopCapture" }]);
    expect(stopping.capture).toBe("stopping");
  });

  test("a compile job started before a reconnect is dropped, not left spinning", () => {
    const running = reduce(withMeeting(), serverEvent({ type: "compile", status: "started", jobId: COMPILE_JOB, meetingId: 101 }));
    const dropped = reduce(running, { kind: "transport", status: "closed" });
    expect(dropped.activeJobId).toBeNull();
    expect(dropped.name).toBe("reconnect");
  });
});

// ── 8. determinism ─────────────────────────────────────────────────────────

describe("determinism", () => {
  const script: UiEvent[] = [
    { kind: "transport", status: "connecting" },
    { kind: "transport", status: "open" },
    serverEvent(CAPTURE_IDLE),
    serverEvent(MEETINGS),
    { kind: "selectMeeting", meetingId: 101 },
    serverEvent(MEETING_101),
    { kind: "activateCapture" },
    serverEvent(CAPTURE_STARTING),
    serverEvent(CAPTURE_LIVE),
    { kind: "previewSlide", index: 2 },
    { kind: "exitPreview" },
    { kind: "transport", status: "closed" },
    { kind: "transport", status: "open" },
    serverEvent(CAPTURE_LIVE),
    { kind: "activateCapture" },
    serverEvent(CAPTURE_STOPPING),
    serverEvent(CAPTURE_IDLE),
    { kind: "malformed", reason: "bad frame" },
    { kind: "dismissError" },
  ];

  test("the same sequence yields byte-identical state five times", () => {
    const results = Array.from({ length: 5 }, () => JSON.stringify(reduceAll(initialUiState(), script)));
    expect(new Set(results).size).toBe(1);
  });

  test("the visited state names are stable", () => {
    expect(names(script)).toEqual(names(script));
    const visited = names(script);
    expect(visited[visited.length - 1]).toBe("idle-live");
  });

  test("reduceAll equals a manual fold", () => {
    let manual = initialUiState();
    for (const event of script) manual = reduce(manual, event);
    expect(JSON.stringify(reduceAll(initialUiState(), script))).toBe(JSON.stringify(manual));
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function sampleBodyFor(type: string): Record<string, unknown> {
  switch (type) {
    case "slide":
      return { current: null, history: [] };
    case "caption":
      return { text: "x", ts: T0 };
    case "line":
      return { text: "x", ts: T0 };
    case "transcript":
      return { entries: [] };
    case "status":
      return { text: "x" };
    case "capture":
      return { capturing: false, mode: "mic" };
    case "detect":
      return { detecting: true };
    case "providers":
      return { list: [], current: "codex" };
    case "sttModels":
      return { models: [], selectedModelId: null };
    case "meetings":
      return { items: [] };
    case "meeting":
      return { meetingId: 101, title: "x", transcript: [], current: null, history: [], compiled: null };
    case "attendees":
      return { meeting_id: 101, attendees: [] };
    case "review":
      return { reviewId: "r1", transcriptVersionId: "v1", attendees: [], transcript: { lines: [] }, items: [] };
    case "saved":
      return { path: "/tmp/x.md" };
    case "compile":
      return { status: "started", jobId: COMPILE_JOB };
    case "export":
      return { status: "started", action: "exportPdf", jobId: "pdf-1" };
    case "ask":
      return { requestId: "a1", answer: "x", matchedCount: 0 };
    default:
      return {};
  }
}
