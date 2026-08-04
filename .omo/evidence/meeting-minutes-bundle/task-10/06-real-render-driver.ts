import puppeteer, { type Page } from "puppeteer";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMinutesHtml, type MinutesInput } from "../../../../src/minutes.ts";

const version = "canonical-v2";
const source = (start_seq: number, end_seq: number) => ({
  transcript_version_id: version, start_seq, end_seq,
});
const normal: MinutesInput = {
  meta: { title: "Release council", meetingDate: "2026-08-01", timeZone: "Asia/Seoul", purpose: "Final approval" },
  attendees: [{ attendeeId: "a", displayName: "Alice" }, { attendeeId: "b", displayName: "Bob" }],
  decisions: [{ description: "Release approved", attributedAttendeeId: "a", sourceSegment: source(1, 1) }],
  actions: [{ description: "Publish notes", attributedAttendeeId: "a", assigneeAttendeeId: "b", deadline: "2026-08-02", sourceSegment: source(2, 2) }],
  open: [{ description: "Observe launch metrics", attributedAttendeeId: "b", sourceSegment: source(3, 3) }],
  referencedMaterials: [{ materialType: "document", title: "Runbook", sourceSegment: source(3, 4) }],
  transcript: [
    { seq: 1, speakerTurn: 1, attributedAttendeeId: "a", text: "Release approved." },
    { seq: 2, speakerTurn: 2, attributedAttendeeId: "b", text: "I will publish notes." },
  ],
  transcriptVersionId: version,
};
const empty: MinutesInput = {
  ...normal,
  decisions: [], actions: [], open: [], referencedMaterials: [], transcript: [],
};

interface Observation {
  sections: number;
  firstPageBreakAfter: string;
  appendixBreakBefore: string;
  firstPageDecisionRows: number;
  firstPageActionRows: number;
  actionHeaders: string[];
  firstPageText: string;
  appendixText: string;
  provenanceCoordinates: string[];
  coordinateData: string[];
  canonicalTranscriptVersion: string | null;
  scriptElements: number;
}

async function inspect(page: Page, htmlPath: string, screenshotPath: string): Promise<Observation> {
  await page.goto(`file://${htmlPath}`, { waitUntil: "load" });
  await page.emulateMediaType("print");
  await page.evaluate(() => document.fonts.ready);
  const observation = await page.evaluate(() => {
    const first = document.querySelector<HTMLElement>(".first-page")!;
    const appendix = document.querySelector<HTMLElement>(".appendix-page")!;
    const canonical = document.querySelector<HTMLElement>(".canonical-transcript");
    return {
      sections: document.querySelectorAll("main > section").length,
      firstPageBreakAfter: getComputedStyle(first).breakAfter,
      appendixBreakBefore: getComputedStyle(appendix).breakBefore,
      firstPageDecisionRows: first.querySelectorAll(".decisions-block tbody tr").length,
      firstPageActionRows: first.querySelectorAll(".actions-block tbody tr").length,
      actionHeaders: [...first.querySelectorAll(".actions-block th")].map((node) => node.textContent ?? ""),
      firstPageText: first.textContent ?? "",
      appendixText: appendix.textContent ?? "",
      provenanceCoordinates: [...document.querySelectorAll(".source-coordinate")].map((node) => node.textContent ?? ""),
      coordinateData: [...document.querySelectorAll<HTMLElement>(".source-coordinate")].map((node) => node.dataset.sourceCoordinate ?? ""),
      canonicalTranscriptVersion: canonical?.dataset.transcriptVersionId ?? null,
      scriptElements: document.querySelectorAll("script").length,
    };
  });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return observation;
}

const renderDir = await mkdtemp(join(tmpdir(), "minutes-render-"));
const browser = await puppeteer.launch({ headless: true });
try {
  const normalPath = join(renderDir, "normal.html");
  const emptyPath = join(renderDir, "empty.html");
  await Promise.all([
    writeFile(normalPath, buildMinutesHtml(normal)),
    writeFile(emptyPath, buildMinutesHtml(empty)),
    cp(join(import.meta.dir, "../../../../deck/minutes.css"), join(renderDir, "minutes.css")),
    cp(join(import.meta.dir, "../../../../deck/theme.css"), join(renderDir, "theme.css")),
  ]);

  const page = await browser.newPage();
  await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on("request", (request) => request.url().startsWith("http") ? request.abort() : request.continue());

  const normalObservation = await inspect(page, normalPath, join(import.meta.dir, "06-real-render.png"));
  const emptyObservation = await inspect(page, emptyPath, join(import.meta.dir, "06-real-render-empty.png"));

  const normalExpected = [
    "(canonical-v2,1,1)", "(canonical-v2,2,2)", "(canonical-v2,3,3)",
    "(canonical-v2,3,4)", "(canonical-v2,1,1)", "(canonical-v2,2,2)",
  ];
  if (normalObservation.sections !== 2 || normalObservation.firstPageBreakAfter !== "page" ||
      normalObservation.appendixBreakBefore !== "page" || normalObservation.firstPageDecisionRows !== 1 ||
      normalObservation.firstPageActionRows !== 1 ||
      JSON.stringify(normalObservation.actionHeaders) !== JSON.stringify(["액션", "발언자", "담당자", "기한", "근거 좌표"]) ||
      !normalObservation.firstPageText.includes("Release approved") ||
      !normalObservation.firstPageText.includes("Publish notes") ||
      normalObservation.firstPageText.includes("Observe launch metrics") ||
      !normalObservation.appendixText.includes("Observe launch metrics") ||
      JSON.stringify(normalObservation.provenanceCoordinates) !== JSON.stringify(normalExpected) ||
      JSON.stringify(normalObservation.coordinateData) !== JSON.stringify(normalExpected) ||
      normalObservation.canonicalTranscriptVersion !== version || normalObservation.scriptElements !== 0) {
    throw new Error(`normal render contract failed: ${JSON.stringify(normalObservation)}`);
  }
  if (emptyObservation.sections !== 2 || emptyObservation.firstPageDecisionRows !== 1 ||
      emptyObservation.firstPageActionRows !== 1 || !emptyObservation.firstPageText.includes("결정 사항 없음") ||
      !emptyObservation.firstPageText.includes("액션 항목 없음") ||
      !emptyObservation.appendixText.includes("미결 또는 다음 안건 없음") ||
      !emptyObservation.appendixText.includes("참조 자료 없음") ||
      !emptyObservation.appendixText.includes("전사 원문 없음") ||
      emptyObservation.provenanceCoordinates.length !== 0 || emptyObservation.canonicalTranscriptVersion !== version) {
    throw new Error(`empty render contract failed: ${JSON.stringify(emptyObservation)}`);
  }

  console.log(JSON.stringify({
    driver: "buildMinutesHtml -> file URL -> real headless Chromium DOM",
    synchronization: "page load plus document.fonts.ready; no sleeps or polling",
    normal: normalObservation,
    empty: emptyObservation,
    cleanup: `removed ${renderDir} and closed Chromium`,
  }, null, 2));
} finally {
  await browser.close();
  await rm(renderDir, { recursive: true, force: true });
}
