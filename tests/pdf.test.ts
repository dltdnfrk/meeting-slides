import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { PDFDocument } from "pdf-lib";

import { buildMinutesHtml, type MinutesInput } from "../src/minutes.ts";
import { MinutesPdfOverflowError, renderMinutesPdf } from "../src/pdf.ts";

const version = "transcript-v1";

function input(decisionCount = 1, descriptionLength = 24): MinutesInput {
  const sourced = (index: number) => ({
    description: `Decision ${index + 1}: ${"release detail ".repeat(descriptionLength)}`,
    attributedAttendeeId: "alice",
    sourceSegment: { transcript_version_id: version, start_seq: index + 1, end_seq: index + 1 },
  });
  return {
    meta: {
      title: "Release council",
      meetingDate: "2026-08-01",
      timeZone: "Asia/Seoul",
      purpose: "Approve the production release",
    },
    attendees: [{ attendeeId: "alice", displayName: "Alice" }],
    decisions: Array.from({ length: decisionCount }, (_, index) => sourced(index)),
    actions: [{
      description: "Run final QA and publish the signed release report",
      assigneeAttendeeId: "alice",
      deadline: "2026-08-07",
      sourceSegment: { transcript_version_id: version, start_seq: decisionCount + 1, end_seq: decisionCount + 1 },
    }],
    open: [],
    referencedMaterials: [],
    transcript: [],
    transcriptVersionId: version,
  };
}

async function inspectPdf(bytes: Uint8Array): Promise<{ pages: number; width: number; height: number }> {
  const document = await PDFDocument.load(bytes);
  const first = document.getPage(0);
  return { pages: document.getPageCount(), ...first.getSize() };
}

async function rendererTemps(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("meeting-minutes-pdf-"));
}

describe("renderMinutesPdf", () => {
  test("prints a non-empty portrait A4 PDF with the complete summary before the appendix", async () => {
    const pdf = await renderMinutesPdf(buildMinutesHtml(input(2, 2)));
    const info = await inspectPdf(pdf);

    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(1_000);
    expect(info.pages).toBe(2);
    expect(info.width).toBeCloseTo(595.28, 0);
    expect(info.height).toBeCloseTo(841.89, 0);
    expect(info.height).toBeGreaterThan(info.width);
  }, 30_000);

  test("uses bounded shrink-to-fit for a dense summary without splitting its first page", async () => {
    const denseHtml = buildMinutesHtml(input(7, 5)).replace("</head>", `<style>
      html[data-minutes-fit="normal"] .first-page { min-height: 280mm !important; }
    </style></head>`);
    const pdf = await renderMinutesPdf(denseHtml);
    const info = await inspectPdf(pdf);

    expect(info.pages).toBe(2);
  }, 30_000);

  test("rejects impossible first pages instead of emitting a split PDF", async () => {
    const promise = renderMinutesPdf(buildMinutesHtml(input(30, 20)));

    await expect(promise).rejects.toBeInstanceOf(MinutesPdfOverflowError);
    await expect(promise).rejects.toThrow(/first-page overflow.*cannot fit/i);
  }, 30_000);

  test("reports Chromium launch failures and removes its temporary directory", async () => {
    const before = await rendererTemps();

    await expect(renderMinutesPdf(buildMinutesHtml(input()), {
      executablePath: "/definitely/missing/meeting-minutes-chromium",
    })).rejects.toThrow(/Chromium launch failed/i);

    expect(await rendererTemps()).toEqual(before);
  }, 30_000);
});
