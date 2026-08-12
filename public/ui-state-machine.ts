// Canonical UI state machine for the operator surface.
//
// This module is the single source of truth for what the operator surface is
// currently doing. It is a pure reducer: given a frozen state and one typed
// event it returns a new frozen state. It never touches the DOM, a clock, the
// network, storage or an ambient global; every value that could vary between
// runs arrives inside an event payload. Rendering and transport live outside.
//
// The wire protocol is consumed exactly as `src/session.ts` declares it. No
// message type, action name or payload key is renamed here: `startCapture`
// still carries the snake_case `meeting_id`, `selectMeeting` still carries
// `meetingId`, and `phase` on a capture message stays optional.

// ── canonical state names ───────────────────────────────────────────────────

/**
 * The twelve canonical states of the operator surface. `name` is derived, never
 * assigned by a caller, so an illegal combination (for example "idle-library
 * while capturing") is unrepresentable.
 */
export type UiStateName =
  | "startup"
  | "reconnect"
  | "idle-library"
  | "idle-live"
  | "capture-starting"
  | "capture-live"
  | "capture-stopping"
  | "capture-error"
  | "meeting-switching"
  | "history-preview"
  | "compile-running"
  | "compile-complete";

/** Transport status as the client observes it; independent of capture. */
export type ConnectionState = "booting" | "connecting" | "online" | "reconnecting" | "error";

/** Capture phases exactly as `CaptureUpdate.phase` declares them, plus `error`. */
export type CaptureState = "idle" | "starting" | "capturing" | "stopping" | "switching-model" | "error";

/** Which shell the surface presents: the library, or the focused live workspace. */
export type ShellState = "library" | "live";

export type ErrorScope = "transport" | "protocol" | "capture" | "compile";

export interface UiError {
  readonly scope: ErrorScope;
  readonly reason: string;
}

/** Slide preview projection. `index` is the slide index the user pinned. */
export interface PreviewState {
  readonly index: number;
}

/**
 * What the surface must return to once the transport comes back. Captured on
 * disconnect so reconnect is deterministic instead of re-derived from whatever
 * frame happens to arrive first.
 */
export interface RestoreTarget {
  readonly name: UiStateName;
  readonly meetingId: number | null;
}

export interface UiState {
  readonly name: UiStateName;
  readonly connection: ConnectionState;
  readonly capture: CaptureState;
  readonly shell: ShellState;
  /** True once the first authoritative capture snapshot has been applied. */
  readonly hydrated: boolean;
  /** Server-provided capture origin. Never a locally sampled clock. */
  readonly captureStartedAt: number | null;
  /** Input mode the server reports (`mic`, `file`, ...). */
  readonly mode: string;
  /** A local start is pending until the server answers with a capture snapshot. */
  readonly startRequested: boolean;
  /** A local stop is pending until the server answers with an idle snapshot. */
  readonly stopRequested: boolean;
  readonly selectedMeetingId: number | null;
  readonly loadedMeetingId: number | null;
  readonly preview: PreviewState | null;
  readonly activeJobId: string | null;
  /** The compile job whose success is still being presented, if any. */
  readonly completedJobId: string | null;
  readonly lastError: UiError | null;
  readonly restore: RestoreTarget | null;
  /** Commands produced by the last reduction, in order. Never accumulated. */
  readonly outbox: readonly ClientCommand[];
}

// ── outbound commands (existing wire actions, unchanged) ────────────────────

export type ClientCommand =
  | { readonly action: "startCapture" }
  | { readonly action: "startCapture"; readonly meeting_id: number }
  | { readonly action: "stopCapture" }
  | { readonly action: "selectMeeting"; readonly meetingId: number };

// ── events ─────────────────────────────────────────────────────────────────

export type TransportStatus = "connecting" | "open" | "closed" | "error";

/** Capture snapshot, normalised from `CaptureUpdate` at the parse boundary. */
export interface CaptureSnapshot {
  readonly capturing: boolean;
  readonly mode: string;
  readonly phase: Exclude<CaptureState, "error">;
  readonly startedAt: number | null;
}

export type CompileStatus = "started" | "progress" | "success" | "error" | "timeout";

