import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument } from "pdf-lib";

import { buildMinutesHtml, type MinutesInput } from "../src/minutes.ts";
import {
  MinutesPdfOverflowError,
  renderMinutesPdf,
  resolveVendoredChromiumExecutable,
} from "../src/pdf.ts";

const version = "transcript-v1";
let testDirectory = "";
let artifactSequence = 0;

function input(options: {
  decisions?: number;
  descriptionRepeat?: number;
  transcriptLines?: number;
} = {}): MinutesInput {
  const decisionCount = options.decisions ?? 1;
  const descriptionRepeat = options.descriptionRepeat ?? 2;
  return {
    meta: {
      title: "Release council",
      meetingDate: "2026-08-01",
      timeZone: "Asia/Seoul",
      purpose: "Approve the production release",
    },
    attendees: [{ attendeeId: "alice", displayName: "Alice" }],
    decisions: Array.from({ length: decisionCount }, (_, index) => ({
      description: `DECISION-${index + 1}: ${"release detail ".repeat(descriptionRepeat)}`,
      attributedAttendeeId: "alice",
      sourceSegment: { transcript_version_id: version, start_seq: index + 1, end_seq: index + 1 },
    })),
    actions: [{
      description: "ACTION-1: run final QA and publish the signed report",
      assigneeAttendeeId: "alice",
      attributedAttendeeId: "alice",
      deadline: "2026-08-07",
      sourceSegment: { transcript_version_id: version, start_seq: decisionCount + 1, end_seq: decisionCount + 1 },
    }],
    open: [{
      description: "APPENDIX-OPEN: confirm launch budget",
      sourceSegment: { transcript_version_id: version, start_seq: decisionCount + 2, end_seq: decisionCount + 2 },
    }],
    referencedMaterials: [],
    transcript: Array.from({ length: options.transcriptLines ?? 0 }, (_, index) => ({
      seq: decisionCount + 3 + index,
      speakerTurn: 1,
      attributedAttendeeId: "alice",
      text: `APPENDIX-LINE-${index + 1}: retained canonical discussion text for the audit record.`,
    })),
    transcriptVersionId: version,
  };
}

async function inspectPdf(bytes: Uint8Array): Promise<{
  pages: number;
  width: number;
  height: number;
  pageText: string[];
}> {
  const artifact = join(testDirectory, `inspect-${artifactSequence += 1}.pdf`);
  await writeFile(artifact, bytes);
  const document = await PDFDocument.load(bytes);
  const first = document.getPage(0);
  const textProcess = Bun.spawn(["pdftotext", "-layout", artifact, "-"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, stderr, exitCode] = await Promise.all([
    new Response(textProcess.stdout).text(),
    new Response(textProcess.stderr).text(),
    textProcess.exited,
  ]);
  if (exitCode !== 0) throw new Error(`pdftotext failed (${exitCode}): ${stderr}`);
  return {
    pages: document.getPageCount(),
    ...first.getSize(),
    pageText: text.split("\f").map((page) => page.trim()).filter(Boolean),
  };
}

beforeAll(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), "minutes-pdf-test-"));
});

afterAll(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

describe("renderMinutesPdf", () => {
  test("uses the project vendored ms-playwright Chromium executable", async () => {
    const executable = await resolveVendoredChromiumExecutable();
    expect(executable).toContain(`${join("vendor", "ms-playwright")}`);
    expect((await stat(executable)).isFile()).toBe(true);
  });

  test("creates a nonempty portrait A4 PDF with every decision and action only on page one", async () => {
    const pdf = await renderMinutesPdf(buildMinutesHtml(input({ decisions: 2 })));
    const info = await inspectPdf(pdf);

    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(1_000);
    expect(info.pages).toBe(2);
    expect(info.width).toBeCloseTo(595.28, 0);
    expect(info.height).toBeCloseTo(841.89, 0);
    expect(info.height).toBeGreaterThan(info.width);
    expect(info.pageText[0]).toContain("DECISION-1");
    expect(info.pageText[0]).toContain("DECISION-2");
    expect(info.pageText[0]).toContain("ACTION-1");
    expect(info.pageText[0]).not.toContain("APPENDIX-OPEN");
    expect(info.pageText[1]).toContain("APPENDIX-OPEN");
  }, 30_000);

  test("applies the deterministic shrink stages when normal typography overflows", async () => {
    const normalOverflowHtml = buildMinutesHtml(input({ decisions: 7, descriptionRepeat: 4 }))
      .replace(
        "</head>",
        `<style>
          html[data-minutes-fit="normal"] .first-page { min-height: 280mm !important; }
          .fit-stage-marker::after { content: "FIT-STAGE-NORMAL"; }
          html:not([data-minutes-fit="normal"]) .fit-stage-marker::after { content: "FIT-STAGE-SHRUNK"; }
        </style></head>`,
      )
      .replace(/(<section class="first-page"[^>]*>)/, '$1<span class="fit-stage-marker"></span>');
    const info = await inspectPdf(await renderMinutesPdf(normalOverflowHtml));

    expect(info.pages).toBe(2);
    expect(info.pageText[0]).toContain("FIT-STAGE-SHRUNK");
    expect(info.pageText[0]).not.toContain("FIT-STAGE-NORMAL");
    expect(info.pageText[0]).toContain("DECISION-7");
    expect(info.pageText[0]).toContain("ACTION-1");
    expect(info.pageText[1]).toContain("APPENDIX-OPEN");
  }, 30_000);

  test("rejects unshrinkable first-page overflow without creating an output file", async () => {
    const outputPath = join(testDirectory, "must-not-exist.pdf");
    const impossibleHtml = buildMinutesHtml(input({ decisions: 30, descriptionRepeat: 20 }));

    const error = await renderMinutesPdf(impossibleHtml).then(
      async (bytes) => {
        await writeFile(outputPath, bytes);
        return undefined;
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(MinutesPdfOverflowError);
    expect((error as Error).message).toMatch(/first-page overflow.*cannot fit/i);
    expect(await readFile(outputPath).then(() => true, () => false)).toBe(false);
  }, 30_000);

  test("allows appendices to span multiple pages while keeping the complete summary on page one", async () => {
    const info = await inspectPdf(await renderMinutesPdf(buildMinutesHtml(input({ transcriptLines: 120 }))));

    expect(info.pages).toBeGreaterThan(2);
    expect(info.pageText[0]).toContain("DECISION-1");
    expect(info.pageText[0]).toContain("ACTION-1");
    expect(info.pageText[0]).not.toContain("APPENDIX-OPEN");
    expect(info.pageText.slice(1).join("\n")).toContain("APPENDIX-OPEN");
    expect(info.pageText.slice(1).join("\n")).toContain("APPENDIX-LINE-120");
  }, 30_000);
});
