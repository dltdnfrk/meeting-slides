import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument } from "pdf-lib";

import { buildMinutesHtml, type MinutesInput } from "../../../../src/minutes.ts";
import {
  MinutesPdfOverflowError,
  renderMinutesPdf,
  resolveVendoredChromiumExecutable,
} from "../../../../src/pdf.ts";

const evidenceDirectory = import.meta.dir;
const pdfPath = join(evidenceDirectory, "minutes-a4.pdf");
const shrinkPdfPath = join(evidenceDirectory, "minutes-a4-shrunk.pdf");
const overflowDirectory = await mkdtemp(join(tmpdir(), "minutes-pdf-overflow-qa-"));
const overflowPath = join(overflowDirectory, "must-not-exist.pdf");
const rendererTemps = async (): Promise<string[]> => (await readdir(tmpdir()))
  .filter((name) => name.startsWith("meeting-minutes-pdf-"))
  .sort();

function makeInput(decisions: number, descriptionRepeat: number, transcriptLines: number): MinutesInput {
  const transcriptVersionId = "qa-canonical-v1";
  return {
    meta: {
      title: "RELEASE COUNCIL QA",
      meetingDate: "2026-08-01",
      timeZone: "Asia/Seoul",
      purpose: "Verify the A4 minutes export invariant.",
    },
    attendees: [{ attendeeId: "alice", displayName: "Alice Kim" }],
    decisions: Array.from({ length: decisions }, (_, index) => ({
      description: `DECISION-QA-${index + 1}: ${"release evidence ".repeat(descriptionRepeat)}`,
      attributedAttendeeId: "alice",
      sourceSegment: { transcript_version_id: transcriptVersionId, start_seq: index + 1, end_seq: index + 1 },
    })),
    actions: [{
      description: "ACTION-QA-1: publish the signed verification report",
      assigneeAttendeeId: "alice",
      deadline: "2026-08-07",
      sourceSegment: { transcript_version_id: transcriptVersionId, start_seq: decisions + 1, end_seq: decisions + 1 },
    }],
    open: [{
      description: "APPENDIX-QA: retain follow-up discussion",
      sourceSegment: { transcript_version_id: transcriptVersionId, start_seq: decisions + 2, end_seq: decisions + 2 },
    }],
    referencedMaterials: [],
    transcript: Array.from({ length: transcriptLines }, (_, index) => ({
      seq: decisions + 3 + index,
      speakerTurn: 1,
      attributedAttendeeId: "alice",
      text: `APPENDIX-QA-LINE-${index + 1}: canonical transcript evidence retained for review.`,
    })),
    transcriptVersionId,
  };
}

async function run(...command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed (${exitCode}): ${stderr}`);
  return stdout;
}

try {
  const executablePath = await resolveVendoredChromiumExecutable();
  const bytes = await renderMinutesPdf(buildMinutesHtml(makeInput(4, 2, 120)));
  await writeFile(pdfPath, bytes);
  const document = await PDFDocument.load(bytes);
  const pageSize = document.getPage(0).getSize();
  const text = await run("pdftotext", "-layout", pdfPath, "-");
  const pages = text.split("\f").map((page) => page.trim()).filter(Boolean);
  await writeFile(join(evidenceDirectory, "page-1.txt"), `${pages[0]}\n`);
  await writeFile(join(evidenceDirectory, "page-2.txt"), `${pages[1]}\n`);

  const shrinkHtml = buildMinutesHtml(makeInput(7, 4, 0))
    .replace(
      "</head>",
      `<style>
        html[data-minutes-fit="normal"] .first-page { min-height: 280mm !important; }
        .fit-stage-marker::after { content: "FIT-STAGE-NORMAL"; }
        html:not([data-minutes-fit="normal"]) .fit-stage-marker::after { content: "FIT-STAGE-SHRUNK"; }
      </style></head>`,
    )
    .replace(/(<section class="first-page"[^>]*>)/, '$1<span class="fit-stage-marker"></span>');
  const shrinkBytes = await renderMinutesPdf(shrinkHtml);
  await writeFile(shrinkPdfPath, shrinkBytes);
  const shrinkText = await run("pdftotext", "-layout", shrinkPdfPath, "-");

  const beforeOverflowTemps = await rendererTemps();
  const overflow = await renderMinutesPdf(buildMinutesHtml(makeInput(30, 20, 0))).then(
    async (overflowBytes) => {
      await writeFile(overflowPath, overflowBytes);
      return undefined;
    },
    (error: unknown) => error,
  );
  const afterOverflowTemps = await rendererTemps();
  const overflowOutputExists = await stat(overflowPath).then(() => true, () => false);
  const checks = {
    pdfHeader: new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-",
    nonempty: bytes.byteLength > 1_000,
    portraitA4: Math.abs(pageSize.width - 595.28) < 1
      && Math.abs(pageSize.height - 841.89) < 1
      && pageSize.height > pageSize.width,
    appendixMultipage: document.getPageCount() > 2,
    everyDecisionOnPageOne: Array.from({ length: 4 }, (_, index) => `DECISION-QA-${index + 1}`)
      .every((marker) => pages[0]?.includes(marker)),
    everyActionOnPageOne: pages[0]?.includes("ACTION-QA-1") === true,
    appendixAbsentFromPageOne: !pages[0]?.includes("APPENDIX-QA"),
    appendixPresentAfterPageOne: pages.slice(1).join("\n").includes("APPENDIX-QA-LINE-120"),
    deterministicShrink: shrinkText.includes("FIT-STAGE-SHRUNK") && !shrinkText.includes("FIT-STAGE-NORMAL"),
    shrunkSummaryComplete: Array.from({ length: 7 }, (_, index) => `DECISION-QA-${index + 1}`)
      .every((marker) => shrinkText.split("\f")[0]?.includes(marker))
      && shrinkText.split("\f")[0]?.includes("ACTION-QA-1") === true,
    explicitOverflow: overflow instanceof MinutesPdfOverflowError,
    overflowOutputAbsent: !overflowOutputExists,
    overflowTempCleanup: JSON.stringify(beforeOverflowTemps) === JSON.stringify(afterOverflowTemps),
  };
  if (Object.values(checks).some((passed) => !passed)) {
    throw new Error(`real PDF QA failed: ${JSON.stringify(checks)}`);
  }

  console.log(JSON.stringify({
    verified_at: new Date().toISOString(),
    verified_by: `senpi/${process.env.PI_MODEL ?? "unknown"}`,
    target_commit: "94fea038c0ca47e8b32950a8d666550bd9dea448",
    executablePath,
    pdfPath,
    shrinkPdfPath,
    bytes: bytes.byteLength,
    pages: document.getPageCount(),
    pageSize,
    pageOneTextPreview: pages[0]?.slice(0, 240),
    overflow: overflow instanceof Error ? overflow.message : String(overflow),
    checks,
  }, null, 2));
} finally {
  await rm(overflowDirectory, { recursive: true, force: true });
}
