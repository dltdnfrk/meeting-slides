import { localWebSocket, startMeetingServer, type RunningMeetingServer } from "./helpers/meeting-server.ts";
// allow: SIZE_OK — focused dispatch cases share one signal-driven server lifecycle and isolated database.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { transcriptLinesHash } from "../src/minutes-store-utils.ts";
import { SlidePlanStore, type SlidePlanPublicationWrite } from "../src/slide-plan-store.ts";
import { saveScenePublication } from "../src/scene-store.ts";
import type { PipelineIdentity } from "../src/slides/server-pipeline.ts";
import type { PlanSlide, SlidePlan, Theme } from "../src/slides/model/plan.ts";
import { MeetingStore } from "../src/store.ts";
import { runSlidePlanServerAction } from "../src/slides/server-action.ts";

const root = join(import.meta.dir, "..");
/**
 * Per-await deadline for this suite.
 *
 * It bounds REAL work: this test spawns an actual server process, starts and
 * stops an actual capture, and waits for the actual transcript flush and file
 * writes. Nothing here sleeps or polls - every await is settled by a socket
 * message or a process log line - so the bound exists only to turn a genuine
 * hang into a failure. At 10s it was already marginal before this task (the
 * flush alone measured 4.3-10.0s across runs on this machine), so it is raised
 * to leave headroom for the authoritative-idle frame that is now asserted too.
 */
const timeoutMs = 30_000;
let running: RunningMeetingServer;
let socket: WebSocket;
let startupStatus: Record<string, unknown>;
let tempDir: string;
let port: number;
const messages: Record<string, unknown>[] = [];
const createdArtifacts: string[] = [];
let captureWorkingDirectoryBaseline: readonly string[] = [];
let ownedCaptureWorkingDirectories: readonly string[] = [];
let compileRelease: ReturnType<typeof Promise.withResolvers<void>> | undefined;

