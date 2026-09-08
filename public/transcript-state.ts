// Canonical transcript projection for the operator surface.
//
// This module is the single source of truth for what transcript content the
// surface shows. It is a pure projector: given a frozen state and one typed
// event it returns a new frozen state. It never touches the DOM, a clock, the
// network, storage or any ambient global; every value that could vary between
// runs arrives inside an event payload. Rendering, scrolling, announcing and
// export live outside.
//
// The wire protocol is consumed exactly as `src/session.ts` declares it. No
// message type or payload key is renamed here: finalized sentences still
// arrive as `line`, provisional text as `caption`, backlogs as `transcript`
// with `reason: "snapshot" | "export"`, history detail as `meeting` with
// `meetingId`, and `speaker` stays an optional 1-based number.

// ── entries ─────────────────────────────────────────────────────────────────

/** One transcript entry as the projection stores it. `speaker` is never faked. */
export interface TranscriptLine {
  readonly text: string;
  readonly ts: number;
  readonly speaker: number | null;
}

/**
 * The single provisional row. There is at most one, it is never part of the
 * finalized list, and it never survives a snapshot, a meeting switch or a reset.
 */
export type ProvisionalLine = TranscriptLine;

export interface TranscriptState {
  /** Finalized sentences in stable chronological order. */
  readonly finalized: readonly TranscriptLine[];
  readonly provisional: ProvisionalLine | null;
  /** `finalized.length`, carried explicitly so consumers never recount. */
  readonly count: number;
  /** The server dropped older entries from its log before this snapshot. */
  readonly truncated: boolean;
  /** `null` while the live meeting is active; otherwise the history meeting. */
  readonly meetingId: number | null;
  /** How many frames were rejected as stale or malformed since the last reset. */
  readonly rejected: number;
  /** Why the most recent rejection happened, for an honest failure surface. */
  readonly lastError: string | null;
}

/** How many finalized rows the compact (minibar) projection may show. */
export const MINIBAR_LINE_LIMIT = 3;

// ── events ─────────────────────────────────────────────────────────────────

export type TranscriptReason = "snapshot" | "export";

export type TranscriptServerEvent =
  | { readonly kind: "server"; readonly message: "line"; readonly entry: TranscriptLine }
  | { readonly kind: "server"; readonly message: "caption"; readonly entry: TranscriptLine }
  | {
      readonly kind: "server";
      readonly message: "transcript";
      readonly reason: TranscriptReason;
      readonly truncated: boolean;
      readonly entries: readonly TranscriptLine[];
    }
  | {
      readonly kind: "server";
      readonly message: "meeting";
      readonly meetingId: number;
      readonly entries: readonly TranscriptLine[];
    }
  /** A declared message this projection does not react to. Always a no-op. */
  | { readonly kind: "server"; readonly message: "other"; readonly type: string };

export type TranscriptEvent =
  | TranscriptServerEvent
  /** `null` selects the live meeting; a number selects a history meeting. */
  | { readonly kind: "activateMeeting"; readonly meetingId: number | null }
  | { readonly kind: "reset" }
  | { readonly kind: "malformed"; readonly reason: string };

// ── parse boundary ─────────────────────────────────────────────────────────

export interface TranscriptParseFailure {
  readonly reason: string;
}

export type TranscriptParseResult =
  | { readonly ok: true; readonly event: TranscriptServerEvent }
  | { readonly ok: false; readonly error: TranscriptParseFailure };

import { isKnownMessageType } from "./protocol-values.js";

