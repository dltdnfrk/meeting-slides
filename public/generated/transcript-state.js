// GENERATED FILE - DO NOT EDIT.
// Source: public/transcript-state.ts
// Generator: scripts/build-public-modules.ts
// Rebuild: bun run scripts/build-public-modules.ts
export const MINIBAR_LINE_LIMIT = 3;
import { isKnownMessageType } from "./protocol-values.js";
const TRANSCRIPT_REASONS = ["snapshot", "export"];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(reason) {
  return { ok: false, error: { reason } };
}
export function normalizeTranscriptText(value) {
  return value.trim().replace(/\s+/g, " ");
}
function parseSpeaker(raw) {
  if (raw === undefined || raw === null)
    return null;
  if (typeof raw !== "number" || !Number.isFinite(raw))
    return;
  return raw > 0 ? raw : null;
}
function parseEntry(raw) {
  if (!isRecord(raw))
    return null;
  const text = raw["text"];
  if (typeof text !== "string")
    return null;
  const ts = raw["ts"];
  if (typeof ts !== "number" || !Number.isFinite(ts))
    return null;
  const speaker = parseSpeaker(raw["speaker"]);
  if (speaker === undefined)
    return null;
  return { text, ts, speaker };
}
function parseEntries(raw, label) {
  if (!Array.isArray(raw))
    return `${label} is not an array`;
  const entries = [];
  for (const item of raw) {
    const entry = parseEntry(item);
    if (entry === null)
      return `${label} contains a malformed entry`;
    entries.push(entry);
  }
  return entries;
}
export function parseTranscriptEvent(raw) {
  if (!isRecord(raw))
    return fail("frame is not an object");
  const type = raw["type"];
  if (typeof type !== "string")
    return fail("frame has no string type");
  if (!isKnownMessageType(type))
    return fail(`unknown message type: ${type}`);
  if (type === "line" || type === "caption") {
    const entry = parseEntry(raw);
    if (entry === null)
      return fail(`${type} entry is malformed`);
    return { ok: true, event: { kind: "server", message: type, entry } };
  }
  if (type === "transcript") {
    const entries = parseEntries(raw["entries"], "transcript.entries");
    if (typeof entries === "string")
      return fail(entries);
    const reasonRaw = raw["reason"];
    if (reasonRaw !== undefined && (typeof reasonRaw !== "string" || !TRANSCRIPT_REASONS.includes(reasonRaw))) {
      return fail("transcript.reason is not a declared reason");
    }
    const reason = reasonRaw === "snapshot" ? "snapshot" : "export";
    return {
      ok: true,
      event: { kind: "server", message: "transcript", reason, truncated: raw["truncated"] === true, entries }
    };
  }
  if (type === "meeting") {
    const meetingId = raw["meetingId"];
    if (typeof meetingId !== "number" || !Number.isFinite(meetingId)) {
      return fail("meeting.meetingId is not a number");
    }
    const entries = parseEntries(raw["transcript"], "meeting.transcript");
    if (typeof entries === "string")
      return fail(entries);
    return { ok: true, event: { kind: "server", message: "meeting", meetingId, entries } };
  }
  return { ok: true, event: { kind: "server", message: "other", type } };
}
function freezeLine(line) {
  return Object.freeze({ text: line.text, ts: line.ts, speaker: line.speaker });
}
function freeze(draft) {
  return Object.freeze({
    finalized: Object.freeze(draft.finalized.map(freezeLine)),
    provisional: draft.provisional === null ? null : freezeLine(draft.provisional),
    count: draft.finalized.length,
    truncated: draft.truncated,
    meetingId: draft.meetingId,
    rejected: draft.rejected,
    lastError: draft.lastError
  });
}
function draftOf(state) {
  return {
    finalized: state.finalized,
    provisional: state.provisional,
    truncated: state.truncated,
    meetingId: state.meetingId,
    rejected: state.rejected,
    lastError: state.lastError
  };
}
export function initialTranscriptState() {
  return freeze({
    finalized: [],
    provisional: null,
    truncated: false,
    meetingId: null,
    rejected: 0,
    lastError: null
  });
}
function lineKey(line) {
  return `${line.ts}:${line.speaker ?? 0}:${normalizeTranscriptText(line.text)}`;
}
function normalizedLine(line) {
  const text = normalizeTranscriptText(line.text);
  if (text.length === 0)
    return null;
  return { text, ts: line.ts, speaker: line.speaker };
}
function insertFinal(list, next) {
  let index = list.length;
  while (index > 0 && list[index - 1].ts > next.ts)
    index -= 1;
  return [...list.slice(0, index), next, ...list.slice(index)];
}
function orderFinals(entries) {
  const seen = new Set;
  const unique = [];
  for (const entry of entries) {
    const line = normalizedLine(entry);
    if (line === null)
      continue;
    const key = lineKey(line);
    if (seen.has(key))
      continue;
    seen.add(key);
    unique.push(line);
  }
  return unique.map((line, arrival) => ({ line, arrival })).sort((a, b) => a.line.ts === b.line.ts ? a.arrival - b.arrival : a.line.ts - b.line.ts).map((item) => item.line);
}
function supersedesProvisional(provisional, final) {
  if (provisional.speaker !== null && final.speaker !== null)
    return provisional.speaker === final.speaker;
  return normalizeTranscriptText(provisional.text) === normalizeTranscriptText(final.text);
}
function reject(draft, reason) {
  draft.rejected += 1;
  draft.lastError = reason;
}
function replaceProjection(draft, entries) {
  draft.finalized = orderFinals(entries);
  draft.provisional = null;
}
function applyLine(draft, entry) {
  if (draft.meetingId !== null) {
    reject(draft, "line for the live meeting while a history meeting is active");
    return;
  }
  const line = normalizedLine(entry);
  if (line === null)
    return;
  if (draft.provisional !== null && supersedesProvisional(draft.provisional, line)) {
    draft.provisional = null;
  }
  const key = lineKey(line);
  if (draft.finalized.some((existing) => lineKey(existing) === key))
    return;
  draft.finalized = insertFinal(draft.finalized, line);
}
function applyCaption(draft, entry) {
  if (draft.meetingId !== null) {
    reject(draft, "caption for the live meeting while a history meeting is active");
    return;
  }
  const line = normalizedLine(entry);
  if (line === null) {
    draft.provisional = null;
    return;
  }
  const key = lineKey(line);
  if (draft.finalized.some((existing) => lineKey(existing) === key)) {
    draft.provisional = null;
    return;
  }
  draft.provisional = line;
}
export function reduceTranscript(state, event) {
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
          if (event.reason !== "snapshot")
            break;
          if (draft.meetingId !== null) {
            reject(draft, "live transcript snapshot while a history meeting is active");
            break;
          }
          replaceProjection(draft, event.entries);
          draft.truncated = event.truncated;
          break;
        case "meeting":
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
          const unreachable = event;
          return unreachable;
        }
      }
      break;
    case "activateMeeting":
      if (draft.meetingId === event.meetingId)
        break;
      draft.meetingId = event.meetingId;
      draft.finalized = [];
      draft.provisional = null;
      draft.truncated = false;
      break;
    case "reset":
      return initialTranscriptState();
    case "malformed":
      reject(draft, event.reason);
      break;
    default: {
      const unreachable = event;
      return unreachable;
    }
  }
  return freeze(draft);
}
export function reduceTranscriptAll(state, events) {
  let current = state;
  for (const event of events)
    current = reduceTranscript(current, event);
  return current;
}
export function minibarProjection(state) {
  return Object.freeze({
    finalized: Object.freeze(state.finalized.slice(-MINIBAR_LINE_LIMIT)),
    provisional: state.provisional
  });
}
