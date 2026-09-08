import type { ServerMessage } from "../src/protocol.ts";

/** Wire discriminants shared by every browser projection. No runtime server import. */
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
  "meetingConcluded",
] as const satisfies readonly ServerMessage["type"][]);

export type KnownMessageType = (typeof KNOWN_MESSAGE_TYPES)[number];

export function isKnownMessageType(value: string): value is KnownMessageType {
  return KNOWN_MESSAGE_TYPES.some((type) => type === value);
}
