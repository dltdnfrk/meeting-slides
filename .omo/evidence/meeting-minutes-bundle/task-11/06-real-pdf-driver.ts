import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PDFDocument } from "pdf-lib";

import { buildMinutesHtml, type MinutesInput } from "../../../../src/minutes.ts";
import { renderMinutesPdf } from "../../../../src/pdf.ts";

const evidenceDir = import.meta.dir;
const pdfPath = join(evidenceDir, "minutes-a4.pdf");
const input: MinutesInput = {
  meta: {
    title: "RELEASE COUNCIL 2026",
    meetingDate: "2026-08-01",
    timeZone: "Asia/Seoul",
    purpose: "Approve the production release and record accountable follow-up.",
    provider: "local",
  },
  attendees: [
    { attendeeId: "alice", displayName: "Alice Kim" },
    { attendeeId: "bob", displayName: "Bob Park" },
  ],
  decisions: Array.from({ length: 6 }, (_, index) => ({
    description: `DECISION-MARKER-${index + 1}: approve release gate ${index + 1} with documented verification evidence.`,
    attributedAttendeeId: index % 2 ? "bob" : "alice",
    sourceSegment: { transcript_version_id: "canonical-v2", start_seq: index + 1, end_seq: index + 1 },
  })),
  actions: Array.from({ length: 3 }, (_, index) => ({
    description: `ACTION-MARKER-${index + 1}: complete owner checklist and publish result.`,
    assigneeAttendeeId: index % 2 ? "alice" : "bob",
    deadline: `2026-08-${String(index + 7).padStart(2, "0")}`,
    sourceSegment: { transcript_version_id: "canonical-v2", start_seq: index + 7, end_seq: index + 7 },
  })),
  open: [{
    description: "APPENDIX-MARKER: confirm the next release train budget.",
    attributedAttendeeId: "alice",
    sourceSegment: { transcript_version_id: "canonical-v2", start_seq: 10, end_seq: 10 },
  }],
  referencedMaterials: [],
  transcript: Array.from({ length: 55 }, (_, index) => ({
    seq: index + 1,
    speakerTurn: index % 2 + 1,
    attributedAttendeeId: index % 2 ? "bob" : "alice",
    text: `Transcript line ${index + 1}: verification discussion retained in the appendix for auditability.`,
  })),
  transcriptVersionId: "canonical-v2",
};

const bytes = await renderMinutesPdf(buildMinutesHtml(input));
await writeFile(pdfPath, bytes);
const document = await PDFDocument.load(bytes);
const size = document.getPage(0).getSize();

async function command(...args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed (${exitCode}): ${stderr}`);
  return stdout;
}

const pageOnePath = join(evidenceDir, "page-1.txt");
const pageTwoPath = join(evidenceDir, "page-2.txt");
await command("pdftotext", "-f", "1", "-l", "1", pdfPath, pageOnePath);
await command("pdftotext", "-f", "2", "-l", "2", pdfPath, pageTwoPath);
await command("pdftoppm", "-f", "1", "-singlefile", "-png", "-r", "120", pdfPath, join(evidenceDir, "minutes-a4-page-1"));
const pageOneText = await Bun.file(pageOnePath).text();
const pageTwoText = await Bun.file(pageTwoPath).text();
const decisionMarkers = Array.from({ length: 6 }, (_, index) => `DECISION-MARKER-${index + 1}`);
const actionMarkers = Array.from({ length: 3 }, (_, index) => `ACTION-MARKER-${index + 1}`);
const checks = {
  pdfHeader: new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-",
  portrait: size.height > size.width,
  a4Points: Math.abs(size.width - 595.28) < 1 && Math.abs(size.height - 841.89) < 1,
  everyDecisionOnPageOne: decisionMarkers.every((marker) => pageOneText.includes(marker)),
  everyActionOnPageOne: actionMarkers.every((marker) => pageOneText.includes(marker)),
  appendixNotOnPageOne: !pageOneText.includes("APPENDIX-MARKER"),
  appendixStartsOnPageTwo: pageTwoText.includes("APPENDIX-MARKER"),
};
if (Object.values(checks).some((passed) => !passed)) throw new Error(`real PDF checks failed: ${JSON.stringify(checks)}`);
console.log(JSON.stringify({
  pdfPath,
  bytes: bytes.byteLength,
  pages: document.getPageCount(),
  widthPoints: size.width,
  heightPoints: size.height,
  checks,
}, null, 2));
