import { buildMinutesHtml, type MinutesInput } from "../../../../src/minutes.ts";

const hostile = `</td><img src=x onerror="globalThis.pwned=1"> & ' "`;
const hostileVersion = `v1" data-injected="true`;
const base: MinutesInput = {
  meta: { title: hostile, meetingDate: hostile, timeZone: hostile, purpose: hostile, provider: hostile },
  attendees: [{ attendeeId: hostile, displayName: hostile }],
  decisions: [{
    description: hostile, attributedAttendeeId: hostile,
    sourceSegment: { transcript_version_id: hostileVersion, start_seq: 1, end_seq: 1 },
  }],
  actions: [{
    description: hostile, assigneeAttendeeId: hostile, attributedAttendeeId: hostile,
    deadlineText: hostile, sourceSegment: { transcript_version_id: hostileVersion, start_seq: 2, end_seq: 2 },
  }],
  open: [{ description: hostile, sourceSegment: { transcript_version_id: hostileVersion, start_seq: 3, end_seq: 3 } }],
  referencedMaterials: [{
    materialType: "link", title: hostile, uri: "javascript:alert(1)", notes: hostile,
    sourceSegment: { transcript_version_id: hostileVersion, start_seq: 4, end_seq: 4 },
  }],
  transcript: [{ seq: 1, speakerTurn: null, attributedAttendeeId: hostile, text: hostile }],
  transcriptVersionId: hostileVersion,
};

const hostileHtml = buildMinutesHtml(base);
const emptyHtml = buildMinutesHtml({
  meta: { title: "", meetingDate: "", timeZone: "", purpose: null, provider: null },
  attendees: [], decisions: [], actions: [], open: [], referencedMaterials: [], transcript: [],
  transcriptVersionId: "",
});
const checks = {
  rawImageTagAbsent: !hostileHtml.includes("<img"),
  rawEventHandlerAbsent: !hostileHtml.includes("onerror=\"globalThis"),
  injectedAttributeAbsent: !hostileHtml.includes('data-transcript-version-id="v1" data-injected="true"'),
  hostileMarkupEscaped: hostileHtml.includes("&lt;/td&gt;&lt;img src=x onerror=&quot;globalThis.pwned=1&quot;&gt;"),
  unsafeUriIsNotClickable: !hostileHtml.includes('href="javascript:'),
  emptyDecisionStatePresent: emptyHtml.includes("결정 사항 없음"),
  emptyActionStatePresent: emptyHtml.includes("액션 항목 없음"),
  emptyAppendixStatesPresent: emptyHtml.includes("미결 또는 다음 안건 없음") &&
    emptyHtml.includes("참조 자료 없음") && emptyHtml.includes("전사 원문 없음"),
  noUndefinedLeak: !emptyHtml.includes("undefined"),
};
if (Object.values(checks).some((passed) => !passed)) throw new Error(`adversarial check failed: ${JSON.stringify(checks)}`);
console.log(JSON.stringify({ hostileLength: hostileHtml.length, emptyLength: emptyHtml.length, checks }, null, 2));
