// allow: SIZE_OK — one lifecycle fixture intentionally crosses browser, WebSocket, SQLite, publication, and artifact HTTP boundaries.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { prepareExportDeck } from "../src/deck-export.ts";
import type { BlockDetector, ChatTransport } from "../src/llm.ts";
import { deleteMeetingHistory } from "../src/meeting-deletion.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { resolveSlidePlanArtifact, SlidePlanArtifactError } from "../src/slide-plan-artifacts.ts";
import { SlidePlanStore, type StoredSlidePlanPublication } from "../src/slide-plan-store.ts";
import { MeetingSession, type CompileUpdate, type ReviewUpdate, type ServerMessage } from "../src/session.ts";
import {
  deleteMeetingForJobState,
  runSlidePlanServerAction,
  type SlidePlanTranscriptInput,
} from "../src/slides/server-action.ts";
import type { SlidePlanPublicationResult } from "../src/slides/server-pipeline.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../src/slides/theme/meeting-paper.ts";
import { MeetingStore } from "../src/store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";
import { createPublicTestHarness } from "./public-test-harness.ts";

const FONT = resolve(import.meta.dir, "../public/fonts/pretendard-variable.woff2");
const BROWSERS = resolve(import.meta.dir, "../vendor/ms-playwright");
const SLIDES_GRAB = resolve(import.meta.dir, "../node_modules/.bin/slides-grab");
const SANDBOX = "(version 1)(allow default)(deny network*)";
const temporaryDirectories: string[] = [];
const lifecycleStores: MeetingStore[] = [];
const harness = createPublicTestHarness();

function broadcast(message: ServerMessage): void {
  harness.pushMessage(message);
}

function waitForSessionMessage(
  listeners: Set<(message: ServerMessage) => void>,
  predicate: (message: ServerMessage) => boolean,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const listener = (message: ServerMessage) => {
      if (!predicate(message)) return;
      clearTimeout(timeout);
      listeners.delete(listener);
      resolve(message);
    };
    const timeout = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error("session event timeout"));
    }, 5_000);
    listeners.add(listener);
  });
}

async function waitForCard(page: Page, title: string): Promise<void> {
  await page.evaluate((expectedTitle) => {
    const root = document.getElementById("current-slide")!;
    const matches = () => root.querySelector(".live-scene__text--title")?.textContent === expectedTitle;
    (globalThis as unknown as { __cardRendered: Promise<void> }).__cardRendered = new Promise((resolve, reject) => {
      if (matches()) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`card render timeout: ${expectedTitle}`));
      }, 5_000);
      const observer = new MutationObserver(() => {
        if (!matches()) return;
        clearTimeout(timeout);
        observer.disconnect();
        resolve();
      });
      observer.observe(root, { childList: true, subtree: true });
    });
  }, title);
}

interface PromptSnapshot {
  transcriptVersionId: string;
  lines: ReadonlyArray<{ seq: number; speaker: string | null; text: string }>;
}

function snapshotFromPrompt(prompt: string): PromptSnapshot {
  const match = prompt.match(/<transcript-snapshot>([^<]+)<\/transcript-snapshot>/);
  if (match === null) throw new Error("missing transcript snapshot");
  return JSON.parse(match[1]!) as PromptSnapshot;
}

/** Fake provider: one claim bound verbatim to the live transcript, then all seven primary layouts. */
function slidePlanModelOutput(snapshot: PromptSnapshot, reviewed = false): string {
  const bind = ["claim-launch"];
  const base = (id: string, layout: string, title: string) => ({ id, layout, storyRole: "argument", title, editorialPaths: [], assetIds: [] });
  const quote = snapshot.lines[0]?.text ?? "금요일 베타 배포";
  const claim = {
    id: "claim-launch",
    kind: "decision",
    text: quote,
    sources: [{ transcriptVersionId: snapshot.transcriptVersionId, startSeq: 1, endSeq: 1, evidenceQuote: quote }],
    method: reviewed ? "reviewed" : "extractive",
  };
  const slides = [
    { ...base("slide-hero", "hero", "금요일 베타 출시"), storyRole: "opening", payload: { variant: "cover", statement: "출시 일정 확정" }, bindings: { title: bind, statement: bind } },
    { ...base("slide-summary", "summary", "출시 일정을 확정합니다"), payload: { mode: "overview", items: ["금요일 베타 배포"] }, bindings: { title: bind, "items[0]": bind } },
    { ...base("slide-decision", "decision", "금요일 배포가 확정되었습니다"), storyRole: "decision", payload: { decision: "금요일 배포", rationale: ["QA 완료"] }, bindings: { title: bind, decision: bind, "rationale[0]": bind } },
    { ...base("slide-comparison", "comparison", "배포 전후를 비교합니다"), payload: { sides: [{ label: "Before", items: ["일정 미정"] }, { label: "After", items: ["금요일 확정"] }] }, bindings: { title: bind, "sides[0].items[0]": bind, "sides[1].items[0]": bind }, editorialPaths: ["sides[0].label", "sides[1].label"] },
    { ...base("slide-timeline", "timeline", "배포 일정을 정리합니다"), payload: { mode: "process", events: [{ label: "금요일", text: "베타 배포" }] }, bindings: { title: bind, "events[0].text": bind }, editorialPaths: ["events[0].label"] },
    { ...base("slide-metrics", "metrics", "출시 지표를 확인합니다"), payload: { mode: "cards", metrics: [{ label: "배포일", value: "금요일", detail: "베타 출시" }] }, bindings: { title: bind, "metrics[0].label": bind, "metrics[0].value": bind, "metrics[0].detail": bind } },
    { ...base("slide-actions", "actions", "릴리스 작업을 마무리합니다"), storyRole: "commitment", payload: { items: [{ task: "릴리스 노트 작성", owner: "민지", due: "금요일" }] }, bindings: { title: bind, "items[0].task": bind, "items[0].owner": bind, "items[0].due": bind } },
  ];
  return JSON.stringify({
    schemaVersion: 1, revision: 0, title: "금요일 베타 출시",
    theme: MEETING_PAPER_STYLE_PROFILE, claims: [claim], assets: [], slides,
  });
}