/**
 * Server frames the state machine actually reacts to. Every other declared
 * server message parses successfully and reduces to a no-op `other` event, so
 * an unknown-but-valid frame can never crash or silently corrupt the state.
 */
export type ServerEvent =
  | { readonly kind: "server"; readonly message: "capture"; readonly snapshot: CaptureSnapshot }
  | { readonly kind: "server"; readonly message: "meetings"; readonly count: number }
  | { readonly kind: "server"; readonly message: "meeting"; readonly meetingId: number }
  | {
      readonly kind: "server";
      readonly message: "compile";
      readonly status: CompileStatus;
      readonly jobId: string;
      readonly error: string | null;
    }
  | { readonly kind: "server"; readonly message: "other"; readonly type: string };

export type UiEvent =
  | ServerEvent
  | { readonly kind: "transport"; readonly status: TransportStatus }
  | { readonly kind: "activateCapture" }
  | { readonly kind: "captureFailed"; readonly reason: string }
  | { readonly kind: "selectMeeting"; readonly meetingId: number }
  | { readonly kind: "returnToLibrary" }
  | { readonly kind: "previewSlide"; readonly index: number }
  | { readonly kind: "exitPreview" }
  | { readonly kind: "dismissError" }
  | { readonly kind: "malformed"; readonly reason: string };

// ── parse boundary ─────────────────────────────────────────────────────────

export interface ParseFailure {
  readonly reason: string;
}

export type ParseResult =
  | { readonly ok: true; readonly event: ServerEvent }
  | { readonly ok: false; readonly error: ParseFailure };

/** Message types `src/session.ts` declares. Anything else is a typed failure. */
const KNOWN_MESSAGE_TYPES: readonly string[] = [
  "slide",
  "caption",
  "line",
  "transcript",
  "status",
  "capture",
  "detect",
  "providers",
  "sttModels",
  "meetings",
  "meeting",
  "attendees",
  "review",
  "saved",
  "compile",
  "export",
  "ask",
  "reviewItemUpdated",
  "reviewConfirmed",
  "meetingConcluded",
];

