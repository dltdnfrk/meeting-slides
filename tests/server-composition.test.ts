import { expect, spyOn, test } from "bun:test";
import sharp from "sharp";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import { createMeetingApplication, type ApplicationOptions } from "../src/server/application.ts";
import type { WhisperOptions } from "../src/whisper.ts";
import type { ChatTransport, MeetingLLM } from "../src/llm.ts";
import type { ProviderRuntimeState } from "../src/providers.ts";
import { MeetingStore } from "../src/store.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { SlidePlanStore } from "../src/slide-plan-store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";
import { runSlidePlanServerAction } from "../src/slides/server-action.ts";
import * as presentation from "../src/slides/render/standalone-presentation.ts";
import { bounded, connectMeetingServer, deferred, launchModelOutput, startMeetingServer } from "./helpers/meeting-server.ts";

const quietDetector: MeetingLLM & ChatTransport = {
  async ping() { return true; },
  async detectBlock() { return { shouldAdvance: false, title: "", bullets: [] }; },
  async planDeck() { throw new Error("Unexpected legacy deck request"); },
  async chat() { throw new Error("Unexpected chat request"); },
};

function fixture(options: ApplicationOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "server-composition-"));
  const dbPath = join(directory, "meeting.db");
  const running = startMeetingServer({    
...process.env, MEETINGS_DB_PATH: dbPath, MEETING_SLIDES_SETTINGS_ROOT: directory,
    LLM_PROVIDER: "cli", LLM_CLI_BIN: "/usr/bin/false", LLM_CLI_PRESET: "claude", WHISPER_INPUT_MODE: "mic"  
},
    { detector: quietDetector, ...options });
  return { directory, dbPath, running, async close() { await running.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function canonicalMeeting(dbPath: string, text = "Launch Friday.") {
  const legacy = new MeetingStore(dbPath);
  try {
    const minutes = new MinutesStore(legacy.databaseHandle());
    const meetingId = legacy.startMeeting("fixture");
    minutes.registerCapturingMeeting(meetingId);
    minutes.addAttendees(meetingId, [{ attendeeId: "alice", displayName: "Alice" }]);
    const version = minutes.addTranscriptVersion(meetingId, { sourceKind: "import" });
    minutes.addTranscriptVersionLines(version.transcriptVersionId, [{ seq: 1, text }]);
    minutes.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(minutes, version.transcriptVersionId));
    minutes.setCanonical(meetingId, version.transcriptVersionId);
    minutes.endMeeting(meetingId); legacy.endMeeting();
    return { meetingId, transcriptVersionId: version.transcriptVersionId };
  } finally { legacy.close(); }
}

function controlledCapture() {
  const started = deferred<void>(); const stopped = deferred<void>(); const finish = deferred<void>();
  let handlers: WhisperOptions;
  return {    
started, stopped, finish, createCapture: () => ({
      identity: { engine: "whisper.cpp" as const, engineModel: "fixture.bin" }, audioCapture: null,
      capture: {        
async start(value: WhisperOptions) { handlers = value; started.resolve(); await finish.promise; },
        async stop() { handlers.onChunk({ text: "TAIL_SENTINEL.", ts: 101 }); stopped.resolve(); await finish.promise; }      
},
    })  
};
}

test("importing the guarded CLI does not load configuration, open resources, or install signals", () => {
  const result = spawnSync(process.execPath, ["-e", `
    const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    Bun.serve = () => { throw new Error("import listened"); };
    await import(${JSON.stringify(new URL("../server.ts", import.meta.url).href)});
    if (JSON.stringify(signals) !== JSON.stringify([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")])) throw new Error("import installed signals");
    console.log("IMPORT_OK");
  `], { env: { ...process.env, LLM_PROVIDER: "invalid-import-sentinel" }, encoding: "utf8", timeout: 5000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("IMPORT_OK");
});

test("factory construction leaves explicitly configured resources unopened", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inert-factory-"));
  try {
    const databasePath = join(directory, "unopened.db");
    const app = createMeetingApplication({ paths: { databasePath, bundleOutputRoot: join(directory, "unopened") } });
    await app.close();
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(join(directory, "unopened"))).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("HTTP and WS are ready while discovery is pending and later broadcast truthful auth", async () => {
  const discovery = deferred<ProviderRuntimeState[]>();
  const app = fixture({ discoverProviders: () => discovery.promise });
  try {
    expect((await fetch(`http://127.0.0.1:${app.running.server.port}/`)).status).toBe(200);
    const client = await connectMeetingServer(app.running.server.port!);
    const update = client.next(message => message.type === "providers" && Array.isArray(message.list) && message.list.some(entry => entry.auth === "disconnected"));
    discovery.resolve([{ id: "cli:claude", installed: true, auth: "disconnected", executable: "claude", version: "fixture-version" }]);
    expect(await update).toMatchObject({ list: expect.arrayContaining([expect.objectContaining({ id: "cli:claude", installed: true, auth: "disconnected", available: false, selectable: true, version: "fixture-version" })]) });
    client.socket.close();
  } finally { discovery.resolve([]); await app.close(); }
});

test("close cancels pending discovery and closes the owned socket", async () => {
  const aborted = deferred<void>();
  const app = fixture({    
discoverProviders: async (_env, _runner, signal) => {
      if (!signal) throw new Error("missing discovery cancellation");
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await aborted.promise; return [];
    }  
});
  const client = await connectMeetingServer(app.running.server.port!);
  const closed = bounded(new Promise<void>(resolve => client.socket.addEventListener("close", () => resolve(), { once: true })), "socket close");
  await app.close(); await closed; await bounded(aborted.promise, "discovery abort");
  expect(client.socket.readyState).toBe(WebSocket.CLOSED);
});

test("stop tail persists before idle and a reconnect sees the same stopping origin", async () => {
  const capture = controlledCapture(); const app = fixture({ createCapture: capture.createCapture });
  try {
    const owner = await connectMeetingServer(app.running.server.port!);
    await owner.send({ action: "startCapture" }, message => message.type === "capture" && message.phase === "capturing");
    await bounded(capture.started.promise);
    const stopping = await owner.send({ action: "stopCapture" }, message => message.type === "capture" && message.phase === "stopping");
    await bounded(capture.stopped.promise);
    const reconnect = await connectMeetingServer(app.running.server.port!);
    await reconnect.send({ action: "status" }, message => message.type === "status");
    expect(reconnect.messages.find(message => message.type === "capture")).toMatchObject({ phase: "stopping", startedAt: stopping.startedAt });
    const idle = owner.next(message => message.type === "capture" && message.phase === "idle");
    capture.finish.resolve(); await idle;
    const database = new Database(app.dbPath, { readonly: true });
    try {
      expect(database.query("SELECT text FROM transcript_version_lines").all()).toEqual([{ text: "TAIL_SENTINEL." }]);
      expect(database.query("SELECT phase FROM meeting_meta").get()).toEqual({ phase: "ended" });
    } finally { database.close(); }
    owner.socket.close(); reconnect.socket.close();
  } finally { capture.finish.resolve(); await app.close(); }
});

test("close waits for capture finalization rather than abandoning the final tail", async () => {
  const capture = controlledCapture(); const app = fixture({ createCapture: capture.createCapture });
  try {
    const owner = await connectMeetingServer(app.running.server.port!);
    await owner.send({ action: "startCapture" }, message => message.type === "capture" && message.phase === "capturing");
    await bounded(capture.started.promise);
    let completed = false; const close = app.running.close().then(() => { completed = true; });
    await bounded(capture.stopped.promise);
    expect(completed).toBe(false);
    capture.finish.resolve(); await bounded(close, "application close");
    const database = new Database(app.dbPath, { readonly: true });
    try { expect(database.query("SELECT text FROM transcript_version_lines").all()).toEqual([{ text: "TAIL_SENTINEL." }]); } finally { database.close(); }
  } finally { capture.finish.resolve(); await app.close(); }
});

test("naturally ended capture releases ownership so reset can clear the session", async () => {
  const capture = controlledCapture(); const app = fixture({ createCapture: capture.createCapture });
  try {
    const owner = await connectMeetingServer(app.running.server.port!);
    await owner.send({ action: "startCapture" }, message => message.type === "capture" && message.phase === "capturing");
    const idle = owner.next(message => message.type === "capture" && message.phase === "idle");
    capture.finish.resolve(); await idle;
    expect(await owner.send({ action: "reset" }, message => message.type === "transcript" || (message.type === "status" && String(message.text).startsWith("요청 처리 실패:")))).toMatchObject({ type: "transcript", reason: "snapshot", entries: [] });
    owner.socket.close();
  } finally { capture.finish.resolve(); await app.close(); }
});

test("compile, raster export and deletion share one artifact owner until the real action settles", async () => {
  const release = deferred<void>();
  const app = fixture({ runSlidePlan: async input => { await release.promise; return runSlidePlanServerAction(input); } });
  try {
    const store = new MeetingStore(app.dbPath);
    const meetingId = store.startMeeting("compile-conflict");
    store.addLine({ ts: 101, text: "Launch Friday." });
    store.endMeeting(); store.close();
    const owner = await connectMeetingServer(app.running.server.port!);
    const terminal = owner.next(message => message.type === "compile" && message.status === "error");
    await owner.send({ action: "compileSlidePlan", meetingId }, message => message.type === "compile" && message.status === "started");
    expect(await owner.send({ action: "exportPdf", meetingId }, message => message.type === "export")).toMatchObject({ status: "error", code: "job-busy" });
    expect(await owner.send({ action: "deleteMeeting", meetingId }, message => message.type === "status")).toMatchObject({ type: "status", text: expect.stringContaining("요청 처리 실패:") });
    release.resolve(); await terminal;
    expect(await owner.send({ action: "deleteMeeting", meetingId }, message => message.type === "status")).toMatchObject({ text: "회의 기록을 삭제했습니다" });
    owner.socket.close();
  } finally { release.resolve(); await app.close(); }
});

test("close waits for an accepted review confirmation and its real bundle commit", async () => {
  const app = fixture();
  try {
    const { meetingId, transcriptVersionId } = canonicalMeeting(app.dbPath);
    const legacy = new MeetingStore(app.dbPath);
    const minutes = new MinutesStore(legacy.databaseHandle());
    const reviewId = minutes.saveCandidates({ meetingId, transcriptVersionId, decisions: [{ id: "launch", description: "Launch Friday", evidenceQuote: "Launch Friday.", source: { transcriptVersionId, startSeq: 1, endSeq: 1 }, attributedAttendeeId: "alice", reviewState: "confirmed" }] });
    legacy.close();
    const owner = await connectMeetingServer(app.running.server.port!);
    const accepted = owner.next(message => message.type === "status" && message.text === "서버 정상");
    owner.socket.send(JSON.stringify({ action: "confirmReview", reviewId }));
    owner.socket.send(JSON.stringify({ action: "status" }));
    await accepted;
    await app.running.close();
    const database = new Database(app.dbPath, { readonly: true });
    try { expect(database.query("SELECT review_id FROM meeting_conclusions").all()).toEqual([{ review_id: reviewId }]); } finally { database.close(); }
  } finally { await app.close(); }
});

test("concurrent review requesters share a failed durable write and can retry without notifying observers", async () => {
  const release = deferred<void>(); let calls = 0;
  const app = fixture({ detector: { ...quietDetector, async chat() { calls++; await release.promise; return "{}"; } } });
  try {
    const { meetingId } = canonicalMeeting(app.dbPath);
    const database = new Database(app.dbPath);
    database.exec("CREATE TRIGGER reject_review_fixture BEFORE INSERT ON meeting_reviews BEGIN SELECT RAISE(ABORT, 'REVIEW_WRITE_SENTINEL'); END");
    const owner = await connectMeetingServer(app.running.server.port!);
    const second = await connectMeetingServer(app.running.server.port!);
    const observer = await connectMeetingServer(app.running.server.port!);
    const failed = (message: Record<string, unknown>) => message.type === "status" && message.text === "회의록을 정리하지 못했습니다";
    const firstFailure = owner.next(failed); const secondFailure = second.next(failed);
    owner.socket.send(JSON.stringify({ action: "startReview", meetingId }));
    second.socket.send(JSON.stringify({ action: "startReview", meetingId }));
    await second.send({ action: "status" }, message => message.type === "status" && message.text === "서버 정상");
    release.resolve(); expect(await firstFailure).toEqual(await secondFailure); expect(calls).toBe(1);
    database.exec("DROP TRIGGER reject_review_fixture");
    expect(await owner.send({ action: "startReview", meetingId, retry: true }, message => message.type === "review")).toMatchObject({ meetingId, status: "draft", usedFallback: true });
    expect(calls).toBe(2);
    await observer.send({ action: "status" }, message => message.type === "status" && message.text === "서버 정상");
    expect(observer.messages.some(message => message.type === "review" || failed(message))).toBe(false);
    database.close(); owner.socket.close(); second.socket.close(); observer.socket.close();
  } finally { release.resolve(); await app.close(); }
});

test("concurrent Ask requests share one transport call and retain requester-only replay identity", async () => {
  const answer = deferred<string>(); let calls = 0;
  const app = fixture({ detector: { ...quietDetector, async chat() { calls++; return answer.promise; } } });
  try {
    const { meetingId } = canonicalMeeting(app.dbPath);
    const owner = await connectMeetingServer(app.running.server.port!);
    const second = await connectMeetingServer(app.running.server.port!);
    const observer = await connectMeetingServer(app.running.server.port!);
    const command = { action: "ask", meetingId, requestId: "single-flight", question: "Launch?" };
    const firstReply = owner.next(message => message.type === "ask"); const secondReply = second.next(message => message.type === "ask");
    owner.socket.send(JSON.stringify(command)); second.socket.send(JSON.stringify(command));
    await second.send({ action: "status" }, message => message.type === "status" && message.text === "서버 정상");
    answer.resolve("ANSWER_SENTINEL");
    const reply = await firstReply; expect(reply).toEqual(await secondReply); expect(calls).toBe(1);
    expect(await owner.send(command, message => message.type === "ask")).toEqual(reply);
    expect(await owner.send({ ...command, question: "Different?" }, message => message.type === "ask")).toMatchObject({ requestId: "single-flight", answer: "", error: expect.any(String) });
    await observer.send({ action: "status" }, message => message.type === "status" && message.text === "서버 정상");
    expect(observer.messages.some(message => message.type === "ask")).toBe(false);
    owner.socket.close(); second.socket.close(); observer.socket.close();
  } finally { answer.resolve("cleanup"); await app.close(); }
});

test("real renderer composition preserves draft edits, final rebuild, dock PDF gate and verified HTTP bytes", async () => {
  let transcriptVersionId = ""; let verdict: "revise" | "proceed" = "revise"; let reviewCalls = 0;
  const originalCss = presentation.presentationCss;
  const legacyCss = spyOn(presentation, "presentationCss").mockImplementation((...args) =>
    originalCss(...args).replace(
      "@media (width: 960px) and (height: 540px) {",
      "@media (width: 960px) and (height: 540px) and (min-resolution: 1.3dppx) and (max-resolution: 1.4dppx) {",
    ));
  const app = fixture({    
detector: { ...quietDetector, async chat() { return launchModelOutput(transcriptVersionId); } }, visualReview: async (_prompt, options) => {
      reviewCalls++;
      expect(options?.timeoutMs).toBeGreaterThan(0);
      expect(options?.timeoutMs).toBeLessThanOrEqual(120_000);
      expect(options?.images).toHaveLength(7);
      expect(options?.images?.map(path => basename(path))).toEqual([
        "slide-01.png", "slide-02.png", "slide-03.png", "slide-04.png",
        "slide-05.png", "slide-06.png", "slide-07.png",
      ]);
      const actionsImage = options?.images?.[6];
      if (!actionsImage) throw new Error("missing actions image");
      const { data, info } = await sharp(actionsImage).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let dueDateVisible = false;
      for (let y = Math.floor(info.height * 190 / 720); y < Math.ceil(info.height * 225 / 720); y++) {
        for (let x = Math.floor(info.width * 980 / 1280); x < Math.ceil(info.width * 1200 / 1280); x++) {
          const offset = (y * info.width + x) * info.channels;
          if (data[offset] === 0xad && data[offset + 1] === 0x4b && data[offset + 2] === 0x2f) dueDateVisible = true;
        }
      }
      expect(dueDateVisible, "legacy publication retains the rightmost due-date column").toBe(true);
      for (const path of options?.images ?? []) expect(readFileSync(path).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return { verdict, confidence: "High", passAChecks: [], passBChecks: [], unresolvedCritical: verdict === "revise" ? 1 : 0, blockingFindings: verdict === "revise" ? ["REVIEW_GATE_SENTINEL"] : [], summary: "REVIEW_FIXTURE" };
    }  
});
  const legacy = new MeetingStore(app.dbPath);
  try {
    const canonical = canonicalMeeting(app.dbPath, "The beta launches Friday and Mina owns the release notes.");
    transcriptVersionId = canonical.transcriptVersionId;
    const { meetingId } = canonical;
    const publications = new SlidePlanStore(legacy.databaseHandle());
    const owner = await connectMeetingServer(app.running.server.port!, 120_000);
    const compile = async (command: object) => {
      const terminal = owner.next(message => message.type === "compile" && (message.status === "success" || message.status === "error"));
      owner.socket.send(JSON.stringify(command));
      const result = await terminal;
      expect(result).toMatchObject({ status: "success", meetingId });
      return result;
    };
    expect(await compile({ action: "compileSlidePlan", meetingId })).toMatchObject({ publicationStatus: "draft" });
    const draft = publications.latest(meetingId);
    if (!draft) throw new Error("missing draft receipt");
    expect(await compile({ action: "persistSlidePlan", meetingId, plan: { ...draft.plan, revision: 1, title: "Updated launch plan" } })).toMatchObject({ publicationStatus: "draft" });
    expect(publications.latest(meetingId)?.plan).toMatchObject({ revision: 1, title: "Updated launch plan" });
    const minutes = new MinutesStore(legacy.databaseHandle());
    const reviewId = minutes.saveCandidates({ meetingId, transcriptVersionId, decisions: [{ id: "claim-launch", description: "The beta launches Friday.", evidenceQuote: "The beta launches Friday", source: { transcriptVersionId, startSeq: 1, endSeq: 1 }, attributedAttendeeId: "alice", reviewState: "confirmed" }] });
    await owner.send({ action: "confirmReview", reviewId }, message => message.type === "meetingConcluded");
    expect(await compile({ action: "compileSlidePlan", meetingId })).toMatchObject({ publicationStatus: "final" });
    const final = publications.latest(meetingId);
    if (!final) throw new Error("missing final receipt");
    expect(final.plan.planId).not.toBe(draft.plan.planId);
    expect(final.plan.revision).toBe(0);
    expect(publications.list(meetingId).map(row => row.publicationStatus)).toEqual(["final", "draft", "draft"]);
    legacyCss.mockRestore();
    const legacySlidePath = join(final.path, "standalone", "slides", "opening.html");
    const legacySlideBytes = readFileSync(legacySlidePath);
    expect(legacySlideBytes.toString("utf8"))
      .toContain("min-resolution: 1.3dppx");
    const rasterTerminal = (message: Record<string, unknown>) => message.type === "export" && ["success", "error", "timeout"].includes(String(message.status));
    expect(await owner.send({ action: "exportPdf", meetingId }, rasterTerminal)).toMatchObject({ status: "error", code: "review-failed" });
    verdict = "proceed";
    const exported = await owner.send({ action: "exportPdf", meetingId }, rasterTerminal);
    expect(exported).toMatchObject({ status: "success" });
    expect(readFileSync(String(exported.path)).subarray(0, 5).toString()).toBe("%PDF-");
    expect(readFileSync(legacySlidePath)).toEqual(legacySlideBytes);
    expect(reviewCalls).toBe(2);
    const url = `http://127.0.0.1:${app.running.server.port}/slide-plan-artifacts/${final.plan.planId}/standalone/index.html`;
    expect((await fetch(url)).status).toBe(200);
    writeFileSync(join(final.path, "standalone", "index.html"), "TAMPER_SENTINEL");
    expect((await fetch(url)).status).toBe(409);
    owner.socket.close();
  } finally { legacyCss.mockRestore(); legacy.close(); await app.close(); }
}, 240_000);
