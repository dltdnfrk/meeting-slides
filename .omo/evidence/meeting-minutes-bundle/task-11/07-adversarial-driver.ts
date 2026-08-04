import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { buildMinutesHtml, type MinutesInput } from "../../../../src/minutes.ts";
import { MinutesPdfOverflowError, renderMinutesPdf } from "../../../../src/pdf.ts";

const version = "adversarial-v1";

function makeInput(decisions: number, descriptionRepeat: number): MinutesInput {
  return {
    meta: {
      title: "Adversarial release council",
      meetingDate: "2026-08-01",
      timeZone: "Asia/Seoul",
      purpose: "Exercise hostile PDF inputs and cleanup paths.",
    },
    attendees: [{ attendeeId: "alice", displayName: "Alice" }],
    decisions: Array.from({ length: decisions }, (_, index) => ({
      description: `Decision ${index + 1}: ${"overflow payload ".repeat(descriptionRepeat)}`,
      attributedAttendeeId: "alice",
      sourceSegment: { transcript_version_id: version, start_seq: index + 1, end_seq: index + 1 },
    })),
    actions: [{
      description: "Verify cleanup after launch and overflow failures",
      assigneeAttendeeId: "alice",
      deadline: "2026-08-07",
      sourceSegment: { transcript_version_id: version, start_seq: decisions + 1, end_seq: decisions + 1 },
    }],
    open: [],
    referencedMaterials: [],
    transcript: [],
    transcriptVersionId: version,
  };
}

async function temps(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("meeting-minutes-pdf-"));
}

const before = await temps();
const hostileHtml = buildMinutesHtml(makeInput(40, 40)).replace("</head>", `<style>
  html[data-minutes-fit="minimum"] .first-page { min-height: 500mm !important; }
</style></head>`);
const overflow = await renderMinutesPdf(hostileHtml).then(() => "no-error", (error: unknown) => error);
const afterOverflow = await temps();
const launchFailure = await renderMinutesPdf(buildMinutesHtml(makeInput(1, 1)), {
  executablePath: "/definitely/missing/meeting-minutes-chromium",
}).then(() => "no-error", (error: unknown) => error);
const afterLaunchFailure = await temps();
const emptyHtml = await renderMinutesPdf(" ").then(() => "no-error", (error: unknown) => error);
const afterEmpty = await temps();

if (!(overflow instanceof MinutesPdfOverflowError)) throw new Error(`expected MinutesPdfOverflowError, got ${String(overflow)}`);
if (!(launchFailure instanceof Error) || !/Chromium launch failed/i.test(launchFailure.message)) throw new Error(`expected launch failure wrapper, got ${String(launchFailure)}`);
if (!(emptyHtml instanceof TypeError) || !/non-empty string/i.test(emptyHtml.message)) throw new Error(`expected TypeError, got ${String(emptyHtml)}`);
if (JSON.stringify(before) !== JSON.stringify(afterOverflow) || JSON.stringify(before) !== JSON.stringify(afterLaunchFailure) || JSON.stringify(before) !== JSON.stringify(afterEmpty)) {
  throw new Error(`temp cleanup changed: ${JSON.stringify({ before, afterOverflow, afterLaunchFailure, afterEmpty })}`);
}
console.log(JSON.stringify({ beforeCount: before.length, overflow: overflow.name, launchFailure: launchFailure.message, emptyHtml: emptyHtml.message, tempCount: afterEmpty.length }, null, 2));
