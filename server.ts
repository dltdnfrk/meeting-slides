// ============================================================
// server.ts - 메인 진입점: HTTP + WebSocket + 세션 오케스트레이션
// ============================================================
// Bun.serve의 네이티브 websocket 지원 사용.
// 단일 프로세스에서 whisper-stream 자식 + LLM 블록 감지 + 클라이언트 push.

import { loadConfig, loadWhisperConfig } from "./src/config.ts";
import { WhisperStream, WhisperCLI, listCaptureDevices, type TranscriptChunk } from "./src/whisper.ts";
import { LLMClient, type MeetingLLM } from "./src/llm.ts";
import { CliLLMClient } from "./src/llm-cli.ts";
import { MeetingSession, type ServerMessage, type ClientListener, type ProvidersUpdate, type CaptureUpdate, type ExportUpdate } from "./src/session.ts";
import { buildProviderEntriesFromStates, createDetector, inspectSubscriptionProviders, KEY_BY_PROVIDER, PROVIDER_ADAPTERS, providerAdapter, providerConnectCommand, upsertEnvText, type ProviderRuntimeState, type SubscriptionProviderId } from "./src/providers.ts";
import { AppSettingsStore } from "./src/app-settings.ts";
import { SttModelManager } from "./src/stt-model-downloader.ts";
import { createSelectSttModel } from "./src/stt-model-selection.ts";
import { isSttModelId, type SttModelId } from "./src/stt-model-catalog.ts";
import { sttModelsMessage } from "./src/stt-model-protocol.ts";
import { SttModelSettingsStore } from "./src/stt-model-settings.ts";
import { MeetingStore } from "./src/store.ts";
import { runCompileDeckAction } from "./src/deck-compile-action.ts";
import { prepareExportDeck } from "./src/deck-export.ts";
import { copyDeckAssets } from "./src/deck-assets.ts";
import { buildPassAReport, buildPassBReport } from "./src/grab.ts";
import { buildReviewPrompt, runVisualReview } from "./src/visual-review.ts";
import { createHash, randomUUID } from "node:crypto";
import type { CompileJobId, ExportJobId } from "./src/session.ts";
import { join, sep } from "node:path";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "child_process";
import type { ServerWebSocket } from "bun";

const args = process.argv.slice(2);
if (args.includes("--devices")) {
  const devices = await listCaptureDevices(loadWhisperConfig());
  console.log("whisper-stream capture devices:");
  for (const d of devices) {
    console.log(`  #${d.id}: ${d.name}`);
  }
  process.exit(0);
}

const config = loadConfig(args);

let llm: MeetingLLM;
let llmLabel: string;
if (config.llm.cli) {
  llm = new CliLLMClient(config.llm.cli);
  const model = config.llm.cli.model ? ` · ${config.llm.cli.model}` : "";
  const effort = config.llm.cli.effort ? ` · effort=${config.llm.cli.effort}` : "";
  llmLabel = `cli:${config.llm.cli.preset}(${config.llm.cli.bin})${model}${effort}`;
} else {
  if (!config.llm.config) throw new Error(`provider=${config.llm.provider}에 HTTP 설정이 없습니다`);
  llm = new LLMClient(config.llm.config);
  llmLabel = config.llm.config.model;
}
const listeners = new Set<ClientListener>();
const broadcast = (msg: ServerMessage) => {
  for (const l of listeners) { try { l(msg); } catch {} }
};
// anarlog(fastrepl) 방식: 전사·슬라이드를 로컬 SQLite에 영속 저장
const store = new MeetingStore(join(import.meta.dir, "meetings.db"));
const session = new MeetingSession(
  llm,
  config.block.detectInterval,
  config.block.contextWindow,
  listeners,
  {
    onLine: (entry) => store.addLine(entry),
    onSlide: (slide) => {
      store.addSlide({
        idx: slide.index,
        title: slide.title,
        bullets: slide.bullets,
        startedAt: slide.startedAt,
      });
      broadcast(meetingsMessage());
    },
  },
);