function captureWorkingDirectories(): readonly string[] {
  return readdirSync(join(tempDir, "exports"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^audio-\d+-\d+\.wav\.capture$/.test(entry.name))
    .map((entry) => join(tempDir, "exports", entry.name))
    .sort();
}

function waitFor<T>(subscribe: (done: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    subscribe(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function waitForMessageAfter(start: number, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const existing = messages.slice(start).find(predicate);
  if (existing) return Promise.resolve(existing);
  return waitFor<Record<string, unknown>>((done) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (predicate(message)) {
        socket.removeEventListener("message", onMessage);
        done(message);
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

async function sendAndWait(
  payload: string | Record<string, unknown>,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const start = messages.length;
  const pending = waitForMessageAfter(start, predicate);
  socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  return pending;
}

async function connect(onMessage?: (message: Record<string, unknown>) => void): Promise<WebSocket> {
  const ws = localWebSocket(port);
  if (onMessage) {
    ws.addEventListener("message", (event) => onMessage(JSON.parse(String(event.data)) as Record<string, unknown>));
  }
  await waitFor<void>((done, fail) => {
    ws.addEventListener("open", () => done(), { once: true });
    ws.addEventListener("error", () => fail(new Error("websocket connection failed")), { once: true });
  });
  return ws;
}

beforeAll(async () => {

  tempDir = mkdtempSync(join(tmpdir(), "meeting-slides-ws-"));
  const fakeCli = join(tempDir, "fake-cli");
  const fakeWhisper = join(tempDir, "fake-whisper");
  writeFileSync(fakeCli, "#!/bin/sh\necho fake-cli-1.0\n");
  writeFileSync(fakeWhisper, `#!/usr/bin/env bun\nprocess.on("SIGTERM", () => process.exit(0));\nconsole.log("[00:00:00.000 --> 00:00:01.000] 기준선 발화입니다.");\nawait new Promise(() => {});\n`);
  chmodSync(fakeCli, 0o755);
  chmodSync(fakeWhisper, 0o755);

  port = 18_700 + (process.pid % 500);
  running = startMeetingServer({
    ...process.env,
    HTTP_PORT: String(port),
    OPEN_BROWSER: "false",
    MEETINGS_DB_PATH: join(tempDir, "meetings.db"),
    // 사용자 실제 설정(저장된 provider)이 서버에 복원돼 실제 LLM CLI/네트워크
    // 호출이 일어나면 블록 감지가 30s 이상 걸려 이 테스트가 flake가 된다.
    // 설정 루트를 임시 디렉터리로 격리해 fake CLI가 선택되도록 한다.
    MEETING_SLIDES_SETTINGS_ROOT: tempDir,
    LLM_PROVIDER: "cli",
    LLM_CLI_BIN: fakeCli,
    LLM_CLI_PRESET: "claude",
    WHISPER_INPUT_MODE: "mic",
    WHISPER_STREAM_BIN: fakeWhisper,
    WHISPER_MODEL_PATH: join(tempDir, "model.bin"),
    BLOCK_DETECT_SENTENCE_INTERVAL: "100",
  }, {    
runSlidePlan: async input => {
      await compileRelease?.promise;
      return runSlidePlanServerAction(input);
    }  
});
  port = running.server.port!;

  mkdirSync(join(tempDir, "exports"), { recursive: true });
  captureWorkingDirectoryBaseline = captureWorkingDirectories();
  socket = await connect();
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
  startupStatus = await sendAndWait(
    { action: "status" },
    (message) => message.type === "status" && message.text === "서버 정상",
  );
});

afterAll(async () => {
  compileRelease?.resolve();
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  await running?.close();
  for (const artifact of createdArtifacts) rmSync(join(tempDir, artifact), { recursive: true, force: true });
  for (const ownedCaptureWorkingDirectory of ownedCaptureWorkingDirectories) {
    expect(captureWorkingDirectoryBaseline).not.toContain(ownedCaptureWorkingDirectory);
    expect(captureWorkingDirectories()).toContain(ownedCaptureWorkingDirectory);
    expect(readdirSync(ownedCaptureWorkingDirectory)).toEqual([]);
    rmdirSync(ownedCaptureWorkingDirectory);
  }
  expect(captureWorkingDirectories()).toEqual(captureWorkingDirectoryBaseline);
  rmSync(tempDir, { recursive: true, force: true });
});

test("startup status smoke", () => {
  expect(startupStatus).toMatchObject({ type: "status", text: "서버 정상" });
});

test("characterizes existing WS responses, broadcasts, saved path, active reset, and malformed input", async () => {
  const transcript = await sendAndWait(
    { action: "transcript" },
    (message) => message.type === "transcript" && message.reason === "export",
  );
  expect(transcript).toMatchObject({ type: "transcript", entries: [], reason: "export", truncated: false });

  const started = await sendAndWait(
    { action: "startCapture" },
    (message) => message.type === "capture" && message.capturing === true,
  );
  expect(started).toMatchObject({ type: "capture", capturing: true, mode: "mic" });
  expect(typeof started.startedAt).toBe("number");

  const resetBlocked = await sendAndWait(
    { action: "reset" },
    (message) => message.type === "status" && String(message.text).includes("capture must be stopped before reset"),
  );
  expect(String(resetBlocked.text)).toContain("요청 처리 실패");

  const stopped = await sendAndWait(
    { action: "stopCapture" },
    (message) => message.type === "capture" && message.capturing === false,
  );
  // The first frame after `stopCapture` is the STOP WINDOW, not idle: the server
  // has released `capturing` but is still flushing the tail of the transcript.
  // `phase` names that window and `startedAt` keeps the timer truthful through
  // it; both are additive, and `capturing`/`mode` are unchanged, so a client
  // that reads neither field behaves exactly as before.
  expect(stopped).toMatchObject({ type: "capture", capturing: false, mode: "mic" });
  expect(stopped.phase).toBe("stopping");
  expect(typeof stopped.startedAt).toBe("number");
  expect(Object.keys(stopped).sort()).toEqual(["audioSource", "capturing", "mode", "phase", "startedAt", "type"]);

  // Everything from HERE on is the terminal flush.
  //
  // The scan floor matters: the connect-time hydration frame at the top of this
  // socket is `{type:"capture",capturing:false,mode:"mic",phase:"idle"}`, which is
  // byte-identical to the terminal idle asserted below. Scanning the whole buffer
  // would match THAT frame and the assertion would hold even if the server never
  // left the stopping phase. Anchoring past the stop-window frame is what makes
  // this a real observation of the end of the capture.
  const idleStart = messages.length;

  // The authoritative idle that ends the meeting arrives after the flush,
  // alongside the stop status. Both are consequences of the SAME flush, so they
  // are armed together and awaited together rather than serialised into two
  // stacked windows inside this test's per-await budget.
  const [idle] = await Promise.all([
    waitForMessageAfter(
      idleStart,
      (message) => message.type === "capture" && message.phase === "idle",
    ),
    waitForMessageAfter(
      idleStart,
      (message) => message.type === "status" && String(message.text).includes("녹음 중지"),
    ),
  ]);
  expect(idle).toEqual({ type: "capture", capturing: false, mode: "mic", phase: "idle", audioSource: "mic" });
  ownedCaptureWorkingDirectories = captureWorkingDirectories()
    .filter((directory) => !captureWorkingDirectoryBaseline.includes(directory));
  expect(ownedCaptureWorkingDirectories).toHaveLength(1);
  const captureDb = new Database(join(tempDir, "meetings.db"), { readonly: true });
  expect(captureDb.query(
    "SELECT engine, engine_model FROM transcript_versions ORDER BY version_no DESC LIMIT 1",
  ).get()).toEqual({
    engine: "whisper.cpp",
    engine_model: join(tempDir, "model.bin"),
  });
  captureDb.close();

  const reset = await sendAndWait(
    { action: "reset" },
    (message) => message.type === "transcript" && message.reason === "snapshot",
  );
  expect(reset).toMatchObject({ type: "transcript", entries: [], reason: "snapshot", truncated: false });

  const markdownSaved = await sendAndWait(
    { action: "saveNotes" },
    (message) => message.type === "saved" && String(message.path).endsWith(".md"),
  );
  const markdownPath = String(markdownSaved.path);
  createdArtifacts.push(markdownPath);
  expect(existsSync(join(tempDir, markdownPath))).toBe(true);
  expect(readFileSync(join(tempDir, markdownPath), "utf8")).toContain("# Meeting Notes");

  const jsonSaved = await sendAndWait(
    { action: "saveJson" },
    (message) => message.type === "saved" && String(message.path).endsWith(".json"),
  );
  const jsonPath = String(jsonSaved.path);
  createdArtifacts.push(jsonPath);
  const json = JSON.parse(readFileSync(join(tempDir, jsonPath), "utf8")) as Record<string, unknown>;
  expect(typeof json.provider).toBe("string");
  expect(Array.isArray(json.lines)).toBe(true);

  const compileFirst = await sendAndWait(
    { action: "exportDeck" },
    (message) =>
      (message.type === "saved" && String(message.path).endsWith("/index.html"))
      || (message.type === "status" && String(message.text).includes("슬라이드 초안")),
  );
  expect(compileFirst).toMatchObject({
    type: "status",
    text: "먼저 슬라이드 초안을 만들어 주세요",
  });

  const reconnectMessages: Record<string, unknown>[] = [];
  let reconnect: WebSocket | undefined;
  const latestSavedPending = waitFor<Record<string, unknown>>((done, fail) => {
    void connect((message) => {
      reconnectMessages.push(message);
      if (message.type === "saved") done(message);
    }).then((ws) => { reconnect = ws; }, fail);
  });
  const latestSaved = await latestSavedPending;
  expect(latestSaved).toEqual({ type: "saved", path: jsonPath });
  reconnect?.close();

  const unknownStart = messages.length;
  const sentinelPending = waitForMessageAfter(
    unknownStart,
    (message) => message.type === "status" && message.text === "서버 정상",
  );
  socket.send(JSON.stringify({ action: "unknownAction" }));
  socket.send(JSON.stringify({ action: "status" }));
  const sentinel = await sentinelPending;
  expect(sentinel.text).toBe("서버 정상");
  const sentinelIndex = messages.findIndex((message, index) => index >= unknownStart && message === sentinel);
  expect(messages.slice(unknownStart, sentinelIndex)).toEqual([]);

  const malformed = await sendAndWait("{", (message) => message.type === "status" && String(message.text).startsWith("요청 처리 실패:"));
  expect(String(malformed.text)).toContain("JSON");
  // The test bound sits above the per-await bound so a single slow await surfaces
  // as its own named timeout rather than as an anonymous test-level kill.
}, 60_000);

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const exportTranscriptHash = transcriptLinesHash([{
  seq: 1,
  captured_at_ms: 10,
  speaker_turn: 1,
  text: "Launch Friday",
}]);
const exportTheme: Theme = {
  id: "ws-theme", canvas: { width: 1280, height: 720 },
  font: { family: "Fixture", localPath: "fonts/fixture.woff2", sha256: "f".repeat(64) },
  colors: { paper: "F6F1E8", raised: "FFFDF8", ink: "14213D", muted: "5B6475", rule: "D9D2C4", coral: "AD4B2F", blue: "335C81", focus: "1E5AA8" },
  spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 },
  typography: {
    display: { size: 64, lineHeight: 68, weight: 700 }, heading: { size: 36, lineHeight: 42, weight: 700 },
    body: { size: 22, lineHeight: 30, weight: 400 }, label: { size: 16, lineHeight: 20, weight: 600 },
  },
  stroke: { thin: 1, strong: 3 }, radius: { small: 8, large: 24 },
};
const exportClaim = {
  id: "claim-ws", kind: "decision" as const, text: "Launch Friday.",
  sources: [{ transcriptVersionId: "transcript-v1", startSeq: 1, endSeq: 1, evidenceQuote: "Launch Friday" }],
  method: "reviewed" as const,
};

function exportPlan(meetingId: number, planId = "planWsExport", title = "웹 슬라이드 출판"): SlidePlan {
  const slides: PlanSlide[] = [
    {
      id: "slide-hero", layout: "hero", storyRole: "opening", title: "출시 회의",
      payload: { variant: "cover", statement: "Launch Friday" },
      bindings: { title: [exportClaim.id], statement: [exportClaim.id] }, editorialPaths: [], assetIds: [],
    },
  ];
  return {
    schemaVersion: 1, planId, revision: 0,
    snapshot: { meetingId, transcriptVersionId: "transcript-v1", contentSha256: exportTranscriptHash, lineCount: 1 },
    title, theme: exportTheme, claims: [exportClaim], assets: [], slides,
    createdAt: "2026-08-15T10:00:00.000Z", updatedAt: "2026-08-15T10:00:00.000Z",
  };
}

function exportPublication(plan: SlidePlan, directory: string, status: "draft" | "final" = "draft"): SlidePlanPublicationWrite {
  const planJson = `${JSON.stringify(plan)}\n`;
  const reviewedItemIds = [exportClaim.id];
  const identity: PipelineIdentity = {
    planId: plan.planId, deckId: `${plan.planId}:deck`, snapshot: plan.snapshot,
    slideIds: plan.slides.map((slide) => slide.id),
    geometryIds: plan.slides.map((slide) => `geometry-${slide.id}`),
    claimIds: plan.claims.map((entry) => entry.id),
    ...(status === "final" ? { reviewId: "review-ws-export", reviewedItemIds } : {}),
  };
  const html = `<!doctype html><title>${plan.title}</title>`;
  mkdirSync(join(directory, "standalone"), { recursive: true });
  writeFileSync(join(directory, "standalone", "index.html"), html);
  const manifest = {
    schemaVersion: 2,
    publicationStatus: status,
    identity,
    ...(status === "final" ? {
      finalityReceipt: {
        reviewId: "review-ws-export",
        confirmedAt: 300,
        transcriptVersionId: "transcript-v1",
        contentSha256: exportTranscriptHash,
        reviewedItemIds,
      },
    } : {}),
    planSha256: hash(planJson),
    assetManifestSha256: "b".repeat(64),
    artifacts: [{
      format: "standalone-html",
      files: [{ relativePath: "standalone/index.html", byteLength: Buffer.byteLength(html), sha256: hash(html) }],
    }],
  };
  const manifestJson = `${JSON.stringify(manifest)}\n`;
  const publicationSha256 = hash(manifestJson);
  writeFileSync(join(directory, "publication.json"), `${JSON.stringify({
    ...manifest,
    publicationSha256,
  })}\n`);
  return { identity, planJson, planSha256: hash(planJson), manifestJson, publicationSha256, directory };
}

function addExportFinalityEvidence(store: MeetingStore, meetingId: number): void {
  const database = store.databaseHandle();
  database.run(`INSERT INTO transcript_versions
    (transcript_version_id, meeting_id, version_no, source_kind, created_at, finalized_at, content_sha256)
    VALUES ('transcript-v1', ?, 1, 'import', 1, 200, ?)`, [meetingId, exportTranscriptHash]);
  database.run(`INSERT INTO transcript_version_lines
    (meeting_id, transcript_version_id, seq, captured_at_ms, speaker_turn, text)
    VALUES (?, 'transcript-v1', 1, 10, 1, 'Launch Friday')`, [meetingId]);
  database.run(`INSERT INTO meeting_transcript_state
    (meeting_id, canonical_transcript_version_id, canonical_selected_at)
    VALUES (?, 'transcript-v1', 200)`, [meetingId]);
  database.run("INSERT INTO attendees (meeting_id, attendee_id, display_name, created_at) VALUES (?, 'attendee-ws-export', 'Mina', 1)", [meetingId]);
  database.run(`INSERT INTO meeting_reviews
    (review_id, meeting_id, transcript_version_id, status, created_at, updated_at, confirmed_at)
    VALUES ('review-ws-export', ?, 'transcript-v1', 'confirmed', 1, 300, 300)`, [meetingId]);
  database.run(`INSERT INTO decisions
    (decision_id, meeting_id, review_id, description, evidence_quote, source_transcript_version_id,
      source_start_seq, source_end_seq, attributed_attendee_id, origin, review_state, created_at, updated_at)
    VALUES (?, ?, 'review-ws-export', 'Launch', 'Launch Friday', 'transcript-v1', 1, 1,
      'attendee-ws-export', 'manual', 'confirmed', 1, 1)`, [exportClaim.id, meetingId]);
}

function waitForBag(
  bag: Record<string, unknown>[],
  client: WebSocket,
  start: number,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const existing = bag.slice(start).find(predicate);
  if (existing) return Promise.resolve(existing);
  return waitFor<Record<string, unknown>>((done) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (predicate(message)) {
        client.removeEventListener("message", onMessage);
        done(message);
      }
    };
    client.addEventListener("message", onMessage);
  });
}

test("active meeting deletion is blocked while unrelated and after completion deletion remain allowed", async () => {
  compileRelease = Promise.withResolvers<void>();
  // Given: two ended meetings and terminal/start listeners armed before compile.
  const setup = new MeetingStore(join(tempDir, "meetings.db"));
  const activeMeetingId = setup.startMeeting("fake-active-delete");
  setup.endMeeting();
  const unrelatedMeetingId = setup.startMeeting("fake-unrelated-delete");
  setup.endMeeting();
  setup.close();
  const bag: Record<string, unknown>[] = [];
  const client = await connect((message) => bag.push(message));
  const start = bag.length;
  const started = waitForBag(bag, client, start, (message) =>
    message.type === "compile" && message.status === "started" && message.meetingId === activeMeetingId);
  const terminal = waitForBag(bag, client, start, (message) =>
    message.type === "compile" && (message.status === "success" || message.status === "error")
    && message.meetingId === activeMeetingId);

  // When: compile owns one meeting, then deletion targets both meeting identities.
  client.send(JSON.stringify({ action: "compileSlidePlan", meetingId: activeMeetingId }));
  await started;
  const activeDelete = await sendAndWait(
    { action: "deleteMeeting", meetingId: activeMeetingId },
    (message) => message.type === "status" && (
      String(message.text).includes("작업 중인 회의") || String(message.text).includes("회의 기록을 삭제했습니다")
    ),
  );
  const unrelatedDelete = await sendAndWait(
    { action: "deleteMeeting", meetingId: unrelatedMeetingId },
    (message) => message.type === "status" && String(message.text).includes("회의 기록을 삭제했습니다"),
  );

  // Then: active ownership blocks only its meeting before durable deletion.
  expect(String(activeDelete.text)).toContain("요청 처리 실패: 슬라이드 작업 중인 회의는 삭제할 수 없습니다");
  expect(unrelatedDelete).toMatchObject({ type: "status", text: "회의 기록을 삭제했습니다" });
  const database = new Database(join(tempDir, "meetings.db"), { readonly: true });
  expect(database.query("SELECT id FROM meetings WHERE id = ?").get(activeMeetingId)).toEqual({ id: activeMeetingId });
  expect(database.query("SELECT id FROM meetings WHERE id = ?").get(unrelatedMeetingId)).toBeNull();
  database.close();

  // When/Then: the same meeting becomes deletable after the exact terminal signal.
  compileRelease.resolve();
  await terminal;
  compileRelease = undefined;
  const completedDelete = await sendAndWait(
    { action: "deleteMeeting", meetingId: activeMeetingId },
    (message) => message.type === "status" && (
      String(message.text).includes("회의 기록을 삭제했습니다") || String(message.text).includes("찾을 수 없습니다")
    ),
  );
  expect(completedDelete).toMatchObject({ type: "status", text: "회의 기록을 삭제했습니다" });
  client.close();
}, 60_000);

test("exportDeck, meeting restore, and artifact HTTP use the final inserted after a backward wall clock", async () => {
  // Given: draft audit time 200 precedes final audit time 100, while insertion sequence increases.
  const store = new MeetingStore(join(tempDir, "meetings.db"));
  const meetingId = store.startMeeting("fake-export");
  addExportFinalityEvidence(store, meetingId);
  const draft = exportPlan(meetingId, "planWsDraft", "Draft by audit clock");
  const final = exportPlan(meetingId, "planWsFinal", "Final by publication sequence");
  const draftRoot = join(tempDir, `ws-slideplan-draft-${meetingId}`);
  const finalRoot = join(tempDir, `ws-slideplan-final-${meetingId}`);
  const publications = new SlidePlanStore(store.databaseHandle());
  publications.save(exportPublication(draft, draftRoot), 200);
  publications.save(exportPublication(final, finalRoot, "final"), 100);
  const orderedPublications = publications.list(meetingId).map(({
    plan, publicationId, publicationSeq, publicationStatus, publishedAt,
  }) => ({
    planId: plan.planId,
    publicationId,
    publicationSeq,
    publicationStatus,
    publishedAt,
  }));
  expect(orderedPublications.map(({ planId, publicationSeq, publicationStatus }) => ({
    planId,
    publicationSeq,
    publicationStatus,
  }))).toEqual([
    { planId: final.planId, publicationSeq: 2, publicationStatus: "final" },
    { planId: draft.planId, publicationSeq: 1, publicationStatus: "draft" },
  ]);
  store.close();

  const bag: Record<string, unknown>[] = [];
  const client = await connect((message) => bag.push(message));
  const restored = await sendAndWait(
    { action: "selectMeeting", meetingId },
    (message) => message.type === "meeting" && message.meetingId === meetingId,
  );
  expect(restored).toMatchObject({
    slidePlan: {
      plan: { planId: final.planId, title: final.title },
      publicationStatus: "final",
      publicationSeq: 2,
      publishedAt: 100,
    },
  });

  // When: exportDeck resolves the meeting publication.
  const start = bag.length;
  const pending = waitForBag(bag, client, start, (message) => message.type === "saved");
  client.send(JSON.stringify({ action: "exportDeck", meetingId }));
  const reply = await pending;
  const artifactPath = `/slide-plan-artifacts/${final.planId}/standalone/index.html`;
  expect(reply).toMatchObject({ type: "saved", path: artifactPath });
  expect(bag.slice(start).some((message) => message.type === "compile")).toBe(false);
  const artifact = await fetch(`http://127.0.0.1:${port}${artifactPath}`);
  const artifactBody = await artifact.text();
  expect(artifact.status).toBe(200);
  expect(artifact.headers.get("content-disposition")).toBe('attachment; filename="index.html"');
  expect(artifactBody).toContain("Final by publication sequence");
  const unknownArtifact = await fetch(`http://127.0.0.1:${port}/slide-plan-artifacts/unknown/standalone/index.html`);
  expect(unknownArtifact.status).toBe(404);
  const evidenceDirectory = process.env.TASK5_EVIDENCE_DIR;
  if (evidenceDirectory !== undefined) {
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(join(evidenceDirectory, "resolution.json"), `${JSON.stringify({
      meetingId,
      orderedPublications,
      restored: {
        planId: final.planId,
        publicationSeq: 2,
        publicationStatus: "final",
        publishedAt: 100,
      },
      exportDeck: { path: artifactPath, planId: final.planId, publicationSeq: 2 },
      http: {
        artifact: { status: artifact.status, disposition: artifact.headers.get("content-disposition") },
        unknown: { status: unknownArtifact.status },
      },
    }, null, 2)}\n`);
  }

  const aliasStart = bag.length;
  const sentinelPending = waitForBag(
    bag,
    client,
    aliasStart,
    (message) => message.type === "status" && message.text === "서버 정상",
  );
  client.send(JSON.stringify({ action: "compileDeck", meetingId }));
  client.send(JSON.stringify({ action: "compileTranscriptSnapshot", meetingId }));
  client.send(JSON.stringify({ action: "exportPptx", meetingId }));
  client.send(JSON.stringify({ action: "status" }));
  await sentinelPending;
  const sentinelIndex = bag.findIndex((message, index) =>
    index >= aliasStart && message.type === "status" && message.text === "서버 정상");
  expect(bag.slice(aliasStart, sentinelIndex).filter((message) =>
    message.type === "compile" || message.type === "saved" || message.type === "export")).toEqual([]);
  client.close();
}, 60_000);

test("selectMeeting returns the exact persisted meeting purpose to its requester", async () => {
  const store = new MeetingStore(join(tempDir, "meetings.db"));
  const meetingId = store.startMeeting("purpose-recovery");
  const purpose = "PURPOSE_RECOVERY_SENTINEL_7F3A";
  store.databaseHandle().run(
    "INSERT OR REPLACE INTO meeting_meta (meeting_id, purpose, phase, prepared_at) VALUES (?, ?, 'ended', ?)",
    [meetingId, purpose, Date.now()],
  );
  store.close();

  const client = await connect();
  const restored = await sendAndWait(
    { action: "selectMeeting", meetingId },
    (message) => message.type === "meeting" && message.meetingId === meetingId,
  );
  expect(restored).toMatchObject({ type: "meeting", meetingId, purpose });
  client.close();
}, 60_000);

test("selectMeeting omits the retired historical scene publication", async () => {
  const store = new MeetingStore(join(tempDir, "meetings.db"));
  const meetingId = store.startMeeting("fake-history");
  store.addLine({ ts: 1_700_000_000_000, text: "라이브 카드는 유지합니다." });
  store.addSlide({
    idx: 1,
    title: "현재 MeetingCard",
    bullets: ["라이브 기록"],
    startedAt: 1_700_000_000_000,
  });
  saveScenePublication(store.databaseHandle(), {
    meetingId,
    narrative: {
      meetingId,
      title: "Retired scene",
      slides: [{ intent: "cover", title: "Retired scene" }],
    },
    scene: {
      meetingId,
      title: "Retired scene",
      width: 100,
      height: 56.25,
      slides: [{
        id: "retired-scene",
        intent: "cover",
        background: "FFFFFF",
        elements: [],
      }],
    },
    directory: "/retired/scene",
    pptxPath: "/retired/scene/deck.pptx",
    publishedAt: 1_700_000_000_100,
  });
  store.close();

  const bag: Record<string, unknown>[] = [];
  const client = await connect((message) => bag.push(message));
  const start = bag.length;
  const pending = waitForBag(
    bag,
    client,
    start,
    (message) => message.type === "meeting" && message.meetingId === meetingId,
  );
  client.send(JSON.stringify({ action: "selectMeeting", meetingId }));
  const reply = await pending;

  expect(reply).toMatchObject({
    type: "meeting",
    meetingId,
    current: {
      title: "현재 MeetingCard",
      bullets: ["라이브 기록"],
    },
  });
  expect(reply).not.toHaveProperty("scene");
  client.close();
}, 60_000);

test("dock raster export rejects a meeting without a SlidePlan publication", async () => {
  const store = new MeetingStore(join(tempDir, "meetings.db"));
  const meetingId = store.startMeeting("fake-raster-fallback");
  store.addLine({ ts: 1_700_000_000_000, text: "레거시 덱으로 폴백하면 안 됩니다." });
  store.addSlide({
    idx: 1,
    title: "Legacy-only card",
    bullets: ["No raster fallback"],
    startedAt: 1_700_000_000_000,
  });
  store.close();

  const bag: Record<string, unknown>[] = [];
  const client = await connect((message) => bag.push(message));
  const start = bag.length;
  const pending = waitForBag(
    bag,
    client,
    start,
    (message) => message.type === "export"
      && message.action === "exportPng"
      && (message.status === "success" || message.status === "error" || message.status === "timeout"),
  );
  client.send(JSON.stringify({ action: "exportPng", meetingId }));
  const terminal = await pending;

  expect(terminal).toMatchObject({
    type: "export",
    action: "exportPng",
    status: "error",
    code: "slide-plan-required",
  });
  expect(String(terminal.error)).toContain("SlidePlan");
  expect(bag.slice(start).some((message) => message.type === "saved")).toBe(false);
  client.close();
}, 60_000);
