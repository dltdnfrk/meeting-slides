// GENERATED FILE - DO NOT EDIT.
// Source: public/protocol-values.ts
// Generator: scripts/build-public-modules.ts
// Rebuild: bun run scripts/build-public-modules.ts
export const KNOWN_MESSAGE_TYPES = Object.freeze([
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
  "refine",
  "reviewItemUpdated",
  "reviewConfirmed",
  "meetingConcluded"
]);
export function isKnownMessageType(value) {
  return KNOWN_MESSAGE_TYPES.some((type) => type === value);
}