// ── 프로바이더 런타임 선택 (사용자가 UI에서 교체) ──
const appSettings = new AppSettingsStore(import.meta.dir);
let providerStates: ProviderRuntimeState[] = inspectSubscriptionProviders();
let providerEntries = buildProviderEntriesFromStates(process.env, providerStates);
function enrichProviderEntries(): void {
  providerEntries = buildProviderEntriesFromStates(process.env, providerStates);
  for (const entry of providerEntries) {
    const state = providerStates.find((candidate) => candidate.id === entry.id);
    if (state) Object.assign(entry, { installed: state.installed, auth: state.auth, ...(state.version ? { version: state.version } : {}) });
  }
}
enrichProviderEntries();
let currentProviderId = config.llm.cli ? `cli:${config.llm.cli.preset}` : config.llm.provider;
let currentModel = config.llm.cli?.model ?? config.llm.config?.model;
let currentEffort = config.llm.cli?.effort;
const cliTimeoutMs = config.llm.cli?.timeoutMs ?? 120_000;
try {
  const saved = appSettings.load();
  if (saved) {
    const restored = createDetector(saved.providerId, { cliTimeoutMs, model: saved.model, effort: saved.effort });
    if (restored) {
      llm = restored;
      session.setDetector(restored);
      currentProviderId = saved.providerId;
      currentModel = saved.model;
      currentEffort = saved.effort;
      llmLabel = `${saved.providerId}${saved.model ? `/${saved.model}` : ""}${saved.effort ? `·${saved.effort}` : ""}`;
    }
  }
} catch (error) {
  console.warn(`[settings] 앱 설정 복원 실패: ${error instanceof Error ? error.message : String(error)}`);
}
// 관찰성: 마지막 저장 경로를 유지해 클라이언트에 상시 표시
let lastSavedPath: string | null = null;
// Compile/PDF/PNG share one artifact pipeline and must never overlap.
type ActiveJob = { id: CompileJobId | ExportJobId; meetingId: number; action: "compileDeck" | "exportPdf" | "exportPng" };
let activeJob: ActiveJob | null = null;

function providersMessage(): ProvidersUpdate {
  return {
    type: "providers",
    list: providerEntries,
    current: currentProviderId,
    currentModel,
    currentEffort,
  };
}

function meetingsMessage(): ServerMessage {
  return { type: "meetings", items: store.listMeetings() };
}

function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited.catch(() => {});
}

class ExportJobError extends Error {
  constructor(readonly code: NonNullable<ExportUpdate["code"]>, message: string) {
    super(message);
    this.name = "ExportJobError";
  }
}

function validMeetingId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function runGrab(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["x", "slides-grab", ...args], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(import.meta.dir, "vendor", "ms-playwright") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGTERM");
      reject(new ExportJobError("timeout", `slides-grab ${args[0]} timed out`));
    }, Math.max(1, timeoutMs));
    proc.stderr?.on("data", (data: Buffer) => { tail = (tail + data.toString("utf-8")).slice(-400); });
    proc.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ExportJobError("process-failed", error.message));
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new ExportJobError("process-failed", `${args[0]} failed: ${tail.trim() || `exit ${code}`}`));
    });
  });
}