const CANONICAL_TEXT = "금요일에 베타를 배포하고 목요일까지 QA를 끝냅니다.";
const REVIEW_ID = "review-hybrid-lifecycle";
const TRANSCRIPT_ID = "transcript-hybrid-lifecycle";
const REVIEW_ITEM_ID = "claim-launch";
const EVIDENCE_DIRECTORY = resolve(
  import.meta.dir,
  "../.omo/evidence/ulw-execute/draft-final-review-fixes/task-7",
);

type LifecycleDomain = Readonly<{
  root: string;
  databasePath: string;
  meetingStore: MeetingStore;
  minutesStore: MinutesStore;
  publications: SlidePlanStore;
  meetingId: number;
  contentSha256: string;
}>;

type LifecycleEvidence = {
  happy?: Record<string, unknown>;
  failure?: Record<string, unknown>;
};

const lifecycleEvidence: LifecycleEvidence = {};
let browser: Browser;
let page: Page;
let suiteDirectory: string;
let seedDraft: SlidePlanPublicationResult;

function lifecycleDomain(prefix: string): LifecycleDomain {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const databasePath = join(root, "meetings.db");
  const meetingStore = new MeetingStore(databasePath);
  lifecycleStores.push(meetingStore);
  const minutesStore = new MinutesStore(meetingStore.databaseHandle());
  const meetingId = meetingStore.startMeeting("fake-lifecycle");
  minutesStore.addAttendees(meetingId, [{ attendeeId: "attendee-mina", displayName: "민지" }]);
  const version = minutesStore.addTranscriptVersion(meetingId, {
    transcriptVersionId: TRANSCRIPT_ID,
    sourceKind: "import",
  });
  minutesStore.addTranscriptVersionLines(version.transcriptVersionId, [{
    seq: 1,
    capturedAtMs: 10,
    speakerTurn: 1,
    text: CANONICAL_TEXT,
  }]);
  const contentSha256 = transcriptContentSha256(minutesStore, version.transcriptVersionId);
  minutesStore.finalizeTranscriptVersion(version.transcriptVersionId, contentSha256);
  minutesStore.setCanonical(meetingId, version.transcriptVersionId);
  minutesStore.saveCandidates({
    reviewId: REVIEW_ID,
    meetingId,
    transcriptVersionId: version.transcriptVersionId,
    decisions: [{
      id: REVIEW_ITEM_ID,
      description: CANONICAL_TEXT,
      evidenceQuote: CANONICAL_TEXT,
      source: { transcriptVersionId: version.transcriptVersionId, startSeq: 1, endSeq: 1 },
      attributedAttendeeId: "attendee-mina",
      reviewState: "confirmed",
    }],
  });
  return {
    root,
    databasePath,
    meetingStore,
    minutesStore,
    publications: new SlidePlanStore(meetingStore.databaseHandle()),
    meetingId,
    contentSha256,
  };
}

