// Emits the complete observed transition table: every canonical state seed x
// every event kind -> resulting state name. Temporary QA artifact.
import { initialUiState, parseServerEvent, reduce, reduceAll, type UiEvent, type UiState, type UiStateName } from "../../../../../public/ui-state-machine.ts";
const T0 = 1_710_376_860_000;
const S = (m: unknown): UiEvent => { const p = parseServerEvent(m); if (!p.ok) throw new Error(p.error.reason); return p.event; };
const IDLE = S({ type: "capture", capturing: false, mode: "mic", phase: "idle" });
const STARTING = S({ type: "capture", capturing: false, mode: "mic", phase: "starting" });
const LIVE = S({ type: "capture", capturing: true, mode: "mic", phase: "capturing", startedAt: T0 - 125_000 });
const STOPPING = S({ type: "capture", capturing: true, mode: "mic", phase: "stopping", startedAt: T0 - 125_000 });
const MEETING = S({ type: "meeting", meetingId: 101, title: "x", transcript: [], current: null, history: [], compiled: null });
const OPEN: UiEvent = { kind: "transport", status: "open" };
const online = (): UiState => reduceAll(initialUiState(), [OPEN, IDLE]);
const live = (): UiState => reduceAll(initialUiState(), [OPEN, LIVE]);
const seeds: Array<[UiStateName, UiState]> = [
  ["startup", initialUiState()],
  ["idle-library", online()],
  ["idle-live", reduceAll(live(), [IDLE])],
  ["capture-starting", reduceAll(online(), [{ kind: "activateCapture" }, STARTING])],
  ["capture-live", live()],
  ["capture-stopping", reduceAll(live(), [{ kind: "activateCapture" }])],
  ["capture-error", reduceAll(online(), [{ kind: "captureFailed", reason: "mic busy" }])],
  ["reconnect", reduceAll(live(), [{ kind: "transport", status: "closed" }])],
  ["meeting-switching", reduceAll(online(), [{ kind: "selectMeeting", meetingId: 101 }])],
  ["history-preview", reduceAll(live(), [{ kind: "previewSlide", index: 2 }])],
  ["compile-running", reduceAll(online(), [S({ type: "compile", status: "started", jobId: "compile-1" })])],
  ["compile-complete", reduceAll(online(), [S({ type: "compile", status: "started", jobId: "compile-1" }), S({ type: "compile", status: "success", jobId: "compile-1" })])],
];
const events: Array<[string, UiEvent]> = [
  ["transport:connecting", { kind: "transport", status: "connecting" }],
  ["transport:open", OPEN],
  ["transport:closed", { kind: "transport", status: "closed" }],
  ["transport:error", { kind: "transport", status: "error" }],
  ["activateCapture", { kind: "activateCapture" }],
  ["captureFailed", { kind: "captureFailed", reason: "mic busy" }],
  ["selectMeeting:101", { kind: "selectMeeting", meetingId: 101 }],
  ["returnToLibrary", { kind: "returnToLibrary" }],
  ["previewSlide:2", { kind: "previewSlide", index: 2 }],
  ["exitPreview", { kind: "exitPreview" }],
  ["dismissError", { kind: "dismissError" }],
  ["malformed", { kind: "malformed", reason: "bad frame" }],
  ["server:capture idle", IDLE],
  ["server:capture starting", STARTING],
  ["server:capture capturing", LIVE],
  ["server:capture stopping", STOPPING],
  ["server:meeting 101", MEETING],
  ["server:compile started", S({ type: "compile", status: "started", jobId: "compile-1" })],
  ["server:compile success", S({ type: "compile", status: "success", jobId: "compile-1" })],
  ["server:compile error", S({ type: "compile", status: "error", jobId: "compile-1", error: "nope" })],
  ["server:status", S({ type: "status", text: "x" })],
];
console.log(`| from \\ event | ${events.map(([n]) => n).join(" | ")} |`);
console.log(`| --- | ${events.map(() => "---").join(" | ")} |`);
for (const [name, seed] of seeds) {
  if (seed.name !== name) throw new Error(`seed mismatch: expected ${name}, got ${seed.name}`);
  const cells = events.map(([, e]) => {
    const next = reduce(seed, e);
    const out = next.outbox.map((c) => c.action).join("+");
    return out ? `${next.name} (${out})` : next.name;
  });
  console.log(`| ${name} | ${cells.join(" | ")} |`);
}
