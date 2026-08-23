// Audits the full seed x event product for command/state truthfulness.
import { initialUiState, parseServerEvent, reduce, reduceAll, type UiEvent, type UiState } from "../../../../../public/ui-state-machine.ts";
const T0 = 1_710_376_860_000;
const S = (m: unknown): UiEvent => { const p = parseServerEvent(m); if (!p.ok) throw new Error(p.error.reason); return p.event; };
const IDLE = S({ type: "capture", capturing: false, mode: "mic", phase: "idle" });
const LIVE = S({ type: "capture", capturing: true, mode: "mic", phase: "capturing", startedAt: T0 - 125_000 });
const STARTING = S({ type: "capture", capturing: false, mode: "mic", phase: "starting" });
const STOPPING = S({ type: "capture", capturing: true, mode: "mic", phase: "stopping", startedAt: T0 });
const OPEN: UiEvent = { kind: "transport", status: "open" };
const online = () => reduceAll(initialUiState(), [OPEN, IDLE]);
const live = () => reduceAll(initialUiState(), [OPEN, LIVE]);
const seeds: UiState[] = [
  initialUiState(), online(), reduceAll(live(), [IDLE]),
  reduceAll(online(), [{ kind: "activateCapture" }, STARTING]), live(),
  reduceAll(live(), [{ kind: "activateCapture" }]),
  reduceAll(online(), [{ kind: "captureFailed", reason: "x" }]),
  reduceAll(live(), [{ kind: "transport", status: "closed" }]),
  reduceAll(live(), [{ kind: "transport", status: "error" }]),
  reduceAll(online(), [{ kind: "selectMeeting", meetingId: 101 }]),
  reduceAll(live(), [{ kind: "previewSlide", index: 2 }]),
  reduceAll(online(), [S({ type: "compile", status: "started", jobId: "c-1" })]),
  reduceAll(online(), [S({ type: "compile", status: "started", jobId: "c-1" }), S({ type: "compile", status: "success", jobId: "c-1" })]),
];
const events: UiEvent[] = [
  { kind: "transport", status: "connecting" }, OPEN, { kind: "transport", status: "closed" }, { kind: "transport", status: "error" },
  { kind: "activateCapture" }, { kind: "captureFailed", reason: "x" }, { kind: "selectMeeting", meetingId: 101 },
  { kind: "returnToLibrary" }, { kind: "previewSlide", index: 2 }, { kind: "exitPreview" }, { kind: "dismissError" },
  { kind: "malformed", reason: "x" }, IDLE, STARTING, LIVE, STOPPING,
  S({ type: "meeting", meetingId: 101, title: "x", transcript: [], current: null, history: [], compiled: null }),
  S({ type: "compile", status: "started", jobId: "c-1" }), S({ type: "compile", status: "success", jobId: "c-1" }),
  S({ type: "compile", status: "error", jobId: "c-1", error: "nope" }), S({ type: "status", text: "x" }),
];
let cells = 0; const violations: string[] = [];
for (const seed of seeds) for (const e of events) {
  const n = reduce(seed, e); cells++;
  if (n.outbox.length > 0 && n.connection !== "online" && !(e.kind === "transport" && e.status === "open")) {
    violations.push(`command over non-online transport: ${seed.name} + ${JSON.stringify(e)} -> ${n.name} ${JSON.stringify(n.outbox)}`);
  }
  if (n.connection !== "online" && n.hydrated && n.name !== "reconnect") {
    violations.push(`settled name over non-online transport: ${seed.name} + ${JSON.stringify(e)} -> ${n.name}`);
  }
  if (n.capture === "idle" && n.captureStartedAt !== null) violations.push(`idle with timer origin: ${seed.name} + ${JSON.stringify(e)}`);
  if (!Object.isFrozen(n) || !Object.isFrozen(n.outbox)) violations.push(`unfrozen result: ${seed.name} + ${JSON.stringify(e)}`);
  if (n.outbox.filter((c) => c.action === "startCapture").length > 1) violations.push(`duplicate startCapture: ${seed.name}`);
  if (n.outbox.filter((c) => c.action === "stopCapture").length > 1) violations.push(`duplicate stopCapture: ${seed.name}`);
}
console.log(`audited ${cells} (seed x event) cells across ${seeds.length} seeds and ${events.length} events`);
console.log(violations.length === 0 ? "violations: none" : violations.join("\n"));