function confirmedTranscript(domain: LifecycleDomain): SlidePlanTranscriptInput {
  const review = domain.minutesStore.review(REVIEW_ID);
  if (review?.status !== "confirmed" || review.confirmedAt === null) {
    throw new Error("lifecycle Review must be confirmed");
  }
  const evidence = {
    reviewId: REVIEW_ID,
    transcriptVersionId: TRANSCRIPT_ID,
    items: [{
      id: REVIEW_ITEM_ID,
      kind: "decision" as const,
      description: CANONICAL_TEXT,
      source: {
        transcriptVersionId: TRANSCRIPT_ID,
        startSeq: 1,
        endSeq: 1,
        evidenceQuote: CANONICAL_TEXT,
      },
      reviewState: "confirmed" as const,
      attributedAttendeeId: "attendee-mina",
    }],
    attendees: [{ attendeeId: "attendee-mina", displayName: "민지" }],
  };
  Object.defineProperty(evidence, "confirmedAt", { value: review.confirmedAt });
  return {
    state: "finalized",
    transcriptVersionId: TRANSCRIPT_ID,
    contentSha256: domain.contentSha256,
    lines: [{ seq: 1, speaker: "1", text: CANONICAL_TEXT }],
    confirmedReview: evidence,
  };
}

function installDraft(domain: LifecycleDomain): ReturnType<SlidePlanStore["save"]> {
  const directory = join(domain.root, "publications", "retained-draft");
  cpSync(seedDraft.directory, directory, { recursive: true });
  return domain.publications.save({ ...seedDraft, directory }, 200);
}

function browserReview(domain: LifecycleDomain, status: "draft" | "confirmed"): ReviewUpdate {
  const review = domain.minutesStore.review(REVIEW_ID);
  return {
    type: "review",
    meetingId: domain.meetingId,
    reviewId: REVIEW_ID,
    transcriptVersionId: TRANSCRIPT_ID,
    status,
    confirmedAt: review?.confirmedAt ?? null,
    attendees: [{ attendeeId: "attendee-mina", displayName: "민지" }],
    transcript: { lines: [{ seq: 1, speakerTurn: 1, text: CANONICAL_TEXT }] },
    items: [{
      id: REVIEW_ITEM_ID,
      kind: "decision",
      description: CANONICAL_TEXT,
      evidenceQuote: CANONICAL_TEXT,
      segment_text: CANONICAL_TEXT,
      sourceSegment: { transcript_version_id: TRANSCRIPT_ID, start_seq: 1, end_seq: 1 },
      reviewState: "confirmed",
      attributedAttendeeId: "attendee-mina",
    }],
  };
}

function publicationMessage(
  domain: LifecycleDomain,
  publication: StoredSlidePlanPublication,
  review: ReviewUpdate,
): ServerMessage {
  return {
    type: "meeting",
    meetingId: domain.meetingId,
    title: "금요일 베타 출시",
    transcript: [{ text: CANONICAL_TEXT, ts: 10, speaker: 1 }],
    current: null,
    history: [],
    compiled: null,
    review,
    slidePlan: {
      plan: publication.plan,
      path: publication.path,
      publicationSha256: publication.publicationSha256,
      publicationStatus: publication.publicationStatus,
      publishedAt: publication.publishedAt,
      ...(publication.reviewId === undefined ? {} : { reviewId: publication.reviewId }),
      ...(publication.reviewedItemIds === undefined ? {} : { reviewedItemIds: publication.reviewedItemIds }),
    },
  };
}

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith(harness.origin)) void request.continue();
    else void request.abort();
  });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
  // 실서버는 연결 직후 capture 상태를 전송한다. 슬라이드를 렌더하려면 녹음 중(capturing) 상태가 필요하다.
  harness.pushMessage({ type: "capture", capturing: true, mode: "mic" });
  // capture 처리가 끝나기를 기다린다 (버튼이 녹음 중 상태로 전환되면 반영 완료).
  await page.waitForFunction(() =>
    (document.getElementById("btn-record") as HTMLButtonElement)?.textContent?.includes("녹음 중지"),
    { timeout: 5_000 },
  );
  suiteDirectory = mkdtempSync(join(tmpdir(), "meeting-slides-lifecycle-seed-"));
  const seedHash = createHash("sha256").update(`${JSON.stringify({
    seq: 1,
    ts: 10,
    speaker_turn: 1,
    text: CANONICAL_TEXT,
  })}\n`).digest("hex");
  seedDraft = await runSlidePlanServerAction({
    jobId: "compile-lifecycle-seed" as const,
    meetingId: 1,
    transcript: {
      state: "finalized",
      transcriptVersionId: TRANSCRIPT_ID,
      contentSha256: seedHash,
      lines: [{ seq: 1, speaker: "1", text: CANONICAL_TEXT }],
    },
    transport: { chat: async (prompt) => slidePlanModelOutput(snapshotFromPrompt(prompt)) },
    outputRoot: join(suiteDirectory, "output"),
    cacheRoot: join(suiteDirectory, "cache"),
    fontSourcePath: FONT,
    tools: {
      slidesGrabPath: SLIDES_GRAB,
      playwrightBrowsersPath: BROWSERS,
      sandboxExecutable: "/usr/bin/sandbox-exec",
      sandboxProfile: SANDBOX,
      timeoutMs: 120_000,
    },
    createId: () => "lifecycle-draft-plan",
    now: () => "2026-08-20T10:00:00.000Z",
    send: () => {},
  });
}, 120_000);