const CAPTURE_PHASES: readonly string[] = ["idle", "starting", "capturing", "stopping", "switching-model"];
const COMPILE_STATUSES: readonly string[] = ["started", "progress", "success", "error", "timeout"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(reason: string): ParseResult {
  return { ok: false, error: { reason } };
}

function parseCapturePhase(raw: unknown, capturing: boolean): Exclude<CaptureState, "error"> | null {
  if (raw === undefined) return capturing ? "capturing" : "idle";
  if (typeof raw !== "string" || !CAPTURE_PHASES.includes(raw)) return null;
  // The list above is exactly the phase union, so the narrowing is total.
  if (raw === "idle" || raw === "starting" || raw === "capturing" || raw === "stopping") return raw;
  return "switching-model";
}

/**
 * Validate one raw frame from the socket. Malformed and unknown input becomes a
 * typed failure here, never an exception and never a silently ignored frame.
 */
export function parseServerEvent(raw: unknown): ParseResult {
  if (!isRecord(raw)) return fail("frame is not an object");

  const type = raw["type"];
  if (typeof type !== "string") return fail("frame has no string type");
  if (!KNOWN_MESSAGE_TYPES.includes(type)) return fail(`unknown message type: ${type}`);

  if (type === "capture") {
    const capturing = raw["capturing"];
    if (typeof capturing !== "boolean") return fail("capture.capturing is not a boolean");
    const mode = raw["mode"];
    if (typeof mode !== "string") return fail("capture.mode is not a string");
    const phase = parseCapturePhase(raw["phase"], capturing);
    if (phase === null) return fail("capture.phase is not a declared phase");
    const startedAtRaw = raw["startedAt"];
    const startedAt =
      typeof startedAtRaw === "number" && Number.isFinite(startedAtRaw) && startedAtRaw > 0 ? startedAtRaw : null;
    return {
      ok: true,
      event: { kind: "server", message: "capture", snapshot: { capturing, mode, phase, startedAt } },
    };
  }

  if (type === "meetings") {
    const items = raw["items"];
    if (!Array.isArray(items)) return fail("meetings.items is not an array");
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
    if (typeof jobId !== "string" || jobId.length === 0) return fail("compile.jobId is not a string");
    const errorRaw = raw["error"];
    const error = typeof errorRaw === "string" ? errorRaw : null;
    return {
      ok: true,
      event: {
        kind: "server",
        message: "compile",
        status: status as CompileStatus,
        jobId,
        error,
      },
    };
  }

  return { ok: true, event: { kind: "server", message: "other", type } };
}

// ── state construction ─────────────────────────────────────────────────────

interface MutableUiState {
  connection: ConnectionState;
  capture: CaptureState;
  shell: ShellState;
  hydrated: boolean;
  captureStartedAt: number | null;
  mode: string;
  startRequested: boolean;
  stopRequested: boolean;
  selectedMeetingId: number | null;
  loadedMeetingId: number | null;
  preview: PreviewState | null;
  activeJobId: string | null;
  completedJobId: string | null;
  lastError: UiError | null;
  restore: RestoreTarget | null;
  outbox: readonly ClientCommand[];
}

/**
 * Derive the canonical name. This is the only place a state name is decided, so
 * the name and the projection can never disagree.
 */
function nameOf(draft: MutableUiState): UiStateName {
  if (!draft.hydrated) return "startup";
  // Any transport state short of `online` is presented as `reconnect`: the
  // surface must never claim a live capture over a socket it does not have.
  if (draft.connection !== "online") return "reconnect";
  // A compile job is the surface's foreground concern while it runs or while its
  // result is still being presented; it never suppresses capture actions.
  if (draft.activeJobId !== null) return "compile-running";
  if (draft.completedJobId !== null) return "compile-complete";
  if (draft.preview !== null) return "history-preview";
  if (draft.capture === "error") return "capture-error";
  if (draft.capture === "starting") return "capture-starting";
  if (draft.capture === "stopping") return "capture-stopping";
  if (draft.capture === "capturing" || draft.capture === "switching-model") return "capture-live";
  if (draft.selectedMeetingId !== null && draft.selectedMeetingId !== draft.loadedMeetingId) {
    return "meeting-switching";
  }
  if (draft.shell === "live") return "idle-live";
  return "idle-library";
}

function freeze(draft: MutableUiState): UiState {
  const state: UiState = {
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
    outbox: Object.freeze(draft.outbox.map((command) => Object.freeze({ ...command }))),
  };
  return Object.freeze(state);
}

function draftOf(state: UiState): MutableUiState {
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
    // Commands are emitted per reduction; they never survive into the next one.
    outbox: [],
  };
}

export function initialUiState(): UiState {
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
    outbox: [],
  });
}

// ── transitions ────────────────────────────────────────────────────────────

/** Capture substates that a disconnect must remember instead of flattening. */
function isCaptureActive(capture: CaptureState): boolean {
  return capture === "starting" || capture === "capturing" || capture === "stopping" || capture === "switching-model";
}

function clearErrorScope(draft: MutableUiState, scope: ErrorScope): void {
  if (draft.lastError !== null && draft.lastError.scope === scope) draft.lastError = null;
}

function applyTransport(draft: MutableUiState, status: TransportStatus): void {
  if (status === "connecting") {
    draft.connection = "connecting";
    return;
  }

  if (status === "open") {
    // Reconnected socket: stay in `reconnect` until the server re-asserts the
    // authoritative capture snapshot, and re-issue a stop that never landed.
    clearErrorScope(draft, "transport");
    draft.connection = "connecting";
    if (draft.hydrated && draft.stopRequested) draft.outbox = [{ action: "stopCapture" }];
    return;
  }

  if (status === "closed") {
    draft.connection = "reconnecting";
    // Jobs cannot survive the socket that owned them.
    draft.activeJobId = null;
    draft.completedJobId = null;
    if (draft.hydrated) {
      draft.restore = {
        name: isCaptureActive(draft.capture) ? "capture-live" : draft.shell === "live" ? "idle-live" : "idle-library",
        meetingId: draft.loadedMeetingId,
      };
    }
    return;
  }

  draft.connection = "error";
  draft.activeJobId = null;
  draft.completedJobId = null;
  draft.lastError = { scope: "transport", reason: "connection-error" };
}