const TRANSCRIPT_REASONS: readonly string[] = ["snapshot", "export"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(reason: string): TranscriptParseResult {
  return { ok: false, error: { reason } };
}

/**
 * Collapse whitespace exactly as the shipped surfaces do, so a line that only
 * differs by wrapping is recognised as the same sentence.
 */
export function normalizeTranscriptText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseSpeaker(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  // The server emits a 1-based speaker turn; 0 means "unattributed".
  return raw > 0 ? raw : null;
}

function parseEntry(raw: unknown): TranscriptLine | null {
  if (!isRecord(raw)) return null;
  const text = raw["text"];
  if (typeof text !== "string") return null;
  const ts = raw["ts"];
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  const speaker = parseSpeaker(raw["speaker"]);
  if (speaker === undefined) return null;
  return { text, ts, speaker };
}

function parseEntries(raw: unknown, label: string): readonly TranscriptLine[] | string {
  if (!Array.isArray(raw)) return `${label} is not an array`;
  const entries: TranscriptLine[] = [];
  for (const item of raw) {
    const entry = parseEntry(item);
    if (entry === null) return `${label} contains a malformed entry`;
    entries.push(entry);
  }
  return entries;
}

/**
 * Validate one raw frame from the socket. Malformed and unknown input becomes a
 * typed failure here, never an exception and never a silently ignored frame.
 */
export function parseTranscriptEvent(raw: unknown): TranscriptParseResult {
  if (!isRecord(raw)) return fail("frame is not an object");

  const type = raw["type"];
  if (typeof type !== "string") return fail("frame has no string type");
  if (!isKnownMessageType(type)) return fail(`unknown message type: ${type}`);

  if (type === "line" || type === "caption") {
    const entry = parseEntry(raw);
    if (entry === null) return fail(`${type} entry is malformed`);
    return { ok: true, event: { kind: "server", message: type, entry } };
  }

  if (type === "transcript") {
    const entries = parseEntries(raw["entries"], "transcript.entries");
    if (typeof entries === "string") return fail(entries);
    const reasonRaw = raw["reason"];
    // A reason-less transcript is the export answer; only `snapshot` replaces.
    if (reasonRaw !== undefined && (typeof reasonRaw !== "string" || !TRANSCRIPT_REASONS.includes(reasonRaw))) {
      return fail("transcript.reason is not a declared reason");
    }
    const reason: TranscriptReason = reasonRaw === "snapshot" ? "snapshot" : "export";
    return {
      ok: true,
      event: { kind: "server", message: "transcript", reason, truncated: raw["truncated"] === true, entries },
    };
  }

  if (type === "meeting") {
    const meetingId = raw["meetingId"];
    if (typeof meetingId !== "number" || !Number.isFinite(meetingId)) {
      return fail("meeting.meetingId is not a number");
    }
    const entries = parseEntries(raw["transcript"], "meeting.transcript");
    if (typeof entries === "string") return fail(entries);
    return { ok: true, event: { kind: "server", message: "meeting", meetingId, entries } };
  }

  return { ok: true, event: { kind: "server", message: "other", type } };
}

// ── state construction ─────────────────────────────────────────────────────

interface MutableTranscriptState {
  finalized: readonly TranscriptLine[];
  provisional: ProvisionalLine | null;
  truncated: boolean;
  meetingId: number | null;
  rejected: number;
  lastError: string | null;
}

function freezeLine(line: TranscriptLine): TranscriptLine {
  return Object.freeze({ text: line.text, ts: line.ts, speaker: line.speaker });
}

function freeze(draft: MutableTranscriptState): TranscriptState {
  return Object.freeze({
    finalized: Object.freeze(draft.finalized.map(freezeLine)),
    provisional: draft.provisional === null ? null : freezeLine(draft.provisional),
    count: draft.finalized.length,
    truncated: draft.truncated,
    meetingId: draft.meetingId,
    rejected: draft.rejected,
    lastError: draft.lastError,
  });
}

function draftOf(state: TranscriptState): MutableTranscriptState {
  return {
    finalized: state.finalized,
    provisional: state.provisional,
    truncated: state.truncated,
    meetingId: state.meetingId,
    rejected: state.rejected,
    lastError: state.lastError,
  };
}

export function initialTranscriptState(): TranscriptState {
  return freeze({
    finalized: [],
    provisional: null,
    truncated: false,
    meetingId: null,
    rejected: 0,
    lastError: null,
  });
}

// ── projection rules ───────────────────────────────────────────────────────

/**
 * Identity of a finalized sentence: the server's timestamp, the speaker turn and
 * the normalized words. A re-sent `line`, or a `line` that repeats a sentence
 * already present in a snapshot, collapses onto the same key.
 */
function lineKey(line: TranscriptLine): string {
  return `${line.ts}:${line.speaker ?? 0}:${normalizeTranscriptText(line.text)}`;
}

function normalizedLine(line: TranscriptLine): TranscriptLine | null {
  const text = normalizeTranscriptText(line.text);
  // A blank sentence is not content; it must never occupy a row.
  if (text.length === 0) return null;
  return { text, ts: line.ts, speaker: line.speaker };
}

/**
 * Insert one finalized sentence in stable chronological order: a late arrival
 * lands next to its own timestamp, and an equal timestamp keeps arrival order.
 */
function insertFinal(list: readonly TranscriptLine[], next: TranscriptLine): readonly TranscriptLine[] {
  let index = list.length;
  while (index > 0 && list[index - 1]!.ts > next.ts) index -= 1;
  return [...list.slice(0, index), next, ...list.slice(index)];
}

/** Sort a whole backlog by the same rule, keeping the delivered order on ties. */
function orderFinals(entries: readonly TranscriptLine[]): readonly TranscriptLine[] {
  const seen = new Set<string>();
  const unique: TranscriptLine[] = [];
  for (const entry of entries) {
    const line = normalizedLine(entry);
    if (line === null) continue;
    const key = lineKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
  }
  return unique
    .map((line, arrival) => ({ line, arrival }))
    .sort((a, b) => (a.line.ts === b.line.ts ? a.arrival - b.arrival : a.line.ts - b.line.ts))
    .map((item) => item.line);
}

/**
 * A finalized sentence supersedes the provisional row it came from. The server
 * corrects interim text, so identity is the speaker turn, not the words:
 * matching words also count when the caption carried no speaker.
 */
function supersedesProvisional(provisional: ProvisionalLine, final: TranscriptLine): boolean {
  if (provisional.speaker !== null && final.speaker !== null) return provisional.speaker === final.speaker;
  return normalizeTranscriptText(provisional.text) === normalizeTranscriptText(final.text);
}

function reject(draft: MutableTranscriptState, reason: string): void {
  draft.rejected += 1;
  draft.lastError = reason;
}

function replaceProjection(draft: MutableTranscriptState, entries: readonly TranscriptLine[]): void {
  draft.finalized = orderFinals(entries);
  draft.provisional = null;
}

function applyLine(draft: MutableTranscriptState, entry: TranscriptLine): void {
  if (draft.meetingId !== null) {
    // Live sentences belong to the live meeting, not to the history document.
    reject(draft, "line for the live meeting while a history meeting is active");
    return;
  }
  const line = normalizedLine(entry);
  if (line === null) return;

  if (draft.provisional !== null && supersedesProvisional(draft.provisional, line)) {
    draft.provisional = null;
  }

  const key = lineKey(line);
  if (draft.finalized.some((existing) => lineKey(existing) === key)) return;
  draft.finalized = insertFinal(draft.finalized, line);
}

function applyCaption(draft: MutableTranscriptState, entry: TranscriptLine): void {
  if (draft.meetingId !== null) {
    reject(draft, "caption for the live meeting while a history meeting is active");
    return;
  }
  const line = normalizedLine(entry);
  if (line === null) {
    draft.provisional = null;
    return;
  }
  // A caption that repeats an already finalized sentence is stale interim text.
  const key = lineKey(line);
  if (draft.finalized.some((existing) => lineKey(existing) === key)) {
    draft.provisional = null;
    return;
  }
  draft.provisional = line;
}

// ── transitions ────────────────────────────────────────────────────────────

/**
 * Apply one event. Exhaustive over `TranscriptEvent`: the final `never` binding
 * makes an unhandled event kind a compile error rather than a silent no-op.
 */
export function reduceTranscript(state: TranscriptState, event: TranscriptEvent): TranscriptState {
  const draft = draftOf(state);

  switch (event.kind) {
    case "server":
      switch (event.message) {
        case "line":
          applyLine(draft, event.entry);
          break;

        case "caption":
          applyCaption(draft, event.entry);
          break;

        case "transcript":
          // Only a snapshot is a projection; the export answer is a download.
          if (event.reason !== "snapshot") break;
          if (draft.meetingId !== null) {
            reject(draft, "live transcript snapshot while a history meeting is active");
            break;
          }
          replaceProjection(draft, event.entries);
          draft.truncated = event.truncated;
          break;

        case "meeting":
          // Detail for a superseded selection must not overwrite the current one.
          if (draft.meetingId !== event.meetingId) {
            reject(draft, `meeting detail ${event.meetingId} does not match the active meeting`);
            break;
          }
          replaceProjection(draft, event.entries);
          draft.truncated = false;
          break;

        case "other":
          break;

        default: {
          const unreachable: never = event;
          return unreachable;
        }
      }
      break;

    case "activateMeeting":
      if (draft.meetingId === event.meetingId) break;
      draft.meetingId = event.meetingId;
      draft.finalized = [];
      draft.provisional = null;
      draft.truncated = false;
      break;

    case "reset":
      return initialTranscriptState();

    case "malformed":
      // A rejected frame must not move the projection; it only records why.
      reject(draft, event.reason);
      break;

    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }

  return freeze(draft);
}

/** Fold a whole event sequence. Equivalent to repeated `reduceTranscript`. */
export function reduceTranscriptAll(
  state: TranscriptState,
  events: readonly TranscriptEvent[],
): TranscriptState {
  let current = state;
  for (const event of events) current = reduceTranscript(current, event);
  return current;
}

// ── derived projections ────────────────────────────────────────────────────

export interface MinibarProjection {
  readonly finalized: readonly TranscriptLine[];
  readonly provisional: ProvisionalLine | null;
}

/**
 * The compact projection for the ambient surface: the last few finalized
 * sentences plus the single provisional row. It is derived from the same store,
 * so the minibar can never disagree with the full transcript.
 */
export function minibarProjection(state: TranscriptState): MinibarProjection {
  return Object.freeze({
    finalized: Object.freeze(state.finalized.slice(-MINIBAR_LINE_LIMIT)),
    provisional: state.provisional,
  });
}