async function beforeDeadline<T>(work: Promise<T>, deadline: number, label: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ExportJobError("timeout", `${label} timed out`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExportJobError("timeout", `${label} timed out`)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runImageExport(action: "exportPdf" | "exportPng", meetingId: number, jobId: ExportJobId): Promise<void> {
  const started = Date.now();
  const deadline = started + 120_000;
  const send = (message: Omit<ExportUpdate, "type" | "action" | "jobId" | "meetingId">) =>
    broadcast({ type: "export", action, jobId, meetingId, ...message });
  send({ status: "started", stage: "prepare" });
  try {
    if (store.meeting(meetingId) === null) throw new ExportJobError("meeting-not-found", `Meeting ${meetingId} was not found`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(import.meta.dir, "exports", `deck-${stamp}`);
    const slidesDir = join(dir, "slides");
    mkdirSync(slidesDir, { recursive: true });
    copyFileSync(join(import.meta.dir, "deck", "theme.css"), join(dir, "theme.css"));
    copyFileSync(join(import.meta.dir, "deck", "theme.css"), join(slidesDir, "theme.css"));
    copyDeckAssets({ sourceDirectory: join(import.meta.dir, "deck", "assets"), exportDirectory: dir, slidesDirectory: slidesDir });
    const material = prepareExportDeck(store, meetingId);
    writeFileSync(join(dir, "index.html"), material.indexHtml, "utf-8");
    for (const file of material.files) writeFileSync(join(slidesDir, file.filename), file.html, "utf-8");

    send({ status: "progress", stage: "validate", completed: 0, total: 1 });
    await runGrab(["validate", "--slides-dir", slidesDir], deadline - Date.now());
    send({ status: "progress", stage: "validate", completed: 1, total: 1 });

    if (action === "exportPng") {
      const out = join(import.meta.dir, "exports", `deck-${stamp}-png`);
      send({ status: "progress", stage: "render", completed: 0, total: material.slideCount });
      await runGrab(["png", "--slides-dir", slidesDir, "--output-dir", out], deadline - Date.now());
      lastSavedPath = `exports/deck-${stamp}-png`;
      broadcast({ type: "saved", path: lastSavedPath });
      send({ status: "success", stage: "publish", completed: material.slideCount, total: material.slideCount, path: lastSavedPath });
      return;
    }

    const previewDir = join(slidesDir, ".slides-grab", "gate-preview");
    send({ status: "progress", stage: "preview", completed: 0, total: material.slideCount });
    await runGrab(["png", "--slides-dir", slidesDir, "--output-dir", previewDir], deadline - Date.now());
    const previewFiles = readdirSync(previewDir).filter((file) => file.endsWith(".png"));
    send({ status: "progress", stage: "review", completed: 0, total: 1 });
    const reviewOpts = { images: previewFiles.map((file) => join(previewDir, file)) };
    const review = await beforeDeadline(runVisualReview(buildReviewPrompt(reviewOpts), reviewOpts), deadline, "visual review");
    if (review.verdict !== "proceed") {
      appendFileSync("/tmp/ms-export-flow.log", `${new Date().toISOString()} REVIEW-REVISE ${review.summary} ${review.blockingFindings.join("; ")}\n`);
      throw new ExportJobError("review-failed", review.blockingFindings.join("; ") || review.summary);
    }
    appendFileSync("/tmp/ms-export-flow.log", `${new Date().toISOString()} REVIEW-PROCEED ${review.confidence}\n`);
    const fingerprints = material.files.map((file) => ({
      file: file.filename,
      sha256: createHash("sha256").update(file.html, "utf-8").digest("hex"),
    }));
    const gateInput = {
      slideFiles: fingerprints, previewFiles, slideCount: material.slideCount,
      maxBullets: material.maxBullets, lineCount: material.lineCount,
      reviewed: true, confidence: review.confidence, notes: `독립 시각 리뷰 요약: ${review.summary}`,
    };
    writeFileSync(join(slidesDir, ".pass-a.md"), buildPassAReport(gateInput), "utf-8");
    writeFileSync(join(slidesDir, ".pass-b.md"), buildPassBReport(gateInput), "utf-8");
    send({ status: "progress", stage: "design-gate", completed: 0, total: 1 });
    await runGrab([
      "design-gate", "--slides-dir", slidesDir, "--verdict", "proceed",
      "--pass-a-report", join(slidesDir, ".pass-a.md"), "--pass-b-report", join(slidesDir, ".pass-b.md"),
    ], deadline - Date.now());
    const out = join(import.meta.dir, "exports", `deck-${stamp}.pdf`);
    send({ status: "progress", stage: "render", completed: 0, total: material.slideCount });
    await runGrab(["pdf", "--slides-dir", slidesDir, "--output", out], deadline - Date.now());
    lastSavedPath = `exports/deck-${stamp}.pdf`;
    broadcast({ type: "saved", path: lastSavedPath });
    send({ status: "success", stage: "publish", completed: material.slideCount, total: material.slideCount, path: lastSavedPath });
  } catch (error) {
    const code = error instanceof ExportJobError ? error.code : "process-failed";
    const message = error instanceof Error ? error.message : String(error);
    send({ status: code === "timeout" ? "timeout" : "error", code, error: message });
  }
}

/** Starts the exact interactive login command declared by the typed adapter. */
function connectProvider(id: string): void {
  const adapter = providerAdapter(id);
  if (adapter) {
    const command = providerConnectCommand(id as SubscriptionProviderId);
    if (!command) return;
    broadcast({ type: "status", text: `${adapter.label} 연결/로그인 명령을 실행합니다 — 완료 후 재검사하세요` });
    spawn(command.executable, command.args, {
      env: command.environment,
      stdio: "inherit",
      detached: true,
    }).unref();
    return;
  }
  switch (id) {
    case "openai": {
      broadcast({ type: "status", text: "OpenAI 키 발급 페이지를 엽니다 — 키를 카드에 붙여넣으세요" });
      openUrl("https://platform.openai.com/api-keys");
      break;
    }
    case "alibaba": {
      broadcast({ type: "status", text: "Alibaba 콘솔을 엽니다 — 키를 카드에 붙여넣으세요" });
      openUrl("https://bailian.console.aliyun.com/");
      break;
    }
    default:
      broadcast({ type: "status", text: "로컬 llama.cpp: 서버를 띄우고 .env의 LOCAL_LLM_BASE_URL을 설정하세요" });
  }
}

async function recheckProviders(): Promise<void> {
  providerStates = inspectSubscriptionProviders();
  enrichProviderEntries();

  const selectedAdapter = providerAdapter(currentProviderId);
  if (selectedAdapter) {
    const candidate = createDetector(currentProviderId, {
      cliTimeoutMs,
      model: currentModel,
      effort: currentEffort,
    });
    if (candidate && await candidate.ping()) {
      llm = candidate;
      session.setDetector(candidate);
      const state = providerStates.find((candidateState) => candidateState.id === currentProviderId);
      if (state) state.auth = "connected";
    }
  }

  broadcast(providersMessage());
}

const sttManager = new SttModelManager(
  join(import.meta.dir, "models", "stt"),
  new SttModelSettingsStore(import.meta.dir),
);
sttManager.subscribe(() => broadcast(sttModelsMessage(sttManager.allStates())));

function whisperConfigForSelection() {
  return { ...config.whisper, modelPath: sttManager.selectedPath() ?? config.whisper.modelPath };
}
function createWhisperCapture() {
  const whisperConfig = whisperConfigForSelection();
  return config.input.mode === "file" && config.input.filePath
    ? new WhisperCLI(whisperConfig, config.input.filePath)
    : new WhisperStream(whisperConfig);
}
let whisper = createWhisperCapture();

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

// ws → listener 매핑: close 시 정확히 제거하기 위함.
const wsListeners = new Map<ServerWebSocket<undefined>, ClientListener>();

// CSWSH 방어: 브라우저가 자동으로 붙이는 Origin이 이 서버 자신이 아니면
// 업그레이드를 거부한다. curl 같은 비브라우저 클라이언트는 Origin을 보내지
// 않으므로 그대로 허용한다.
const ALLOWED_WS_ORIGINS = new Set([
  `http://localhost:${config.server.httpPort}`,
  `http://127.0.0.1:${config.server.httpPort}`,
  `http://[::1]:${config.server.httpPort}`,
]);

const httpServer = Bun.serve({
  port: config.server.httpPort,
  // 로컬 도구: LAN의 다른 기기가 전사 내용에 접근할 필요가 없으므로 루프백만 바인드.
  hostname: "127.0.0.1",
  websocket: {
    open(ws: ServerWebSocket<undefined>) {
      const listener: ClientListener = (msg: ServerMessage) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(msg));
      };
      session.addListener(listener);
      wsListeners.set(ws, listener);
      ws.send(JSON.stringify({
        type: "status" as const,
        text: `연결됨. LLM provider=${config.llm.provider} model=${llmLabel}`,
      }));
      ws.send(JSON.stringify(session.snapshot()));
      ws.send(JSON.stringify(providersMessage()));
      ws.send(JSON.stringify(sttModelsMessage(sttManager.allStates())));
      ws.send(JSON.stringify(captureMessage()));
      ws.send(JSON.stringify(session.transcript("snapshot")));
      if (lastSavedPath) {
        ws.send(JSON.stringify({ type: "saved" as const, path: lastSavedPath }));
      }
    },
    message(ws: ServerWebSocket<undefined>, data: string | Buffer) {
      try {
        const cmd = JSON.parse(typeof data === "string" ? data : data.toString("utf-8")) as { action?: string; id?: string; key?: string; model?: string; effort?: string; modelId?: unknown; meetingId?: unknown };
        if (cmd.action === "startCapture") void startCapture();
        else if (cmd.action === "stopCapture") void stopCapture();
        else if (cmd.action === "reset") {
          session.reset();
          // 회의 저장소도 새 회의로 전환 (캡처 중이면 이어서 기록)
          store.endMeeting();
          if (capturing) store.startMeeting(currentProviderId);
          broadcast(session.transcript("snapshot"));
          broadcast(meetingsMessage());
        }
        else if (cmd.action === "status") {
          ws.send(JSON.stringify({ type: "status" as const, text: "서버 정상" }));
        }
        else if (cmd.action === "listMeetings") {
          ws.send(JSON.stringify(meetingsMessage()));
        }
        else if (cmd.action === "selectMeeting") {
          if (typeof cmd.meetingId !== "number" || !Number.isSafeInteger(cmd.meetingId)) {
            ws.send(JSON.stringify({ type: "status" as const, text: "meetingId must be a number" }));
          } else {
            const detail = store.meetingDetail(cmd.meetingId);
            ws.send(JSON.stringify(detail === null
              ? { type: "status" as const, text: `회의 ${cmd.meetingId}을 찾을 수 없습니다` }
              : { type: "meeting" as const, ...detail }));
          }
        }
        else if (cmd.action === "transcript") {
          ws.send(JSON.stringify(session.transcript("export")));
        }
        else if (cmd.action === "compileDeck") {
          const jobId: CompileJobId = `compile-${randomUUID()}`;
          if (cmd.meetingId !== undefined && !validMeetingId(cmd.meetingId)) {
            broadcast({ type: "compile", status: "started", jobId });
            broadcast({ type: "compile", status: "error", jobId, error: "meetingId must be a number" });
          } else if (activeJob !== null) {
            broadcast({ type: "compile", status: "error", jobId, meetingId: typeof cmd.meetingId === "number" ? cmd.meetingId : undefined, error: `A conflicting ${activeJob.action} job is already in progress` });
          } else {
            const requestedMeetingId = cmd.meetingId ?? store.latestMeeting()?.id;
            if (requestedMeetingId === undefined) {
              void runCompileDeckAction({ store, planner: llm, jobId, exportsDirectory: join(import.meta.dir, "exports"), send: broadcast });
            } else {
              activeJob = { id: jobId, meetingId: requestedMeetingId, action: "compileDeck" };
              void runCompileDeckAction({
                store, planner: llm, jobId, meetingId: requestedMeetingId, timeoutMs: 120_000,
                exportsDirectory: join(import.meta.dir, "exports"), send: broadcast,
              }).finally(() => { if (activeJob?.id === jobId) activeJob = null; });
            }
          }
        }
        else if (cmd.action === "exportDeck" || cmd.action === "exportPdf" || cmd.action === "exportPng") {
          const requestedMeetingId = validMeetingId(cmd.meetingId)
            ? cmd.meetingId
            : cmd.meetingId === undefined ? store.latestMeeting()?.id : undefined;
          if (cmd.meetingId !== undefined && !validMeetingId(cmd.meetingId)) {
            if (cmd.action === "exportPdf" || cmd.action === "exportPng") {
              const prefix = cmd.action === "exportPdf" ? "pdf" : "png";
              const jobId = `${prefix}-${randomUUID()}` as ExportJobId;
              broadcast({ type: "export", status: "error", action: cmd.action, jobId, code: "invalid-meeting-id", error: "meetingId must be a positive safe integer" });
            } else {
              broadcast({ type: "status", text: "meetingId must be a positive safe integer" });
            }
          } else if (requestedMeetingId === undefined) {
            if (cmd.action === "exportPdf" || cmd.action === "exportPng") {
              const prefix = cmd.action === "exportPdf" ? "pdf" : "png";
              const jobId = `${prefix}-${randomUUID()}` as ExportJobId;
              broadcast({ type: "export", status: "error", action: cmd.action, jobId, code: "meeting-not-found", error: "No stored meeting was found" });
            } else {
              broadcast({ type: "status", text: "저장된 회의가 없습니다" });
            }
          } else if (activeJob !== null) {
            if (cmd.action === "exportPdf" || cmd.action === "exportPng") {
              const prefix = cmd.action === "exportPdf" ? "pdf" : "png";
              const jobId = `${prefix}-${randomUUID()}` as ExportJobId;
              broadcast({
                type: "export", status: "error", action: cmd.action, jobId, meetingId: requestedMeetingId,
                code: "job-busy", error: `A conflicting ${activeJob.action} job is already in progress`,
              });
            } else {
              broadcast({ type: "status", text: `A conflicting ${activeJob.action} job is already in progress` });
            }
          } else if (cmd.action === "exportDeck") {
            try {
              const stamp = new Date().toISOString().replace(/[:.]/g, "-");
              const dir = join(import.meta.dir, "exports", `deck-${stamp}`);
              const slidesDir = join(dir, "slides");
              mkdirSync(slidesDir, { recursive: true });
              copyFileSync(join(import.meta.dir, "deck", "theme.css"), join(dir, "theme.css"));
              copyFileSync(join(import.meta.dir, "deck", "theme.css"), join(slidesDir, "theme.css"));
              copyDeckAssets({ sourceDirectory: join(import.meta.dir, "deck", "assets"), exportDirectory: dir, slidesDirectory: slidesDir });
              const material = prepareExportDeck(store, requestedMeetingId);
              writeFileSync(join(dir, "index.html"), material.indexHtml, "utf-8");
              for (const file of material.files) writeFileSync(join(slidesDir, file.filename), file.html, "utf-8");
              lastSavedPath = `exports/deck-${stamp}/index.html`;
              broadcast({ type: "saved", path: lastSavedPath });
              broadcast({ type: "status", text: `덱 저장됨: ${lastSavedPath}` });
              openUrl(`file://${join(dir, "index.html")}`);
            } catch (error) {
              broadcast({ type: "status", text: `저장 실패: ${error instanceof Error ? error.message : String(error)}` });
            }
          } else {
            const prefix = cmd.action === "exportPdf" ? "pdf" : "png";
            const jobId = `${prefix}-${randomUUID()}` as ExportJobId;
            activeJob = { id: jobId, meetingId: requestedMeetingId, action: cmd.action };
            void runImageExport(cmd.action, requestedMeetingId, jobId)
              .finally(() => { if (activeJob?.id === jobId) activeJob = null; });
          }
        }
        else if (cmd.action === "saveNotes" || cmd.action === "saveTranscript" || cmd.action === "saveJson") {
          try {
            if (cmd.meetingId !== undefined && !validMeetingId(cmd.meetingId)) {
              throw new Error("meetingId must be a positive safe integer");
            }
            const meetingId = cmd.meetingId ?? store.latestMeeting()?.id;
            if (meetingId === undefined || store.meeting(meetingId) === null) throw new Error("Meeting was not found");
            const dir = join(import.meta.dir, "exports");
            mkdirSync(dir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            let filename: string;
            let contents: string;
            if (cmd.action === "saveJson") {
              const meta = store.meeting(meetingId);
              filename = `meeting-${stamp}.json`;
              contents = JSON.stringify({
                exportedAt: new Date().toISOString(),
                provider: meta?.provider ?? null,
                slides: store.slides(meetingId),
                lines: store.lines(meetingId),
              }, null, 2);
            } else if (cmd.action === "saveTranscript") {
              filename = `transcript-${stamp}.md`;
              contents = store.exportTranscript(meetingId);
            } else {
              filename = `meeting-${stamp}.md`;
              contents = store.exportMarkdown(meetingId);
            }
            writeFileSync(join(dir, filename), contents, "utf-8");
            lastSavedPath = `exports/${filename}`;
            broadcast({ type: "saved", path: lastSavedPath });
            broadcast({ type: "status", text: `저장됨: ${lastSavedPath}` });
          } catch (error) {
            broadcast({ type: "status", text: `저장 실패: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
        else if (cmd.action === "installSttModel") {
          if (!isSttModelId(cmd.modelId)) ws.send(JSON.stringify({ type: "status" as const, text: "알 수 없는 STT 모델입니다" }));
          else void sttManager.install(cmd.modelId);
        }
        else if (cmd.action === "cancelSttModel") {
          if (!isSttModelId(cmd.modelId) || !sttManager.cancel(cmd.modelId)) {
            ws.send(JSON.stringify({ type: "status" as const, text: "취소할 STT 다운로드가 없습니다" }));
          }
        }
        else if (cmd.action === "selectSttModel") {
          if (!isSttModelId(cmd.modelId)) ws.send(JSON.stringify({ type: "status" as const, text: "알 수 없는 STT 모델입니다" }));
          else void selectSttModel(cmd.modelId);
        }
        else if (cmd.action === "recheckSttModels") {
          broadcast(sttModelsMessage(sttManager.recheck()));
        }
        else if (cmd.action === "setProvider" && typeof cmd.id === "string") {
          const entry = providerEntries.find((e) => e.id === cmd.id);
          if (!entry) {
            ws.send(JSON.stringify({ type: "status" as const, text: `알 수 없는 프로바이더: ${cmd.id}` }));
          } else if (!(entry.selectable ?? entry.available)) {
            const reason = entry.installed === false ? "CLI가 설치되지 않음"
              : entry.auth === "unknown" ? "인증 상태를 확인할 수 없음"
              : entry.auth === "disconnected" ? "로그인되지 않음"
              : "설정되지 않음";
            ws.send(JSON.stringify({ type: "status" as const, text: `${entry.label}: ${reason}` }));
          } else {
            const adapter = providerAdapter(entry.id);
            const requestedModel = typeof cmd.model === "string" && cmd.model.trim() ? cmd.model.trim() : undefined;
            const model = requestedModel && (entry.models ?? []).includes(requestedModel)
              ? requestedModel
              : adapter?.defaultModel;
            const requestedEffort = typeof cmd.effort === "string" && cmd.effort.trim() ? cmd.effort.trim() : undefined;
            const effort = requestedEffort && (entry.efforts ?? []).includes(requestedEffort)
              ? requestedEffort
              : adapter?.defaultEffort;
            const detector = createDetector(entry.id, { cliTimeoutMs, model, effort });
            if (detector) {
              session.setDetector(detector);
              llm = detector;
              currentProviderId = entry.id;
              currentModel = model;
              currentEffort = effort;
              llmLabel = `${entry.label}${model ? `/${model}` : ""}${effort ? `·${effort}` : ""}`;
              appSettings.save({ providerId: entry.id as Parameters<AppSettingsStore["save"]>[0]["providerId"], ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
              broadcast(providersMessage());
              broadcast({ type: "status", text: `LLM 변경됨: ${llmLabel}` });
              void detector.ping().then((ok) => {
                if (!ok) broadcast({ type: "status", text: `⚠️ ${entry.label} 연결 확인에 실패했습니다` });
              });
            }
          }
        }
        else if (cmd.action === "connectProvider" && typeof cmd.id === "string") {
          connectProvider(cmd.id);
        }
        else if (cmd.action === "setProviderKey" && typeof cmd.id === "string" && typeof cmd.key === "string") {
          const envKey = KEY_BY_PROVIDER[cmd.id];
          const key = cmd.key.trim();
          if (!envKey || !key || /[\r\n]/.test(key)) {
            ws.send(JSON.stringify({ type: "status" as const, text: "잘못된 키 형식입니다" }));
          } else {
            // 런타임 즉시 적용 + .env에도 기록 (0600). 기록 실패해도 세션은 동작.
            process.env[envKey] = key;
            try {
              const envPath = join(import.meta.dir, ".env");
              const current = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
              writeFileSync(envPath, upsertEnvText(current, { [envKey]: key }), { mode: 0o600 });
            } catch {
              broadcast({ type: "status", text: "(.env 기록 실패 — 이번 세션에만 적용됩니다)" });
            }
            const entry = providerEntries.find((e) => e.id === cmd.id);
            if (entry) entry.available = true;
            broadcast(providersMessage());
            broadcast({ type: "status", text: `${entry?.label ?? cmd.id} 키 저장됨 ✓` });
          }
        }
        else if (cmd.action === "recheckProviders") {
          void recheckProviders();
        }
      } catch (e) {
        // JSON 파싱 실패 또는 핸들러 내부 예외 — 클라이언트에 피드백.
        const message = e instanceof Error ? e.message : String(e);
        console.error("[ws] 메시지 처리 실패:", message);
        try {
          ws.send(JSON.stringify({ type: "status" as const, text: `요청 처리 실패: ${message}` }));
        } catch { /* ws 이미 닫힘 */ }
      }
    },
    close(ws: ServerWebSocket<undefined>) {
      const listener = wsListeners.get(ws);
      if (listener) {
        session.removeListener(listener);
        wsListeners.delete(ws);
      }
    },
  },
  fetch(req: Request, server: Bun.Server<undefined>): Response | Promise<Response> | undefined {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const origin = req.headers.get("origin");
      if (origin && !ALLOWED_WS_ORIGINS.has(origin)) {
        return new Response("Forbidden origin", { status: 403 });
      }
      const ok = server.upgrade(req);
      if (ok) return undefined;
      return new Response("Upgrade failed", { status: 426 });
    }
    // Meeting Slides.app WKWebView는 /app 을 엔트리로 로드한다.
    const path = (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/app/")
      ? "/index.html"
      : url.pathname;
    const publicDir = join(import.meta.dir, "public");
    const filePath = join(publicDir, path);
    if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${sep}`)) {
      return new Response("Forbidden", { status: 403 });
    }
    const f = Bun.file(filePath);
    return f.exists().then((exists) => {
      if (!exists) return new Response("Not Found", { status: 404 });
      const ext = path.split(".").pop() ?? "";
      const mime = MIME[ext] ?? "application/octet-stream";
      return new Response(f, { headers: { "content-type": mime, "x-content-type-options": "nosniff" } });
    });
  },
});

console.log(`HTTP: http://localhost:${httpServer.port}`);
console.log(`입력 모드: ${config.input.mode}${config.input.filePath ? ` (${config.input.filePath})` : ""}`);
console.log(`meeting-slides 서버 시작. 브라우저에서 http://localhost:${httpServer.port} 접속`);

// ── 브라우저 자동 오픈 (플랫폼별 기본 브라우저) ──
if (config.server.openBrowser) {
  const url = `http://localhost:${httpServer.port}`;
  const cmd = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited.then((code) => {
    if (code !== 0) console.warn(`브라우저 열기 실패 (exit ${code})`);
  }).catch(() => {});
}

// ── 캡처 제어 ──
// 마이크 모드는 사용자가 UI의 "녹음 시작/중지" 버튼으로 제어한다 (부팅 시 자동
// 시작하지 않음 — 마이크 권한 요청 시점도 사용자 클릭에 맞춤). 파일 모드는
// 데모용으로 부팅 즉시 자동 시작.
let capturing = false;
let stopPromise: Promise<void> | null = null;

const selectSttModel = createSelectSttModel(sttManager, {
  isCapturing: () => capturing,
  stopCapture,
  startCapture,
  rebuildCapture() {
    whisper = createWhisperCapture();
    broadcast(sttModelsMessage(sttManager.allStates()));
    broadcast({ type: "status", text: `STT 모델 변경됨: ${sttManager.selectedPath() ?? config.whisper.modelPath}` });
  },
});

function captureMessage(): CaptureUpdate {
  return { type: "capture", capturing, mode: config.input.mode };
}

const whisperHandlers = {
  onChunk: (c: TranscriptChunk) => session.onChunk(c),
  onStatus: (s: string) => {
    console.log(`[whisper] ${s}`);
    broadcast({ type: "status", text: s });
  },
  onError: (e: Error) => {
    console.error(`[whisper error] ${e.message}`);
    broadcast({ type: "status", text: `whisper 오류: ${e.message}` });
  },
};

async function startCapture(): Promise<void> {
  if (capturing) return;
  capturing = true;
  // 빠른 시작/중지 반복 시 이전 whisper 자식이 완전히 종료되기 전에
  // 새 start가 들어오면 마이크 장치 경쟁이 발생한다. stop이 끝날 때까지 대기.
  if (stopPromise) await stopPromise;
  // 이전 실행의 고아 whisper-stream이 마이크 장치를 점유하면 새 캡처는 무음이
  // 된다. 우리 바이너리+모델 경로 조합의 잔재만 정리하고 시작한다.
  if (config.input.mode === "mic") {
    spawnSync("pkill", ["-f", `${config.whisper.streamBin} -m ${config.whisper.modelPath}`], { stdio: "ignore" });
  }
  store.startMeeting(currentProviderId);
  broadcast(captureMessage());
  broadcast(meetingsMessage());
  broadcast({ type: "status", text: "🎤 녹음 시작 — 말씀하세요" });
  void whisper.start(whisperHandlers).then(async () => {
    await session.flush();
    const wasCapturing = capturing;
    capturing = false;
    broadcast(captureMessage());
    if (config.input.mode === "mic" && wasCapturing) {
      // 사용자가 중지하지 않았는데 캡처가 끝남 = 장치/권한 이상
      console.warn("[whisper] 마이크 캡처가 종료됨 — 장치/권한 확인 필요");
      broadcast({ type: "status", text: "⚠️ 마이크 캡처가 종료되었습니다 — 장치/권한 확인 후 다시 시작하세요" });
    } else {
      broadcast({ type: "status", text: "입력 종료" });
    }
  }).catch((e: unknown) => {
    capturing = false;
    broadcast(captureMessage());
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[whisper fatal] ${message}`);
    broadcast({ type: "status", text: `whisper 치명 오류: ${message}` });
  });
}

async function stopCapture(): Promise<void> {
  if (!capturing) {
    broadcast(captureMessage());
    broadcast({ type: "status", text: "이미 녹음이 중지된 상태입니다" });
    return;
  }
  capturing = false;
  broadcast(captureMessage());
  // startCapture가 await stopPromise로 기다릴 수 있도록 promise를 노출.
  const p = whisper.stop();
  stopPromise = p;
  try {
    await p;
    await session.flush();
    store.endMeeting();
    broadcast(meetingsMessage());
    broadcast({ type: "status", text: "⏹ 녹음 중지 — 슬라이드/전사본을 저장할 수 있습니다" });
  } finally {
    stopPromise = null;
  }
}

if (config.input.mode === "file") {
  void startCapture();
}

const ok = await llm.ping();
if (ok) {
  console.log(`LLM 연결 OK: ${config.llm.provider} / ${llmLabel}`);
} else {
  console.warn(`LLM 핑 실패 - 서버는 동작함. provider=${config.llm.provider}`);
}

const shutdown = async () => {
  console.log("\n종료 중...");
  // 캡처를 먼저 멈춰야 flush 도중 새 청크가 끼어들어 문장이 유실되지 않는다.
  await whisper.stop();
  await session.flush();
  process.exit(0);
};
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