function applyCaptureSnapshot(draft: MutableUiState, snapshot: CaptureSnapshot): void {
  // The server snapshot always outranks any locally pending capture intent.
  // Receiving one is itself proof the transport is delivering, so a previous
  // connection error is resolved rather than left sticky.
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
  // Any non-idle snapshot means the server owns the capture now, so the local
  // "start in flight" guard is released and Stop becomes legal again.
  draft.startRequested = false;
  draft.shell = "live";
  if (snapshot.phase === "stopping") draft.stopRequested = true;
}

function applyActivateCapture(draft: MutableUiState): void {
  // A start the server has not confirmed yet is neither startable nor stoppable:
  // re-activating it would either duplicate startCapture or ask the server to
  // stop a capture it has not acknowledged owning.
  if (draft.startRequested) return;

  if (draft.capture === "capturing" || draft.capture === "switching-model" || draft.capture === "starting") {
    if (draft.stopRequested) return;
    draft.stopRequested = true;
    draft.capture = "stopping";
    draft.outbox = [{ action: "stopCapture" }];
    return;
  }

  if (draft.capture === "stopping") return; // Stop is already in flight.

  clearErrorScope(draft, "capture");
  draft.startRequested = true;
  draft.capture = "starting";
  draft.shell = "live";
  draft.outbox =
    draft.selectedMeetingId === null
      ? [{ action: "startCapture" }]
      : [{ action: "startCapture", meeting_id: draft.selectedMeetingId }];
}

function applyCompile(
  draft: MutableUiState,
  status: CompileStatus,
  jobId: string,
  error: string | null,
): void {
  if (status === "started" || status === "progress") {
    draft.activeJobId = jobId;
    draft.completedJobId = null;
    clearErrorScope(draft, "compile");
    return;
  }

  // A terminal answer for a superseded job must not disturb the current one.
  if (draft.activeJobId !== null && draft.activeJobId !== jobId) return;
  draft.activeJobId = null;

  if (status === "success") {
    draft.completedJobId = jobId;
    clearErrorScope(draft, "compile");
    return;
  }

  draft.completedJobId = null;

  draft.lastError = {
    scope: "compile",
    reason: error ?? (status === "timeout" ? "compile-timeout" : "compile-failed"),
  };
}

/**
 * Apply one event. Exhaustive over `UiEvent`: the final `never` binding makes an
 * unhandled event kind a compile error rather than a silent fall-through.
 */
export function reduce(state: UiState, event: UiEvent): UiState {
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
          // Out-of-order detail for a superseded selection is dropped.
          if (draft.hydrated && draft.selectedMeetingId === event.meetingId) {
            draft.loadedMeetingId = event.meetingId;
            draft.shell = isCaptureActive(draft.capture) ? draft.shell : "library";
          }
          break;
        case "meetings":
          break;
        case "compile":
          if (draft.hydrated) applyCompile(draft, event.status, event.jobId, event.error);
          break;
        case "other":
          break;
        default: {
          const unreachable: never = event;
          return unreachable;
        }
      }
      break;

    case "activateCapture":
      // A command can only be issued over a live transport. While booting,
      // reconnecting or errored the activation is refused rather than queued
      // into a socket that cannot deliver it.
      if (draft.hydrated && draft.connection === "online") applyActivateCapture(draft);
      break;

    case "captureFailed":
      draft.capture = "error";
      draft.startRequested = false;
      draft.stopRequested = false;
      draft.captureStartedAt = null;
      draft.lastError = { scope: "capture", reason: event.reason };
      break;

    case "selectMeeting":
      // Same rule as capture activation: no command is issued over a transport
      // that cannot deliver it, so the surface never waits on a lost request.
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
      if (!isCaptureActive(draft.capture)) draft.shell = "library";
      break;

    case "previewSlide":
      draft.preview = { index: event.index };
      break;

    case "exitPreview":
      draft.preview = null;
      break;

    case "dismissError":
      draft.lastError = null;
      if (draft.capture === "error") draft.capture = "idle";
      break;

    case "malformed":
      // A rejected frame must not move the surface; it only records why.
      draft.lastError = { scope: "protocol", reason: event.reason };
      break;

    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }

  return freeze(draft);
}

/** Fold a whole event sequence. Equivalent to repeated `reduce`. */
export function reduceAll(state: UiState, events: readonly UiEvent[]): UiState {
  let current = state;
  for (const event of events) current = reduce(current, event);
  return current;
}
