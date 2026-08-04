import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { buildMinutesHtml, type MinutesInput } from "../../../../src/minutes.ts";
import { MinutesPdfOverflowError, renderMinutesPdf } from "../../../../src/pdf.ts";

const version = "cleanup-v1";
const input: MinutesInput = {
  meta: {
    title: "Cleanup check",
    meetingDate: "2026-08-01",
    timeZone: "Asia/Seoul",
    purpose: "Verify all PDF exit paths remove temp directories.",
  },
  attendees: [{ attendeeId: "alice", displayName: "Alice" }],
  decisions: Array.from({ length: 40 }, (_, index) => ({
    description: `Decision ${index + 1}: ${"overflow payload ".repeat(40)}`,
    attributedAttendeeId: "alice",
    sourceSegment: { transcript_version_id: version, start_seq: index + 1, end_seq: index + 1 },
  })),
  actions: [{
    description: "Cleanup after overflow and launch failure",
    assigneeAttendeeId: "alice",
    deadline: "2026-08-07",
    sourceSegment: { transcript_version_id: version, start_seq: 41, end_seq: 41 },
  }],
  open: [],
  referencedMaterials: [],
  transcript: [],
  transcriptVersionId: version,
};

async function temps(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("meeting-minutes-pdf-"));
}

const before = await temps();
const overflowResult = await renderMinutesPdf(buildMinutesHtml(input)).then(() => "no-error", (error: unknown) => error);
const afterOverflow = await temps();
const launchResult = await renderMinutesPdf(buildMinutesHtml({ ...input, decisions: input.decisions.slice(0, 1) }), {
  executablePath: "/definitely/missing/meeting-minutes-chromium",
}).then(() => "no-error", (error: unknown) => error);
const afterLaunch = await temps();
const measurementResult = await renderMinutesPdf("<html><body><main>missing first page</main></body></html>").then(() => "no-error", (error: unknown) => error);
const afterMeasurement = await temps();

if (!(overflowResult instanceof MinutesPdfOverflowError)) throw new Error(`expected overflow error, got ${String(overflowResult)}`);
if (!(launchResult instanceof Error) || !/Chromium launch failed/i.test(launchResult.message)) throw new Error(`expected launch failure, got ${String(launchResult)}`);
if (!(measurementResult instanceof Error) || !/first-page/i.test(measurementResult.message)) throw new Error(`expected measurement failure, got ${String(measurementResult)}`);
if (JSON.stringify(before) !== JSON.stringify(afterOverflow) || JSON.stringify(before) !== JSON.stringify(afterLaunch) || JSON.stringify(before) !== JSON.stringify(afterMeasurement)) {
  throw new Error(JSON.stringify({ before, afterOverflow, afterLaunch, afterMeasurement }, null, 2));
}
console.log(JSON.stringify({ beforeCount: before.length, afterCount: afterMeasurement.length, overflow: overflowResult.name, launch: launchResult.message, measurement: measurementResult.message }, null, 2));