afterEach(() => {
  for (const store of lifecycleStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

afterAll(async () => {
  await browser?.close();
  harness.stop();
  rmSync(suiteDirectory, { recursive: true, force: true });
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  if (lifecycleEvidence.happy !== undefined && lifecycleEvidence.failure !== undefined) {
    writeFileSync(join(EVIDENCE_DIRECTORY, "lifecycle.json"), `${JSON.stringify({
      ...lifecycleEvidence.happy,
      failure: lifecycleEvidence.failure,
      cleanup: {
        browserClosed: true,
        harnessStopped: true,
        temporaryDirectories: temporaryDirectories.length,
        suiteDirectoryRemoved: !existsSync(suiteDirectory),
      },
    }, null, 2)}\n`);
  }
});

describe("Hybrid live -> compile -> export hermetic path", () => {
  test("renders a detected MeetingCard, then publishes the four-format SlidePlan deck from the same transcript", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meeting-slides-hybrid-e2e-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "meetings.db");
    const store = new MeetingStore(databasePath);
    const meetingId = store.startMeeting("fake-hermetic");
    const detector: BlockDetector = {
      ping: async () => true,
      detectBlock: async () => ({
        shouldAdvance: false,
        title: "출시 일정 확정",
        kicker: "라이브 감지",
        bullets: ["베타는 금요일", "QA는 목요일까지"],
        emphasis: "결정: 금요일 베타 배포",
      }),
    };
    const listeners = new Set<(message: ServerMessage) => void>([broadcast]);
    const session = new MeetingSession(detector, 1, 12, listeners, {
      onLine: (line) => store.addLine(line),
      onSlide: (slide) => store.upsertSlide({
        idx: slide.index,
        title: slide.title,
        bullets: slide.bullets,
        startedAt: slide.startedAt,
      }),
    });

    await waitForCard(page, "출시 일정 확정");
    const detectionFinished = waitForSessionMessage(
      listeners,
      (message) => message.type === "detect" && !message.detecting,
    );
    session.onChunk({ text: "금요일에 베타를 배포하고 목요일까지 QA를 끝냅니다.", ts: 1_700_000_000_000, speaker: 1 });
    await Promise.all([
      detectionFinished,
      page.evaluate(() => (globalThis as unknown as { __cardRendered: Promise<void> }).__cardRendered),
    ]);

    const liveCard = await page.evaluate(() => {
      const root = document.getElementById("current-slide")!;
      return {
        title: root.querySelector(".live-scene__text--title")?.textContent,
        statement: root.querySelector(".live-scene__text--statement")?.textContent,
        body: root.querySelector(".live-scene__text--body")?.textContent,
      };
    });
    expect(liveCard).toEqual({
      title: "출시 일정 확정",
      statement: "베타는 금요일 QA는 목요일까지",
      body: "결정: 금요일 베타 배포",
    });
    expect(store.lines(meetingId).map((line) => line.text)).toEqual([
      "금요일에 베타를 배포하고 목요일까지 QA를 끝냅니다.",
    ]);
    expect(store.slides(meetingId)).toHaveLength(1);

    const legacy = prepareExportDeck(store, meetingId);
    expect(legacy.source).toBe("legacy");
    expect(legacy.indexHtml).toContain("출시 일정 확정");

    const transcript: SlidePlanTranscriptInput = {
      state: "live",
      lines: store.lines(meetingId).map((line) => ({
        seq: line.seq,
        speaker: line.speaker === null ? null : String(line.speaker),
        text: line.text,
      })),
    };
    const transport: ChatTransport = { chat: async (prompt) => slidePlanModelOutput(snapshotFromPrompt(prompt)) };
    const jobId = "compile-hybrid-slide-plan" as const;
    const events: CompileUpdate[] = [];
    const result = await runSlidePlanServerAction({
      jobId,
      meetingId,
      transcript,
      transport,
      outputRoot: join(directory, "slide-plans"),
      cacheRoot: join(directory, "slide-plan-cache"),
      fontSourcePath: FONT,
      tools: {
        slidesGrabPath: SLIDES_GRAB,
        playwrightBrowsersPath: BROWSERS,
        sandboxExecutable: "/usr/bin/sandbox-exec",
        sandboxProfile: SANDBOX,
        timeoutMs: 120_000,
      },
      createId: () => "hybrid-slide-plan",
      now: () => "2026-08-02T12:34:56.000Z",
      send: (event) => {
        events.push(event);
        broadcast(event);
      },
    });

    expect(events[events.length - 1]).toMatchObject({
      type: "compile", status: "success", jobId, meetingId, path: result.directory,
    });
    const publication = JSON.parse(readFileSync(join(result.directory, "publication.json"), "utf8")) as { artifacts: ReadonlyArray<{ format: string; files: ReadonlyArray<{ relativePath: string }> }> };
    expect(publication.artifacts.map((artifact) => artifact.format).sort()).toEqual(["editable-pptx", "raster-png-pdf", "standalone-html"]);
    const publishedFiles = publication.artifacts.flatMap((artifact) => artifact.files.map((file) => file.relativePath));
    expect(publishedFiles).toEqual(expect.arrayContaining(["standalone/index.html", "editable/deck.pptx", "raster/deck.pdf"]));
    expect(publishedFiles.filter((name) => /^raster\/png\/[^/]+\.png$/.test(name))).not.toHaveLength(0);
    session.reset();
    store.close();
  }, 120_000);

  test("shows the compile-busy guard and writes no export while a compile holds the job", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meeting-slides-hybrid-busy-"));
    temporaryDirectories.push(directory);
    const store = new MeetingStore(join(directory, "meetings.db"));
    const meetingId = store.startMeeting("fake-hermetic");
    store.addLine({ ts: 1_700_000_000_000, text: "안전한 요약만 덱에 포함합니다." });
    store.addSlide({ idx: 1, title: "안전한 라이브 카드", bullets: ["모델 HTML 금지"], startedAt: 1_699_999_999_000 });
    expect(prepareExportDeck(store, meetingId).source).toBe("legacy");

    const exportsDirectory = join(directory, "exports");
    const exportDirectoryCount = existsSync(exportsDirectory) ? readdirSync(exportsDirectory).length : 0;
    broadcast({
      type: "export",
      status: "error",
      action: "exportPdf",
      jobId: "pdf-hybrid-busy",
      code: "job-busy",
      error: "Deck compile is in progress; export was not started",
    });
    await page.waitForFunction(
      () => document.getElementById("status-text")?.textContent === "슬라이드를 만드는 중에는 다른 파일을 저장할 수 없습니다",
      { timeout: 5_000 },
    );
    expect(existsSync(exportsDirectory) ? readdirSync(exportsDirectory).length : 0).toBe(exportDirectoryCount);
    store.close();
  });

  test("draft edit confirm creates a distinct final while retaining the draft", async () => {
    // Given: one canonical transcript, a real draft row/directory, and a browser-local edit.
    const domain = lifecycleDomain("meeting-slides-lifecycle-happy-");
    const draft = installDraft(domain);
    harness.pushMessage({
      type: "meetings",
      items: [{ id: domain.meetingId, title: "금요일 베타 출시", started_at: 10, status: "ended" }],
    });
    await page.waitForSelector(`.session-row[data-meeting-id="${domain.meetingId}"]`);
    const selection = harness.nextClientMessage();
    await page.$eval(`.session-row[data-meeting-id="${domain.meetingId}"]`, (node) => {
      (node as HTMLButtonElement).click();
    });
    expect(await selection).toEqual({ action: "selectMeeting", meetingId: domain.meetingId });
    broadcast(publicationMessage(domain, draft, browserReview(domain, "draft")));
    await page.waitForSelector('[data-slide-plan-workspace][data-publication-status="draft"]');
    await page.$eval("[data-slide-title-input]", (node) => {
      const input = node as HTMLInputElement;
      input.value = "브라우저에서만 편집한 제목";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => (window as typeof window & {
      __slidePlanWorkspace?: { isDirty: () => boolean };
    }).__slidePlanWorkspace?.isDirty() === true);
    const editedDraft = await page.evaluate(() => (window as typeof window & {
      __slidePlanWorkspace?: { currentPlan: () => unknown };
    }).__slidePlanWorkspace?.currentPlan());

    // When: Review confirmation arrives and the exact rebuild dialog is accepted once.
    domain.minutesStore.confirmReview(REVIEW_ID, "hybrid-reviewer");
    const review = domain.minutesStore.review(REVIEW_ID);
    if (review?.confirmedAt === null || review?.confirmedAt === undefined) {
      throw new Error("confirmed Review timestamp missing");
    }
    broadcast({
      type: "reviewConfirmed",
      meetingId: domain.meetingId,
      reviewId: REVIEW_ID,
      transcriptVersionId: TRANSCRIPT_ID,
      confirmedAt: review.confirmedAt,
    });
    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    await page.click("#btn-compile-deck");
    await page.waitForSelector("#slide-final-rebuild-dialog:not([hidden])");
    expect(await page.$eval("#slide-final-rebuild-dialog", (dialog) => ({
      title: dialog.querySelector("h2")?.textContent?.trim(),
      body: dialog.querySelector("p")?.textContent?.trim(),
    }))).toEqual({
      title: "확정본을 새로 만들까요?",
      body: "검토가 확정되어 현재 초안의 로컬 편집은 확정본에 저장할 수 없습니다. 새 확정본은 확정된 검토 내용으로 다시 만들며, 저장된 초안은 그대로 남습니다. 현재 로컬 편집은 확정본에 포함되지 않습니다.",
    });
    await page.evaluate(() => {
      const state = window as typeof window & {
        __lifecycleFrames?: unknown[];
        __lifecycleOriginalSend?: typeof WebSocket.prototype.send;
      };
      state.__lifecycleFrames = [];
      state.__lifecycleOriginalSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function send(data): void {
        state.__lifecycleFrames?.push(JSON.parse(String(data)) as unknown);
        state.__lifecycleOriginalSend?.call(this, data);
      };
    });
    const compileFrame = harness.nextClientMessage();
    await page.click("#btn-slide-final-rebuild-confirm");
    const observedFrame = await compileFrame;
    expect(observedFrame).toEqual({ action: "compileSlidePlan", meetingId: domain.meetingId });

    const events: CompileUpdate[] = [];
    const jobId = "compile-lifecycle-final" as const;
    broadcast({ type: "compile", status: "started", jobId, meetingId: domain.meetingId, stage: "planning" });
    const finalResult = await runSlidePlanServerAction({
      jobId,
      meetingId: domain.meetingId,
      transcript: confirmedTranscript(domain),
      transport: { chat: async (prompt) => slidePlanModelOutput(snapshotFromPrompt(prompt), true) },
      outputRoot: join(domain.root, "publications"),
      cacheRoot: join(domain.root, "cache"),
      fontSourcePath: FONT,
      tools: {
        slidesGrabPath: SLIDES_GRAB,
        playwrightBrowsersPath: BROWSERS,
        sandboxExecutable: "/usr/bin/sandbox-exec",
        sandboxProfile: SANDBOX,
        timeoutMs: 120_000,
      },
      createId: () => "lifecycle-final-plan",
      retainedDraftPlanId: draft.plan.planId,
      now: () => "2026-08-20T09:00:00.000Z",
      send: (event) => { events.push(event); broadcast(event); },
      commit: (result) => { domain.publications.save(result, 100); },
    });
    const final = domain.publications.latest(domain.meetingId);
    if (final === null) throw new Error("final publication missing after commit");
    broadcast(publicationMessage(domain, final, browserReview(domain, "confirmed")));
    await page.waitForSelector('[data-slide-plan-workspace][data-publication-status="final"]');

    // Then: sequence, receipt, browser authority, and draft artifact access all agree.
    const persisted = [...domain.publications.list(domain.meetingId)].reverse();
    expect(persisted.map((entry) => entry.publicationStatus)).toEqual(["draft", "final"]);
    expect(persisted.map((entry) => entry.plan.planId)).toEqual([
      "lifecycle-draft-plan",
      "lifecycle-final-plan",
    ]);
    expect(persisted.map((entry) => entry.revision)).toEqual([0, 0]);
    expect(persisted[0]?.publicationSeq).toBeLessThan(persisted[1]?.publicationSeq ?? 0);
    expect(persisted[0]?.path).not.toBe(persisted[1]?.path);
    expect(existsSync(persisted[0]?.path ?? "")).toBe(true);
    expect(existsSync(persisted[1]?.path ?? "")).toBe(true);
    expect(final.finalityReceipt).toEqual({
      reviewId: REVIEW_ID,
      confirmedAt: review.confirmedAt,
      transcriptVersionId: TRANSCRIPT_ID,
      contentSha256: domain.contentSha256,
      reviewedItemIds: [REVIEW_ITEM_ID],
    });
    expect(JSON.parse(readFileSync(join(final.path, "publication.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      publicationStatus: "final",
      finalityReceipt: final.finalityReceipt,
    });
    const browserState = await page.evaluate(() => {
      const workspace = (window as typeof window & {
        __slidePlanWorkspace?: {
          isDirty: () => boolean;
          currentPlan: () => { planId: string } | null;
        };
      }).__slidePlanWorkspace;
      return {
        title: document.querySelector("[data-slide-plan-title]")?.textContent?.trim(),
        status: document.querySelector("[data-slide-plan-workspace]")?.getAttribute("data-publication-status"),
        dirty: workspace?.isDirty(),
        planId: workspace?.currentPlan()?.planId,
      };
    });
    expect(browserState).toEqual({
      title: "금요일 베타 출시",
      status: "final",
      dirty: false,
      planId: "lifecycle-final-plan",
    });
    expect(JSON.stringify(editedDraft)).toContain("브라우저에서만 편집한 제목");
    expect(final.planJson).not.toContain("브라우저에서만 편집한 제목");

    const artifactServer = Bun.serve({
      port: 0,
      async fetch(request) {
        try {
          const artifact = await resolveSlidePlanArtifact(new URL(request.url).pathname, domain.publications);
          return new Response(Bun.file(artifact.filePath), {
            headers: { "content-type": artifact.contentType, "content-disposition": artifact.disposition },
          });
        } catch (error) {
          if (error instanceof SlidePlanArtifactError) return new Response(error.message, { status: error.status });
          throw error;
        }
      },
    });
    let artifactStatus = 0;
    let artifactReadable = false;
    try {
      const response = await fetch(
        `http://127.0.0.1:${artifactServer.port}/slide-plan-artifacts/${encodeURIComponent(draft.plan.planId)}/standalone/index.html`,
      );
      artifactStatus = response.status;
      artifactReadable = (await response.text()).includes("금요일 베타 출시");
    } finally {
      artifactServer.stop(true);
    }
    expect({ artifactStatus, artifactReadable }).toEqual({ artifactStatus: 200, artifactReadable: true });

    const sentFrames = await page.evaluate(() => {
      const state = window as typeof window & {
        __lifecycleFrames?: unknown[];
        __lifecycleOriginalSend?: typeof WebSocket.prototype.send;
      };
      const captured = state.__lifecycleFrames ?? [];
      if (state.__lifecycleOriginalSend !== undefined) WebSocket.prototype.send = state.__lifecycleOriginalSend;
      delete state.__lifecycleFrames;
      delete state.__lifecycleOriginalSend;
      return captured;
    });
    const noDuplicate = harness.nextClientMessage();
    await page.click("#btn-export-md");
    expect(await noDuplicate).toEqual({ action: "saveNotes", meetingId: domain.meetingId });
    const actions = sentFrames.flatMap((frame) =>
      typeof frame === "object" && frame !== null && "action" in frame && typeof frame.action === "string"
        ? [frame.action]
        : []);
    const frames = {
      compileSlidePlan: actions.filter((action) => action === "compileSlidePlan").length,
      persistSlidePlan: actions.filter((action) => action === "persistSlidePlan").length,
    };
    expect(frames).toEqual({ compileSlidePlan: 1, persistSlidePlan: 0 });
    lifecycleEvidence.happy = {
      frames,
      publications: persisted.map((entry) => ({
        publicationId: entry.publicationId,
        planId: entry.plan.planId,
        revision: entry.revision,
        path: entry.path,
        status: entry.publicationStatus,
        sequence: entry.publicationSeq,
        publishedAt: entry.publishedAt,
      })),
      identityRoot: {
        meetingId: domain.meetingId,
        canonicalTranscriptVersionId: TRANSCRIPT_ID,
        canonicalContentSha256: domain.contentSha256,
        reviewId: REVIEW_ID,
        reviewedItemIds: [REVIEW_ITEM_ID],
      },
      receipt: {
        ...final.finalityReceipt,
        receiptSha256: createHash("sha256").update(`${JSON.stringify(final.finalityReceipt)}\n`).digest("hex"),
        publicationSha256: final.publicationSha256,
      },
      authoritativeFinal: browserState,
      draftArtifactHttp: {
        route: `/slide-plan-artifacts/${encodeURIComponent(draft.plan.planId)}/standalone/index.html`,
        status: artifactStatus,
        readable: artifactReadable,
      },
      directoriesDistinct: draft.path !== finalResult.directory,
    };
  }, 120_000);

  test("delete blocked before commit and provenance drift leaves zero residue", async () => {
    // Given: a separate file-backed domain with retained draft and confirmed same-DB provenance.
    const domain = lifecycleDomain("meeting-slides-lifecycle-failure-");
    const draft = installDraft(domain);
    domain.minutesStore.confirmReview(REVIEW_ID, "hybrid-reviewer");
    const events: CompileUpdate[] = [];
    let signalCommitEntered: (() => void) | undefined;
    const commitEntered = new Promise<void>((resolveEntered) => { signalCommitEntered = resolveEntered; });
    let signalReleaseCommit: (() => void) | undefined;
    const releaseCommit = new Promise<void>((resolveRelease) => { signalReleaseCommit = resolveRelease; });
    const chronology: string[] = [];

    // When: publication reaches the exact pre-commit barrier, deletion is blocked, and one item drifts.
    const pending = runSlidePlanServerAction({
      jobId: "compile-lifecycle-drift" as const,
      meetingId: domain.meetingId,
      transcript: confirmedTranscript(domain),
      transport: { chat: async (prompt) => slidePlanModelOutput(snapshotFromPrompt(prompt), true) },
      outputRoot: join(domain.root, "publications"),
      cacheRoot: join(domain.root, "cache"),
      fontSourcePath: FONT,
      tools: {
        slidesGrabPath: SLIDES_GRAB,
        playwrightBrowsersPath: BROWSERS,
        sandboxExecutable: "/usr/bin/sandbox-exec",
        sandboxProfile: SANDBOX,
        timeoutMs: 120_000,
      },
      createId: () => "lifecycle-drift-final-plan",
      retainedDraftPlanId: draft.plan.planId,
      now: () => "2026-08-20T08:00:00.000Z",
      send: (event) => { events.push(event); },
      commit: async (result) => {
        chronology.push("commit-entered");
        signalCommitEntered?.();
        await releaseCommit;
        chronology.push("commit-released");
        domain.publications.save(result, 50);
      },
    });
    await commitEntered;
    const deletion = deleteMeetingForJobState({
      meetingId: domain.meetingId,
      activeJob: { meetingId: domain.meetingId, action: "compileSlidePlan" },
      deleteHistory: (meetingId) => deleteMeetingHistory(domain.meetingStore.databaseHandle(), meetingId),
    });
    chronology.push("delete-blocked");
    expect(deletion).toEqual({ kind: "blocked", message: "슬라이드 작업 중인 회의는 삭제할 수 없습니다" });
    const driftHandle = new Database(domain.databasePath);
    driftHandle.run("PRAGMA busy_timeout = 5000");
    driftHandle.run(
      "UPDATE decisions SET review_state = 'rejected' WHERE review_id = ? AND decision_id = ?",
      [REVIEW_ID, REVIEW_ITEM_ID],
    );
    driftHandle.close();
    chronology.push("review-item-rejected");
    signalReleaseCommit?.();

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }

    // Then: one coded failure leaves no attempt row/directory while retaining lineage and draft bytes.
    const errorFrames = events.filter((event) => event.status === "error");
    expect(failure).toMatchObject({ name: "SlidePlanFinalityError" });
    expect(events.filter((event) => event.status === "success")).toEqual([]);
    expect(errorFrames).toEqual([expect.objectContaining({ code: "stale-review-lineage" })]);
    expect(domain.meetingStore.databaseHandle().query(
      "SELECT count(*) AS count FROM slide_plan_publications WHERE plan_id = ?",
    ).get("lifecycle-drift-final-plan")).toEqual({ count: 0 });
    expect(domain.publications.list(domain.meetingId).map((entry) => entry.plan.planId)).toEqual([
      "lifecycle-draft-plan",
    ]);
    const attemptedDirectory = join(
      domain.root,
      "publications",
      `meeting-${domain.meetingId}-${domain.contentSha256}-${createHash("sha256").update("lifecycle-drift-final-plan").digest("hex").slice(0, 12)}-final`,
    );
    expect(existsSync(attemptedDirectory)).toBe(false);
    expect(readdirSync(join(domain.root, "publications"))).toEqual(["retained-draft"]);
    expect(domain.meetingStore.databaseHandle().query(
      "SELECT status FROM meeting_reviews WHERE review_id = ?",
    ).get(REVIEW_ID)).toEqual({ status: "confirmed" });
    expect(domain.meetingStore.databaseHandle().query(
      "SELECT review_state FROM decisions WHERE review_id = ? AND decision_id = ?",
    ).get(REVIEW_ID, REVIEW_ITEM_ID)).toEqual({ review_state: "rejected" });
    expect(domain.meetingStore.databaseHandle().query(
      "SELECT canonical_transcript_version_id FROM meeting_transcript_state WHERE meeting_id = ?",
    ).get(domain.meetingId)).toEqual({ canonical_transcript_version_id: TRANSCRIPT_ID });
    expect(domain.meetingStore.databaseHandle().query(
      "SELECT id FROM meetings WHERE id = ?",
    ).get(domain.meetingId)).toEqual({ id: domain.meetingId });
    expect(chronology).toEqual([
      "commit-entered",
      "delete-blocked",
      "review-item-rejected",
      "commit-released",
    ]);

    lifecycleEvidence.failure = {
      blockedDelete: deletion,
      drift: {
        fact: `${REVIEW_ITEM_ID}.review_state`,
        value: "rejected",
        errorName: failure instanceof Error ? failure.name : typeof failure,
        code: errorFrames[0]?.code ?? null,
        successFrames: events.filter((event) => event.status === "success").length,
        errorFrames: errorFrames.length,
      },
      residue: {
        attemptedPlanId: "lifecycle-drift-final-plan",
        attemptedDirectory,
        attemptedDirectoryRemoved: !existsSync(attemptedDirectory),
        finalRows: 0,
        orphanDirectories: 0,
        directoryEntries: readdirSync(join(domain.root, "publications")),
      },
      retained: {
        meetingId: domain.meetingId,
        draftPublicationId: draft.publicationId,
        draftPath: draft.path,
        reviewId: REVIEW_ID,
        transcriptVersionId: TRANSCRIPT_ID,
        reviewedItemId: REVIEW_ITEM_ID,
      },
      chronology,
    };
  }, 120_000);
});
