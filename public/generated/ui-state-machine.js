// GENERATED FILE - DO NOT EDIT.
// Source: public/ui-state-machine.ts
// Generator: scripts/build-public-modules.ts
// Rebuild: bun run scripts/build-public-modules.ts
import { isKnownMessageType } from "./protocol-values.js";
const CAPTURE_PHASES = ["idle", "starting", "capturing", "stopping", "switching-model"];
const COMPILE_STATUSES = ["started", "progress", "success", "error", "timeout"];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(reason) {
  return { ok: false, error: { reason } };
}
function parseCapturePhase(raw, capturing) {
  if (raw === undefined)
    return capturing ? "capturing" : "idle";
  if (typeof raw !== "string" || !CAPTURE_PHASES.includes(raw))
    return null;
  if (raw === "idle" || raw === "starting" || raw === "capturing" || raw === "stopping")
    return raw;
  return "switching-model";
}
export function parseServerEvent(raw) {
  if (!isRecord(raw))
    return fail("frame is not an object");
  const type = raw["type"];
  if (typeof type !== "string")
    return fail("frame has no string type");
  if (!isKnownMessageType(type))
    return fail(`unknown message type: ${type}`);
  if (type === "capture") {
    const capturing = raw["capturing"];
    if (typeof capturing !== "boolean")
      return fail("capture.capturing is not a boolean");
    const mode = raw["mode"];
    if (typeof mode !== "string")
      return fail("capture.mode is not a string");
    const phase = parseCapturePhase(raw["phase"], capturing);
    if (phase === null)
      return fail("capture.phase is not a declared phase");
    const startedAtRaw = raw["startedAt"];
    const startedAt = typeof startedAtRaw === "number" && Number.isFinite(startedAtRaw) && startedAtRaw > 0 ? startedAtRaw : null;
    return {
      ok: true,
      event: { kind: "server", message: "capture", snapshot: { capturing, mode, phase, startedAt } }
    };
  }
  if (type === "meetings") {
    const items = raw["items"];
    if (!Array.isArray(items))
      return fail("meetings.items is not an array");
    return { ok: true, event: { kind: "server", message: "meetings", count: items.length } };
  }
  if (type === "meeting") {
    const meetingId = raw["meetingId"];
    if (typeof meetingId !== "number" || !Number.isFinite(meetingId)) {
      return fail("meeting.meetingId is not a number");
    }
    return { ok: true, event: { kind: "server", message: "meeting", meetingId } };
  }
  if (type === "compile") {
    const status = raw["status"];
    if (typeof status !== "string" || !COMPILE_STATUSES.includes(status)) {
      return fail("compile.status is not a declared status");
    }
    const jobId = raw["jobId"];
    if (typeof jobId !== "string" || jobId.length === 0)
      return fail("compile.jobId is not a string");
    const errorRaw = raw["error"];
    const error = typeof errorRaw === "string" ? errorRaw : null;
    return {
      ok: true,
      event: {
        kind: "server",
        message: "compile",
        status,
        jobId,
        error
      }
    };
  }
  return { ok: true, event: { kind: "server", message: "other", type } };
}
function nameOf(draft) {
  if (!draft.hydrated)
    return "startup";
  if (draft.connection !== "online")
    return "reconnect";
  if (draft.activeJobId !== null)
    return "compile-running";
  if (draft.completedJobId !== null)
    return "compile-complete";
  if (draft.preview !== null)
    return "history-preview";
  if (draft.capture === "error")
    return "capture-error";
  if (draft.capture === "starting")
    return "capture-starting";
  if (draft.capture === "stopping")
    return "capture-stopping";
  if (draft.capture === "capturing" || draft.capture === "switching-model")
    return "capture-live";
  if (draft.selectedMeetingId !== null && draft.selectedMeetingId !== draft.loadedMeetingId) {
    return "meeting-switching";
  }
  if (draft.shell === "live")
    return "idle-live";
  return "idle-library";
}
function freeze(draft) {
  const state = {
    name: nameOf(draft),
    connection: draft.connection,
    capture: draft.capture,
    shell: draft.shell,
    hydrated: draft.hydrated,
    captureStartedAt: draft.captureStartedAt,
    mode: draft.mode,
    startRequested: draft.startRequested,
    stopRequested: draft.stopRequested,
    selectedMeetingId: draft.selectedMeetingId,
    loadedMeetingId: draft.loadedMeetingId,
    preview: draft.preview === null ? null : Object.freeze({ ...draft.preview }),
    activeJobId: draft.activeJobId,
    completedJobId: draft.completedJobId,
    lastError: draft.lastError === null ? null : Object.freeze({ ...draft.lastError }),
    restore: draft.restore === null ? null : Object.freeze({ ...draft.restore }),
    outbox: Object.freeze(draft.outbox.map((command) => Object.freeze({ ...command })))
  };
  return Object.freeze(state);
}
function draftOf(state) {
  return {
    connection: state.connection,
    capture: state.capture,
    shell: state.shell,
    hydrated: state.hydrated,
    captureStartedAt: state.captureStartedAt,
    mode: state.mode,
    startRequested: state.startRequested,
    stopRequested: state.stopRequested,
    selectedMeetingId: state.selectedMeetingId,
    loadedMeetingId: state.loadedMeetingId,
    preview: state.preview,
    activeJobId: state.activeJobId,
    completedJobId: state.completedJobId,
    lastError: state.lastError,
    restore: state.restore,
    outbox: []
  };
}
export function initialUiState() {
  return freeze({
    connection: "booting",
    capture: "idle",
    shell: "library",
    hydrated: false,
    captureStartedAt: null,
    mode: "mic",
    startRequested: false,
    stopRequested: false,
    selectedMeetingId: null,
    loadedMeetingId: null,
    preview: null,
    activeJobId: null,
    completedJobId: null,
    lastError: null,
    restore: null,
    outbox: []
  });
}
function isCaptureActive(capture) {
  return capture === "starting" || capture === "capturing" || capture === "stopping" || capture === "switching-model";
}
function clearErrorScope(draft, scope) {
  if (draft.lastError !== null && draft.lastError.scope === scope)
    draft.lastError = null;
}
function applyTransport(draft, status) {
  if (status === "connecting") {
    draft.connection = "connecting";
    return;
  }
  if (status === "open") {
    clearErrorScope(draft, "transport");
    draft.connection = "connecting";
    if (draft.hydrated && draft.stopRequested)
      draft.outbox = [{ action: "stopCapture" }];
    return;
  }
  if (status === "closed") {
    draft.connection = "reconnecting";
    draft.activeJobId = null;
    draft.completedJobId = null;
    if (draft.hydrated) {
      draft.restore = {
        name: isCaptureActive(draft.capture) ? "capture-live" : draft.shell === "live" ? "idle-live" : "idle-library",
        meetingId: draft.loadedMeetingId
      };
    }
    return;
  }
  draft.connection = "error";
  draft.activeJobId = null;
  draft.completedJobId = null;
  draft.lastError = { scope: "transport", reason: "connection-error" };
}
function applyCaptureSnapshot(draft, snapshot) {
  draft.hydrated = true;
  draft.connection = "online";
  draft.restore = null;
  draft.mode = snapshot.mode;
  draft.capture = snapshot.phase;
  clearErrorScope(draft, "capture");
  clearErrorScope(draft, "transport");
  if (snapshot.phase === "idle") {
    draft.captureStartedAt = null;
    draft.startRequested = false;
    draft.stopRequested = false;
    return;
  }
  draft.captureStartedAt = snapshot.startedAt;
  draft.startRequested = false;
  draft.shell = "live";
  if (snapshot.phase === "stopping")
    draft.stopRequested = true;
}
function applyActivateCapture(draft) {
  if (draft.startRequested)
    return;
  if (draft.capture === "capturing" || draft.capture === "switching-model" || draft.capture === "starting") {
    if (draft.stopRequested)
      return;
    draft.stopRequested = true;
    draft.capture = "stopping";
    draft.outbox = [{ action: "stopCapture" }];
    return;
  }
  if (draft.capture === "stopping")
    return;
  clearErrorScope(draft, "capture");
  draft.startRequested = true;
  draft.capture = "starting";
  draft.shell = "live";
  draft.outbox = draft.selectedMeetingId === null ? [{ action: "startCapture" }] : [{ action: "startCapture", meeting_id: draft.selectedMeetingId }];
}
function applyCompile(draft, status, jobId, error) {
  if (status === "started" || status === "progress") {
    draft.activeJobId = jobId;
    draft.completedJobId = null;
    clearErrorScope(draft, "compile");
    return;
  }
  if (draft.activeJobId !== null && draft.activeJobId !== jobId)
    return;
  draft.activeJobId = null;
  if (status === "success") {
    draft.completedJobId = jobId;
    clearErrorScope(draft, "compile");
    return;
  }
  draft.completedJobId = null;
  draft.lastError = {
    scope: "compile",
    reason: error ?? (status === "timeout" ? "compile-timeout" : "compile-failed")
  };
}
export function reduce(state, event) {
  const draft = draftOf(state);
  switch (event.kind) {
    case "transport":
      applyTransport(draft, event.status);
      break;
    case "server":
      switch (event.message) {
        case "capture":
          applyCaptureSnapshot(draft, event.snapshot);
          break;
        case "meeting":
          if (draft.hydrated && draft.selectedMeetingId === event.meetingId) {
            draft.loadedMeetingId = event.meetingId;
            draft.shell = isCaptureActive(draft.capture) ? draft.shell : "library";
          }
          break;
        case "meetings":
          break;
        case "compile":
          if (draft.hydrated)
            applyCompile(draft, event.status, event.jobId, event.error);
          break;
        case "other":
          break;
        default: {
          const unreachable = event;
          return unreachable;
        }
      }
      break;
    case "activateCapture":
      if (draft.hydrated && draft.connection === "online")
        applyActivateCapture(draft);
      break;
    case "captureFailed":
      draft.capture = "error";
      draft.startRequested = false;
      draft.stopRequested = false;
      draft.captureStartedAt = null;
      draft.lastError = { scope: "capture", reason: event.reason };
      break;
    case "selectMeeting":
      if (draft.hydrated && draft.connection === "online" && draft.selectedMeetingId !== event.meetingId) {
        draft.selectedMeetingId = event.meetingId;
        draft.loadedMeetingId = null;
        draft.preview = null;
        draft.completedJobId = null;
        draft.outbox = [{ action: "selectMeeting", meetingId: event.meetingId }];
      }
      break;
    case "returnToLibrary":
      draft.selectedMeetingId = null;
      draft.loadedMeetingId = null;
      draft.preview = null;
      draft.completedJobId = null;
      if (!isCaptureActive(draft.capture))
        draft.shell = "library";
      break;
    case "previewSlide":
      draft.preview = { index: event.index };
      break;
    case "exitPreview":
      draft.preview = null;
      break;
    case "dismissError":
      draft.lastError = null;
      if (draft.capture === "error")
        draft.capture = "idle";
      break;
    case "malformed":
      draft.lastError = { scope: "protocol", reason: event.reason };
      break;
    default: {
      const unreachable = event;
      return unreachable;
    }
  }
  return freeze(draft);
}
export function reduceAll(state, events) {
  let current = state;
  for (const event of events)
    current = reduce(current, event);
  return current;
}
