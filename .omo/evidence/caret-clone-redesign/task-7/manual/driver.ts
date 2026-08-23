// Manual QA driver for plan Todo 7. Imports the real reducer module and drives
// four real journeys, printing the observable state after every event.
// Temporary: executed once, output captured in this directory, then deleted
// from any runtime location. Not a test and not shipped.
import {
  initialUiState,
  parseServerEvent,
  reduce,
  type UiEvent,
  type UiState,
} from "../../../../../public/ui-state-machine.ts";

const T0 = 1_710_376_860_000;

function server(message: unknown): UiEvent {
  const parsed = parseServerEvent(message);
  if (parsed.ok) return parsed.event;
  return { kind: "malformed", reason: parsed.error.reason };
}

function show(label: string, state: UiState): void {
  const outbox = state.outbox.map((c) => JSON.stringify(c)).join(",");
  console.log(
    [
      label.padEnd(34),
      `name=${state.name}`.padEnd(26),
      `conn=${state.connection}`.padEnd(20),
      `cap=${state.capture}`.padEnd(22),
      `shell=${state.shell}`.padEnd(13),
      `startedAt=${state.captureStartedAt ?? "-"}`.padEnd(24),
      `out=[${outbox}]`.padEnd(46),
      `err=${state.lastError ? `${state.lastError.scope}:${state.lastError.reason}` : "-"}`,
    ].join(" "),
  );
}

function journey(title: string, steps: Array<[string, UiEvent]>): void {
  console.log(`\n=== ${title} ===`);
  let state = initialUiState();
  show("(initial)", state);
  for (const [label, event] of steps) {
    state = reduce(state, event);
    show(label, state);
  }
}

const OPEN: UiEvent = { kind: "transport", status: "open" };
const IDLE = server({ type: "capture", capturing: false, mode: "mic", phase: "idle" });
const STARTING = server({ type: "capture", capturing: false, mode: "mic", phase: "starting" });
const LIVE = server({ type: "capture", capturing: true, mode: "mic", phase: "capturing", startedAt: T0 - 125_000 });
const STOPPING = server({ type: "capture", capturing: true, mode: "mic", phase: "stopping", startedAt: T0 - 125_000 });
const MEETINGS = server({ type: "meetings", items: [{ id: 101, title: "x", started_at: T0, status: "ended" }] });

journey("1. happy capture", [
  ["transport connecting", { kind: "transport", status: "connecting" }],
  ["transport open", OPEN],
  ["server capture idle", IDLE],
  ["server meetings", MEETINGS],
  ["user activates capture", { kind: "activateCapture" }],
  ["server capture starting", STARTING],
  ["server capture live", LIVE],
  ["user previews slide 2", { kind: "previewSlide", index: 2 }],
  ["user exits preview", { kind: "exitPreview" }],
]);

journey("2. reconnect during capture", [
  ["transport open", OPEN],
  ["server capture live", LIVE],
  ["socket closed", { kind: "transport", status: "closed" }],
  ["socket open again", OPEN],
  ["server re-asserts live", LIVE],
]);

journey("3. stop from live", [
  ["transport open", OPEN],
  ["server capture live", LIVE],
  ["user presses Stop", { kind: "activateCapture" }],
  ["user presses Stop again", { kind: "activateCapture" }],
  ["server capture stopping", STOPPING],
  ["trailing line arrives", server({ type: "line", text: "마지막 문장", ts: T0 })],
  ["server capture idle", IDLE],
  ["user returns to library", { kind: "returnToLibrary" }],
]);

console.log("\n=== 4. bad events at the parse boundary ===");
for (const bad of [
  null,
  "capture",
  { capturing: true },
  { type: "teleport" },
  { type: "capture", capturing: "yes", mode: "mic" },
  { type: "capture", capturing: true, mode: "mic", phase: "warping" },
  { type: "compile", status: "melted", jobId: "compile-1" },
]) {
  const parsed = parseServerEvent(bad);
  console.log(
    `${JSON.stringify(bad).padEnd(56)} ok=${parsed.ok} ${parsed.ok ? "" : `reason="${parsed.error.reason}"`}`,
  );
}

const beforeBad = reduce(reduce(initialUiState(), OPEN), LIVE);
const afterBad = reduce(beforeBad, { kind: "malformed", reason: "capture.capturing is not a boolean" });
console.log("\nstate before bad frame:", JSON.stringify({ name: beforeBad.name, capture: beforeBad.capture }));
console.log("state after  bad frame:", JSON.stringify({ name: afterBad.name, capture: afterBad.capture, err: afterBad.lastError }));
console.log("capture preserved across a bad frame:", beforeBad.capture === afterBad.capture);
