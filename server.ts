// ============================================================
// server.ts - 메인 진입점: HTTP + WebSocket + 세션 오케스트레이션
// ============================================================
// Bun.serve의 네이티브 websocket 지원 사용.
// 단일 프로세스에서 whisper-stream 자식 + LLM 블록 감지 + 클라이언트 push.

import { loadConfig, loadWhisperConfig } from "./src/config.ts";
import { WhisperStream, WhisperCLI, listCaptureDevices, type TranscriptChunk } from "./src/whisper.ts";
import { LLMClient, type ChatTransport, type MeetingLLM } from "./src/llm.ts";
import { CliLLMClient } from "./src/llm-cli.ts";
import { MeetingSession, type ServerMessage, type ClientListener, type ProvidersUpdate, type CaptureUpdate, type ExportUpdate, type ReviewUpdate } from "./src/session.ts";
import { buildProviderEntriesFromStates, checkCliBin, createDetector, inspectSubscriptionProviders, KEY_BY_PROVIDER, PROVIDER_ADAPTERS, providerAdapter, providerConnectCommand, upsertEnvText, type ProviderRuntimeState, type SubscriptionProviderId } from "./src/providers.ts";
import { AppSettingsStore } from "./src/app-settings.ts";
import { SttModelManager } from "./src/stt-model-downloader.ts";
import { createSelectSttModel } from "./src/stt-model-selection.ts";
import { isSttModelId, type SttModelId } from "./src/stt-model-catalog.ts";
import { sttModelsMessage } from "./src/stt-model-protocol.ts";
import { SttModelSettingsStore } from "./src/stt-model-settings.ts";
import { MeetingStore } from "./src/store.ts";
import { deleteMeetingHistory } from "./src/meeting-deletion.ts";
import { MinutesStore, type AttendeeInput, type ReviewState } from "./src/minutes-store.ts";
import { CaptureFinalizer, RawAudioRecorder, TranscriptVersionWriter, claimFileAudioSource, sha256File } from "./src/transcript-versioning.ts";
import { MinutesExtractor } from "./src/extract.ts";
import { startReview } from "./src/start-review.ts";
import { concludeMeeting } from "./src/conclusion.ts";
import { runSceneCompileAction } from "./src/scene-compile-action.ts";
import { prepareExportDeck } from "./src/deck-export.ts";
import { buildPassAReport, buildPassBReport } from "./src/grab.ts";
import { buildReviewPrompt, runVisualReview } from "./src/visual-review.ts";
import { createHash, randomUUID } from "node:crypto";
import type { CompileJobId, ExportJobId } from "./src/session.ts";
import { join, sep } from "node:path";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
let extractionTransport: ChatTransport;
let llmLabel: string;
if (config.llm.cli) {
  const client = new CliLLMClient(config.llm.cli);
  llm = client;
  extractionTransport = client;
  const model = config.llm.cli.model ? ` · ${config.llm.cli.model}` : "";
  const effort = config.llm.cli.effort ? ` · effort=${config.llm.cli.effort}` : "";
  llmLabel = `cli:${config.llm.cli.preset}(${config.llm.cli.bin})${model}${effort}`;
} else {
  if (!config.llm.config) throw new Error(`provider=${config.llm.provider}에 HTTP 설정이 없습니다`);
  const client = new LLMClient(config.llm.config);
  llm = client;
  extractionTransport = client;
  llmLabel = config.llm.config.model;
}
const listeners = new Set<ClientListener>();
const broadcast = (msg: ServerMessage) => {
  for (const l of listeners) { try { l(msg); } catch {} }
};
// anarlog(fastrepl) 방식: 전사·슬라이드를 로컬 SQLite에 영속 저장
const databasePath = process.env.MEETINGS_DB_PATH ?? join(import.meta.dir, "meetings.db");
const bundleOutputRoot = process.env.MEETING_BUNDLE_OUTPUT_ROOT ?? join(import.meta.dir, "exports");
const bundleTargetCommit = process.env.MEETING_BUNDLE_TARGET_COMMIT
  ?? spawnSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dir, encoding: "utf8" }).stdout.trim();
const store = new MeetingStore(databasePath);
const minutesStore = new MinutesStore(store.databaseHandle());
const transcriptWriter = new TranscriptVersionWriter(minutesStore);
const session = new MeetingSession(
  llm,
  config.block.detectInterval,
  config.block.contextWindow,
  listeners,
  {
    onLine: (entry) => transcriptWriter.append(entry),
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
  { automaticDetection: false },
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
      extractionTransport = restored;
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
// Compile/PPTX/PDF/PNG share one artifact pipeline and must never overlap.
type ActiveJob = { id: CompileJobId | ExportJobId; meetingId: number; action: "compileDeck" | "compileTranscriptSnapshot" | "exportDeck" | "exportPptx" | "exportPdf" | "exportPng" };
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
    broadcast({ type: "status", text: `${adapter.label} 로그인 화면을 열었습니다. 로그인 후 연결 상태를 다시 확인해 주세요` });
    spawn(command.executable, command.args, {
      env: command.environment,
      stdio: "inherit",
      detached: true,
    }).unref();
    return;
  }
  switch (id) {
    case "openai": {
      broadcast({ type: "status", text: "OpenAI API 키 발급 페이지를 열었습니다. 발급한 키를 입력해 주세요" });
      openUrl("https://platform.openai.com/api-keys");
      break;
    }
    case "alibaba": {
      broadcast({ type: "status", text: "Alibaba Cloud 콘솔을 열었습니다. 발급한 API 키를 입력해 주세요" });
      openUrl("https://bailian.console.aliyun.com/");
      break;
    }
    default:
      broadcast({ type: "status", text: "로컬 모델 서버 주소를 설정해 주세요" });
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

interface WsCommand {
  action?: string;
  id?: string;
  key?: string;
  model?: string;
  effort?: string;
  meeting_id?: unknown;
  purpose?: unknown;
  attendees?: unknown;
  reviewId?: unknown;
  itemId?: unknown;
  kind?: unknown;
  patch?: unknown;
}

let currentMeetingId: number | null = null;

function requestError(ws: ServerWebSocket<undefined>, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ws.send(JSON.stringify({ type: "status" as const, text: `요청 처리 실패: ${message}` }));
}

function parseAttendees(value: unknown): AttendeeInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("attendees must contain at least one attendee");
  }
  const attendeeIds = new Set<string>();
  const crmPersonIds = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`attendees[${index}] must be an object`);
    }
    const attendee = raw as Record<string, unknown>;
    if (typeof attendee.name !== "string" || !attendee.name.trim()) {
      throw new Error(`attendees[${index}].name must be a non-blank string`);
    }
    let attendeeId: string;
    if (attendee.attendeeId === undefined) attendeeId = randomUUID();
    else if (typeof attendee.attendeeId !== "string" || !attendee.attendeeId.trim()) {
      throw new Error(`attendees[${index}].attendeeId must be a non-blank string when provided`);
    } else attendeeId = attendee.attendeeId.trim();
    if (attendeeIds.has(attendeeId)) throw new Error(`duplicate attendeeId: ${attendeeId}`);
    attendeeIds.add(attendeeId);

    let crmPersonEntityId: string | null = null;
    if (attendee.crmPersonId !== undefined && attendee.crmPersonId !== null) {
      if (typeof attendee.crmPersonId !== "string" || !attendee.crmPersonId.trim()) {
        throw new Error(`attendees[${index}].crmPersonId must be a non-blank string or null`);
      }
      crmPersonEntityId = attendee.crmPersonId.trim();
      if (crmPersonIds.has(crmPersonEntityId)) throw new Error(`duplicate crmPersonId: ${crmPersonEntityId}`);
      crmPersonIds.add(crmPersonEntityId);
    }
    return { attendeeId, displayName: attendee.name.trim(), crmPersonEntityId, sortOrder: index };
  });
}

function parsePurpose(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error("purpose must be a non-blank string or null");
  return value.trim();
}

type ReviewItemKind = "decision" | "action_item" | "open_item";
type ReviewItemPatch = Parameters<MinutesStore["updateItem"]>[3];

function reviewRequestError(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

function parseReviewId(value: unknown, field: "reviewId" | "itemId"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw reviewRequestError("INVALID_REVIEW_REQUEST", `${field} must be a non-blank string`);
  }
  return value.trim();
}

function parseReviewKind(value: unknown): ReviewItemKind {
  if (value !== "decision" && value !== "action_item" && value !== "open_item") {
    throw reviewRequestError("INVALID_REVIEW_REQUEST", "kind must be decision, action_item, or open_item");
  }
  return value;
}

function parseReviewPatch(value: unknown, kind: ReviewItemKind): ReviewItemPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw reviewRequestError("INVALID_REVIEW_PATCH", "patch must be an object");
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["description", "attributedAttendeeId", "reviewState"]);
  if (kind === "action_item") {
    allowed.add("assigneeAttendeeId");
    allowed.add("deadline");
    allowed.add("deadlineText");
  }
  const unsupported = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw reviewRequestError("INVALID_REVIEW_PATCH", `unsupported patch field: ${unsupported.sort()[0]}`);
  }
  if (Object.keys(raw).length === 0) throw reviewRequestError("INVALID_REVIEW_PATCH", "patch must not be empty");
  const patch: ReviewItemPatch = {};
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string" || !raw.description.trim()) {
      throw reviewRequestError("INVALID_REVIEW_PATCH", "description must be a non-blank string");
    }
    patch.description = raw.description.trim();
  }
  for (const field of ["attributedAttendeeId", "assigneeAttendeeId"] as const) {
    if (raw[field] !== undefined) {
      if (raw[field] !== null && (typeof raw[field] !== "string" || !raw[field].trim())) {
        throw reviewRequestError("INVALID_REVIEW_PATCH", `${field} must be a non-blank string or null`);
      }
      patch[field] = raw[field] === null ? null : (raw[field] as string).trim();
    }
  }
  if (raw.deadline !== undefined) {
    if (raw.deadline !== null && (typeof raw.deadline !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.deadline))) {
      throw reviewRequestError("INVALID_REVIEW_PATCH", "deadline must be YYYY-MM-DD or null");
    }
    patch.deadline = raw.deadline as string | null;
  }
  if (raw.deadlineText !== undefined) {
    if (raw.deadlineText !== null && (typeof raw.deadlineText !== "string" || !raw.deadlineText.trim())) {
      throw reviewRequestError("INVALID_REVIEW_PATCH", "deadlineText must be a non-blank string or null");
    }
    patch.deadlineText = raw.deadlineText === null ? null : (raw.deadlineText as string).trim();
  }
  if (raw.reviewState !== undefined) {
    if (raw.reviewState !== "candidate" && raw.reviewState !== "confirmed" && raw.reviewState !== "rejected") {
      throw reviewRequestError("INVALID_REVIEW_PATCH", "reviewState must be candidate, confirmed, or rejected");
    }
    patch.reviewState = raw.reviewState as ReviewState;
  }
  return patch;
}

type WsActionContext = {
  ws: ServerWebSocket<undefined>;
  cmd: WsCommand;
};

type WsActionHandler = (ctx: WsActionContext) => void;

const handleStartCapture: WsActionHandler = ({ ws, cmd }) => {
  void startCapture(cmd.meeting_id).catch((error) => requestError(ws, error));
};

const handleStopCapture: WsActionHandler = ({ ws, cmd }) => {
  void stopCapture();
};

const reviewRuns = new Map<string, {
  promise: Promise<ReviewUpdate>;
  requesters: Set<ServerWebSocket<undefined>>;
}>();
const completedReviews = new Map<string, ReviewUpdate>();

const handleStartReview: WsActionHandler = ({ ws }) => {
  if (capturing) {
    requestError(ws, new Error("capture must be stopped before starting review"));
    return;
  }
  if (currentMeetingId === null) {
    requestError(ws, new Error("no current meeting to review"));
    return;
  }

  const meetingId = currentMeetingId;
  const meta = minutesStore.meetingMeta(meetingId);
  if (meta?.phase !== "ended") {
    requestError(ws, new Error(`meeting ${meetingId} must be ended before review`));
    return;
  }
  const canonical = minutesStore.canonicalVersion(meetingId);
  if (!canonical) {
    requestError(ws, new Error(`meeting ${meetingId} has no canonical transcript version`));
    return;
  }
  const key = `${meetingId}:${canonical.transcriptVersionId}`;
  const completed = completedReviews.get(key);
  if (completed) {
    broadcast(completed);
    return;
  }
  const active = reviewRuns.get(key);
  if (active) {
    active.requesters.add(ws);
    return;
  }

  broadcast({ type: "status", text: "회의록 정리 중…" });
  const promise = startReview({
    meetingId,
    store: minutesStore,
    extractor: new MinutesExtractor(extractionTransport),
  });
  const run = { promise, requesters: new Set([ws]) };
  reviewRuns.set(key, run);
  void promise.then((review) => {
    completedReviews.set(key, review);
    broadcast(review);
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[review] 추출 실패: ${message}`);
    for (const requester of run.requesters) {
      try {
        requester.send(JSON.stringify({ type: "status" as const, text: "회의록을 정리하지 못했습니다" }));
      } catch { /* requester disconnected */ }
    }
  }).finally(() => {
    if (reviewRuns.get(key) === run) reviewRuns.delete(key);
  });
};

const handleReset: WsActionHandler = ({ ws }) => {
  if (capturing || captureRun) {
    requestError(ws, new Error("capture must be stopped before reset"));
    return;
  }
  session.reset();
  store.endMeeting();
  if (currentMeetingId !== null && minutesStore.meetingMeta(currentMeetingId)?.phase !== "ended") {
    minutesStore.endMeeting(currentMeetingId);
  }
  currentMeetingId = null;
  broadcast(session.transcript("snapshot"));
  broadcast(meetingsMessage());
};

const handleSetAttendees: WsActionHandler = ({ cmd }) => {
  const attendees = parseAttendees(cmd.attendees);
  const purpose = parsePurpose(cmd.purpose);
  const meetingId = currentMeetingId ?? minutesStore.ensurePreparedMeeting(currentProviderId, purpose ?? null);
  const meta = minutesStore.meetingMeta(meetingId);
  if (!meta) throw new Error(`unknown meeting ${meetingId}`);
  if (meta.phase !== "prepared") throw new Error(`meeting ${meetingId} is not prepared`);
  minutesStore.replaceAttendees(meetingId, attendees);
  if (purpose !== undefined) minutesStore.setMeetingPurpose(meetingId, purpose);
  currentMeetingId = meetingId;
  broadcast({
    type: "attendees",
    meeting_id: meetingId,
    attendees: minutesStore.attendeesFor(meetingId).map((attendee) => ({
      attendee_id: attendee.attendeeId,
      display_name: attendee.displayName,
      ...(attendee.crmPersonEntityId === null ? {} : { crm_person_entity_id: attendee.crmPersonEntityId }),
    })),
  });
};

/**
 * 재연결 복원 질의 — 클라이언트가 보관 중인 draft 명단/meeting_id를 다시 요청한다.
 * 준비된 회의가 없으면 빈 명단을 돌려 클라이언트 상태를 서버와 맞춘다.
 * 읽기 전용이라 브로드캐스트하지 않고 요청한 소켓에만 답한다.
 */
const handleAttendeesQuery: WsActionHandler = ({ ws }) => {
  const meetingId = currentMeetingId;
  ws.send(JSON.stringify({
    type: "attendees" as const,
    meeting_id: meetingId,
    attendees: meetingId === null ? [] : minutesStore.attendeesFor(meetingId).map((attendee) => ({
      attendee_id: attendee.attendeeId,
      display_name: attendee.displayName,
      ...(attendee.crmPersonEntityId === null ? {} : { crm_person_entity_id: attendee.crmPersonEntityId }),
    })),
  }));
};

const handleUpdateItem: WsActionHandler = ({ cmd }) => {
  const reviewId = parseReviewId(cmd.reviewId, "reviewId");
  const itemId = parseReviewId(cmd.itemId, "itemId");
  const kind = parseReviewKind(cmd.kind);
  const patch = parseReviewPatch(cmd.patch, kind);
  minutesStore.updateItem(reviewId, kind, itemId, patch);
  broadcast({ type: "reviewItemUpdated", reviewId, itemId, kind });
};

const handleConfirmReview: WsActionHandler = ({ ws, cmd }) => {
  const reviewId = parseReviewId(cmd.reviewId, "reviewId");
  void concludeMeeting(reviewId, {
    store: minutesStore,
    outputRoot: bundleOutputRoot,
    projectRoot: import.meta.dir,
    targetCommit: bundleTargetCommit,
  }).then((conclusion) => {
    const review = minutesStore.review(reviewId)!;
    broadcast({
      type: "reviewConfirmed",
      reviewId,
      transcriptVersionId: review.transcriptVersionId,
      confirmedAt: review.confirmedAt!,
    });
    broadcast(conclusion);
  }).catch((error: unknown) => requestError(ws, error));
};

const handleStatus: WsActionHandler = ({ ws, cmd }) => {
  ws.send(JSON.stringify({ type: "status" as const, text: "서버 정상" }));
};

const handleTranscript: WsActionHandler = ({ ws, cmd }) => {
  ws.send(JSON.stringify(session.transcript("export")));
};

const handleDeckExport: WsActionHandler = ({ ws, cmd }) => {
  // lecture-deck 템플릿 기반 reveal.js 덱 + slides-grab 계약 파일 생성
  // PDF/PNG는 초안 경로: validate 후 렌더. 가짜 design-gate proceed 영수증은 쓰지 않는다.
  try {
    const meta = store.latestMeeting();
    if (!meta) {
      broadcast({ type: "status", text: "저장된 회의가 없습니다" });
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = join(import.meta.dir, "exports", `deck-${stamp}`);
      const slidesDir = join(dir, "slides");
      mkdirSync(slidesDir, { recursive: true });
      copyFileSync(join(import.meta.dir, "deck", "theme.css"), join(dir, "theme.css"));
      copyFileSync(join(import.meta.dir, "deck", "theme.css"), join(slidesDir, "theme.css"));
      const input = {
        title: "Meeting Notes",
        startedAt: meta.started_at,
        provider: meta.provider,
        slides: store.slides(meta.id),
        lines: store.lines(meta.id),
      };
      const material = prepareExportDeck(store, meta.id);
      writeFileSync(join(dir, "index.html"), material.indexHtml, "utf-8");
      for (const f of material.files) {
        writeFileSync(join(slidesDir, f.filename), f.html, "utf-8");
      }

      // slides-grab CLI 실행 헬퍼 (프로젝트 로컬 chromium 사용)
      const runGrab = (args: string[], onDone: (code: number | null, tail: string) => void) => {
        const proc = spawn(process.execPath, ["x", "slides-grab", ...args], {
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(import.meta.dir, "vendor", "ms-playwright") },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let tail = "";
        proc.stderr?.on("data", (d: Buffer) => { tail = (tail + d.toString("utf-8")).slice(-400); });
        proc.on("close", (code) => onDone(code, tail));
      };

      if (cmd.action === "exportDeck") {
        lastSavedPath = `exports/deck-${stamp}/index.html`;
        broadcast({ type: "saved", path: lastSavedPath });
        broadcast({ type: "status", text: `웹 슬라이드 저장됨: ${lastSavedPath}` });
        openUrl(`file://${join(dir, "index.html")}`);
      } else if (cmd.action === "exportPng") {
        // 초안 PNG: slides-grab png는 design-gate 대상이 아니라 validate 후 바로 렌더.
        const out = join(import.meta.dir, "exports", `deck-${stamp}-png`);
        broadcast({ type: "status", text: "슬라이드 이미지를 준비하는 중…" });
        runGrab(["validate", "--slides-dir", slidesDir], (vcode, vtail) => {
          if (vcode !== 0) {
            broadcast({ type: "status", text: `슬라이드 파일 확인 실패: ${vtail.trim().slice(0, 160)}` });
            return;
          }
          broadcast({ type: "status", text: "슬라이드 이미지를 만드는 중…" });
          runGrab(["png", "--slides-dir", slidesDir, "--output-dir", out], (code, tail) => {
            if (code === 0) {
              lastSavedPath = `exports/deck-${stamp}-png`;
              broadcast({ type: "saved", path: lastSavedPath });
              broadcast({ type: "status", text: `슬라이드 이미지 저장됨: ${lastSavedPath}` });
            } else {
              broadcast({ type: "status", text: `슬라이드 이미지 저장 실패: ${tail.trim().slice(0, 160)}` });
            }
          });
        });
      } else {
        // 정식 PDF: slides-grab pdf는 design-gate proceed 영수증을 CLI 레벨에서 요구한다.
        // 체인: validate → 정직한 Pass A/B 리포트(실제 수행한 검사를 기록) → design-gate → pdf.
        const out = join(import.meta.dir, "exports", `deck-${stamp}.pdf`);
        broadcast({ type: "status", text: "PDF를 준비하는 중…" });
        const slideFiles = material.files;
        const fingerprints = slideFiles.map((f) => ({
          file: f.filename,
          sha256: createHash("sha256").update(f.html, "utf-8").digest("hex"),
        }));
        runGrab(["validate", "--slides-dir", slidesDir], (vcode, vtail) => {
          if (vcode !== 0) {
            broadcast({ type: "status", text: `슬라이드 파일 확인 실패: ${vtail.trim().slice(0, 160)}` });
            return;
          }
          // 1) 미리보기 PNG 렌더 → 2) 독립 비전 리뷰 → 3) proceed면 게이트 기록 → 4) PDF
          broadcast({ type: "status", text: "PDF 미리보기를 만드는 중…" });
          runGrab(["png", "--slides-dir", slidesDir, "--output-dir", join(slidesDir, ".slides-grab", "gate-preview")], (_pcode, _ptail) => {
            void (async () => {
              try {
                broadcast({ type: "status", text: "슬라이드 디자인을 점검하는 중…" });
                const previewDir = join(slidesDir, ".slides-grab", "gate-preview");
                const previewFiles = readdirSync(previewDir)
                  .filter((f) => f.endsWith(".png"));
                // 리뷰 모델은 비전 검증된 기본값 사용 (사용자 선택 모델이
                // 이미지 입력을 거부할 수 있어 슬라이드 생성 모델과 분리)
                const reviewOpts = { images: previewFiles.map((f) => join(previewDir, f)) };
                const review = await runVisualReview(
                  buildReviewPrompt(reviewOpts),
                  reviewOpts,
                );
                if (review.verdict !== "proceed") {
                  appendFileSync("/tmp/ms-export-flow.log", `${new Date().toISOString()} REVIEW-REVISE ${review.summary} ${review.blockingFindings.join("; ")}\n`);
                  broadcast({
                    type: "status",
                    text: `시각 리뷰 revise: ${review.blockingFindings.join("; ").slice(0, 160) || review.summary}`,
                  });
                  return;
                }
                appendFileSync("/tmp/ms-export-flow.log", `${new Date().toISOString()} REVIEW-PROCEED ${review.confidence}\n`);
                const gateInput = {
                  slideFiles: fingerprints,
                  previewFiles,
                  slideCount: input.slides.length,
                  maxBullets: Math.max(0, ...input.slides.map((s) => s.bullets.length)),
                  lineCount: input.lines.length,
                  reviewed: true,
                  confidence: review.confidence,
                  notes: `독립 시각 리뷰 요약: ${review.summary}`,
                };
                writeFileSync(join(slidesDir, ".pass-a.md"), buildPassAReport(gateInput), "utf-8");
                writeFileSync(join(slidesDir, ".pass-b.md"), buildPassBReport(gateInput), "utf-8");
                broadcast({ type: "status", text: "디자인 점검을 마쳤습니다. PDF 저장을 준비하는 중…" });
                runGrab(
                  ["design-gate", "--slides-dir", slidesDir, "--verdict", "proceed",
                    "--pass-a-report", join(slidesDir, ".pass-a.md"),
                    "--pass-b-report", join(slidesDir, ".pass-b.md")],
                  (gcode, gtail) => {
                    if (gcode !== 0) {
                      broadcast({ type: "status", text: `최종 점검 실패: ${gtail.trim().slice(0, 160)}` });
                      return;
                    }
                    broadcast({ type: "status", text: "PDF를 만드는 중…" });
                    runGrab(["pdf", "--slides-dir", slidesDir, "--output", out], (code, tail) => {
                      if (code === 0) {
                        lastSavedPath = `exports/deck-${stamp}.pdf`;
                        broadcast({ type: "saved", path: lastSavedPath });
                        broadcast({ type: "status", text: `PDF 저장됨: ${lastSavedPath}` });
                      } else {
                        broadcast({ type: "status", text: `PDF 실패: ${tail.trim().slice(0, 160)}` });
                      }
                    });
                  },
                );
              } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                appendFileSync("/tmp/ms-export-flow.log", `${new Date().toISOString()} REVIEW-ERROR ${message.slice(0, 400)}\n`);
                broadcast({ type: "status", text: `디자인 점검 실패: ${message.slice(0, 160)}` });
              }
            })();
          });
        });
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    broadcast({ type: "status", text: `저장 실패: ${message}` });
  }
};

const handleSaveNotes: WsActionHandler = ({ ws, cmd }) => {
  // anarlog 방식: 브라우저 다운로드가 아니라 서버 디스크에 저장 (항상 동작)
  try {
    const dir = join(import.meta.dir, "exports");
    mkdirSync(dir, { recursive: true });
    const filename = `meeting-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
    writeFileSync(join(dir, filename), store.exportMarkdown(), "utf-8");
    lastSavedPath = `exports/${filename}`;
    broadcast({ type: "saved", path: lastSavedPath });
    broadcast({ type: "status", text: `저장됨: ${lastSavedPath}` });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    broadcast({ type: "status", text: `저장 실패: ${message}` });
  }
};

const handleSaveJson: WsActionHandler = ({ ws, cmd }) => {
  try {
    const dir = join(import.meta.dir, "exports");
    mkdirSync(dir, { recursive: true });
    const meta = store.latestMeeting();
    const payload = {
      exportedAt: new Date().toISOString(),
      provider: meta?.provider ?? null,
      slides: meta ? store.slides(meta.id) : [],
      lines: meta ? store.lines(meta.id) : [],
    };
    const filename = `meeting-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(join(dir, filename), JSON.stringify(payload, null, 2), "utf-8");
    lastSavedPath = `exports/${filename}`;
    broadcast({ type: "saved", path: lastSavedPath });
    broadcast({ type: "status", text: `저장됨: ${lastSavedPath}` });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    broadcast({ type: "status", text: `저장 실패: ${message}` });
  }
};

const handleSetProvider: WsActionHandler = ({ ws, cmd }) => {
  if (typeof cmd.id === "string") {
    const entry = providerEntries.find((e) => e.id === cmd.id);
    if (!entry) {
      ws.send(JSON.stringify({ type: "status" as const, text: `알 수 없는 프로바이더: ${cmd.id}` }));
    } else if (!entry.available) {
      ws.send(JSON.stringify({ type: "status" as const, text: `${entry.label}은(는) 설정되지 않았습니다 (CLI 설치/API 키 확인)` }));
    } else {
      // 모델/effort 오버라이드 (빈 문자열이면 기본값, effort는 지원 프로바이더만)
      const model = typeof cmd.model === "string" && cmd.model.trim() ? cmd.model.trim() : undefined;
      const effort = typeof cmd.effort === "string" && cmd.effort.trim() && (entry.efforts ?? []).includes(cmd.effort.trim())
        ? cmd.effort.trim()
        : undefined;
      const detector = createDetector(entry.id, { cliTimeoutMs, model, effort });
      if (detector) {
        session.setDetector(detector);
        extractionTransport = detector;
        currentProviderId = entry.id;
        currentModel = model;
        currentEffort = effort;
        llmLabel = `${entry.label}${model ? `/${model}` : ""}${effort ? `·${effort}` : ""}`;
        broadcast(providersMessage());
        broadcast({ type: "status", text: `LLM 변경됨: ${llmLabel}` });
        void detector.ping().then((ok) => {
          if (!ok) broadcast({ type: "status", text: `⚠️ ${entry.label} 연결 확인에 실패했습니다` });
        });
      }
    }
  }
};

const handleConnectProvider: WsActionHandler = ({ ws, cmd }) => {
  if (typeof cmd.id === "string") {
    connectProvider(cmd.id);
  }
};

const handleSetProviderKey: WsActionHandler = ({ ws, cmd }) => {
  if (typeof cmd.id === "string" && typeof cmd.key === "string") {
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
};

const handleRecheckProviders: WsActionHandler = ({ ws, cmd }) => {
  const claudeOk = checkCliBin("claude");
  const codexOk = checkCliBin("codex");
  for (const e of providerEntries) {
    if (e.id === "cli:claude") e.available = claudeOk;
    if (e.id === "cli:codex") e.available = codexOk;
  }
  broadcast(providersMessage());
};

/** Existing WebSocket actions. Unknown actions intentionally have no handler. */
export const handlerMap = new Map<string, WsActionHandler>([
  ["startCapture", handleStartCapture],
  ["stopCapture", handleStopCapture],
  ["startReview", handleStartReview],
  ["reset", handleReset],
  ["setAttendees", handleSetAttendees],
  ["attendees", handleAttendeesQuery],
  ["updateItem", handleUpdateItem],
  ["confirmReview", handleConfirmReview],
  ["status", handleStatus],
  ["transcript", handleTranscript],
  ["exportDeck", handleDeckExport],
  ["exportPdf", handleDeckExport],
  ["exportPng", handleDeckExport],
  ["saveNotes", handleSaveNotes],
  ["saveJson", handleSaveJson],
  ["setProvider", handleSetProvider],
  ["connectProvider", handleConnectProvider],
  ["setProviderKey", handleSetProviderKey],
  ["recheckProviders", handleRecheckProviders],
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
      ws.send(JSON.stringify(providersMessage()));
      ws.send(JSON.stringify(sttModelsMessage(sttManager.allStates())));
      ws.send(JSON.stringify(captureMessage()));
      ws.send(JSON.stringify(session.snapshot()));
      ws.send(JSON.stringify(session.transcript("snapshot")));
      if (lastSavedPath) {
        ws.send(JSON.stringify({ type: "saved" as const, path: lastSavedPath }));
      }
    },
    message(ws: ServerWebSocket<undefined>, data: string | Buffer) {
      try {
        const cmd = JSON.parse(typeof data === "string" ? data : data.toString("utf-8")) as WsCommand & {
          id?: string;
          key?: string;
          model?: string;
          effort?: string;
          modelId?: unknown;
          meetingId?: unknown;
        };
        if (["startReview", "setAttendees", "attendees", "updateItem", "confirmReview"].includes(cmd.action ?? "")) {
          handlerMap.get(cmd.action ?? "")?.({ ws, cmd });
          return;
        }
        if (cmd.action === "startCapture") {
          void startCapture(cmd.meeting_id).catch((error) => reportCaptureActionError("start", error));
        }
        else if (cmd.action === "stopCapture") {
          void stopCapture().catch((error) => reportCaptureActionError("stop", error));
        }
        else if (cmd.action === "reset") {
          handleReset({ ws, cmd });
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
        else if (cmd.action === "deleteMeeting") {
          if (!validMeetingId(cmd.meetingId)) {
            requestError(ws, new Error("유효한 회의 ID가 필요합니다"));
          } else if (capturing && cmd.meetingId === currentMeetingId) {
            requestError(ws, new Error("녹음 중인 회의는 삭제할 수 없습니다"));
          } else if (deleteMeetingHistory(store.databaseHandle(), cmd.meetingId)) {
            if (cmd.meetingId === currentMeetingId) {
              session.reset();
              currentMeetingId = null;
            }
            broadcast(meetingsMessage());
            ws.send(JSON.stringify({ type: "status" as const, text: "회의 기록을 삭제했습니다" }));
          } else {
            requestError(ws, new Error(`회의 ${cmd.meetingId}을 찾을 수 없습니다`));
          }
        }
        else if (cmd.action === "transcript") {
          ws.send(JSON.stringify(session.transcript("export")));
        }
        else if (cmd.action === "compileDeck" || cmd.action === "compileTranscriptSnapshot" || cmd.action === "exportDeck" || cmd.action === "exportPptx") {
          const jobId: CompileJobId = `compile-${randomUUID()}`;
          if (cmd.meetingId !== undefined && !validMeetingId(cmd.meetingId)) {
            broadcast({ type: "compile", status: "started", jobId });
            broadcast({ type: "compile", status: "error", jobId, error: "meetingId must be a number" });
          } else if (activeJob !== null) {
            broadcast({ type: "compile", status: "error", jobId, meetingId: typeof cmd.meetingId === "number" ? cmd.meetingId : undefined, error: `A conflicting ${activeJob.action} job is already in progress` });
          } else {
            const requestedMeetingId = cmd.meetingId ?? store.latestMeeting()?.id;
            if (requestedMeetingId === undefined) {
              void runSceneCompileAction({ store, transport: extractionTransport, jobId, exportsDirectory: join(import.meta.dir, "exports"), send: broadcast });
            } else {
              activeJob = { id: jobId, meetingId: requestedMeetingId, action: cmd.action };
              void runSceneCompileAction({
                store, transport: extractionTransport, jobId, meetingId: requestedMeetingId,
                exportsDirectory: join(import.meta.dir, "exports"), send: broadcast,
              }).then((result) => {
                if (result && cmd.action !== "compileDeck") {
                  lastSavedPath = cmd.action === "exportDeck" ? result.relativePath : result.pptxPath;
                  broadcast({ type: "saved", path: lastSavedPath });
                }
              }).finally(() => { if (activeJob?.id === jobId) activeJob = null; });
            }
          }
        }
        else if (cmd.action === "exportPdf" || cmd.action === "exportPng") {
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
let captureStartedAt: number | null = null;
let stopPromise: Promise<void> | null = null;
let captureRun: Promise<void> | null = null;
let stopRequested = false;
let rawAudioRecorder: RawAudioRecorder | null = null;
let captureFinalizer: CaptureFinalizer | null = null;

const selectSttModel = createSelectSttModel(sttManager, {
  isCapturing: () => capturing,
  stopCapture,
  startCapture,
  rebuildCapture() {
    whisper = createWhisperCapture();
    broadcast(sttModelsMessage(sttManager.allStates()));
    broadcast({ type: "status", text: "음성 인식 모델을 변경했습니다" });
  },
});

function captureMessage(): CaptureUpdate {
  return {
    type: "capture",
    capturing,
    mode: config.input.mode,
    ...(capturing && captureStartedAt !== null ? { startedAt: captureStartedAt } : {}),
  };
}

function reportCaptureActionError(action: "start" | "stop", error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[capture] ${action} failed: ${message}`);
  broadcast({ type: "status", text: `녹음을 ${action === "start" ? "시작" : "중지"}하지 못했습니다: ${message}` });
  broadcast(captureMessage());
}

const whisperHandlers = {
  onChunk: (c: TranscriptChunk) => session.onChunk(c),
  onStatus: (s: string) => {
    console.log(`[whisper] ${s}`);
    broadcast({ type: "status", text: s });
  },
  onError: (e: Error) => {
    console.error(`[whisper error] ${e.message}`);
    broadcast({ type: "status", text: `음성 인식 오류: ${e.message}` });
  },
};

async function startCapture(requestedMeetingId?: unknown): Promise<void> {
  if (capturing) {
    if (requestedMeetingId === undefined) return;
    throw new Error("capture is already running");
  }
  if (stopPromise) await stopPromise;
  let preparedMeetingId: number | null = null;
  if (requestedMeetingId !== undefined) {
    if (!Number.isInteger(requestedMeetingId) || (requestedMeetingId as number) < 1) {
      throw new Error("meeting_id must be a positive integer");
    }
    preparedMeetingId = requestedMeetingId as number;
    if (currentMeetingId === null || preparedMeetingId !== currentMeetingId) {
      throw new Error(`meeting ${preparedMeetingId} does not match the current prepared meeting`);
    }
    if (minutesStore.meetingMeta(preparedMeetingId)?.phase !== "prepared") {
      throw new Error(`meeting ${preparedMeetingId} is not prepared`);
    }
  }
  if (config.input.mode === "file" && config.input.filePath) {
    const duplicateMeetingId = minutesStore.findMeetingByAudioHash(sha256File(config.input.filePath));
    if (duplicateMeetingId !== null) {
      currentMeetingId = duplicateMeetingId;
      throw new Error(`[DUPLICATE_AUDIO] audio already belongs to meeting ${duplicateMeetingId}`);
    }
  }
  if (config.input.mode === "mic") {
    spawnSync("pkill", ["-f", `${config.whisper.streamBin} -m ${config.whisper.modelPath}`], { stdio: "ignore" });
  }
  if (preparedMeetingId === null) {
    currentMeetingId = store.startMeeting(currentProviderId);
    minutesStore.registerCapturingMeeting(currentMeetingId);
  } else {
    minutesStore.activatePreparedMeeting(preparedMeetingId);
    store.activateMeeting(preparedMeetingId);
  }
  if (currentMeetingId === null) throw new Error("capture meeting was not created");
  const meetingId = currentMeetingId;
  if (config.input.mode === "file" && config.input.filePath) {
    const claimed = claimFileAudioSource(minutesStore, meetingId, config.input.filePath);
    if (claimed.duplicateMeetingId !== null) throw new Error(`[DUPLICATE_AUDIO] audio already belongs to meeting ${claimed.duplicateMeetingId}`);
  }
  rawAudioRecorder = null;
  if (config.input.mode === "mic" && config.whisper.audioRecorderBin) {
    mkdirSync(join(import.meta.dir, "exports"), { recursive: true });
    const outputPath = join(import.meta.dir, "exports", `audio-${meetingId}-${Date.now()}.tmp.wav`);
    try {
      rawAudioRecorder = await RawAudioRecorder.start({
        bin: config.whisper.audioRecorderBin,
        captureId: config.whisper.captureId,
        outputPath,
      });
    } catch (error) {
      rawAudioRecorder = null;
      store.endMeeting();
      if (minutesStore.meetingMeta(meetingId)?.phase === "capturing") minutesStore.endMeeting(meetingId);
      throw error;
    }
  }
  transcriptWriter.begin(meetingId, {
    sourceKind: config.input.mode === "file" ? "file_transcription" : "live_capture",
    engine: "whisper.cpp",
    engineModel: config.whisper.modelPath,
    dualWriteLegacy: true,
  });
  captureFinalizer = new CaptureFinalizer(minutesStore, transcriptWriter, meetingId, rawAudioRecorder);
  capturing = true;
  captureStartedAt = Date.now();
  stopRequested = false;
  broadcast(captureMessage());
  broadcast(meetingsMessage());
  broadcast({ type: "status", text: "녹음을 시작했습니다. 말씀해 주세요" });
  const finalizer = captureFinalizer;
  captureRun = (async () => {
    let failure: unknown = null;
    try {
      await whisper.start(whisperHandlers);
    } catch (error) {
      failure = error;
    } finally {
      try {
        await session.flush();
        const finalized = await finalizer.finish();
        if (finalized.audio.status === "unavailable" && config.input.mode === "mic") {
          broadcast({ type: "status", text: "원본 오디오를 저장하지 못했습니다" });
        }
      } finally {
        rawAudioRecorder = null;
        captureFinalizer = null;
        store.endMeeting();
        if (minutesStore.meetingMeta(meetingId)?.phase === "capturing") minutesStore.endMeeting(meetingId);
        const endedNaturally = capturing && !stopRequested;
        capturing = false;
        captureStartedAt = null;
        broadcast(captureMessage());
        if (endedNaturally && config.input.mode === "mic") {
          broadcast({ type: "status", text: "마이크 입력이 중단되었습니다. 마이크와 권한을 확인한 뒤 다시 시작해 주세요" });
        } else if (!stopRequested) {
          broadcast({ type: "status", text: "음성 입력이 종료되었습니다" });
        }
      }
    }
    if (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      console.error(`[capture fatal] ${message}`);
      broadcast({ type: "status", text: `녹음 오류: ${message}` });
    }
  })();
}

async function stopCapture(): Promise<void> {
  if (!capturing || !captureRun) {
    broadcast(captureMessage());
    broadcast({ type: "status", text: "이미 녹음이 중지된 상태입니다" });
    return;
  }
  capturing = false;
  stopRequested = true;
  broadcast(captureMessage());
  const run = captureRun;
  stopPromise = (async () => {
    try {
      await whisper.stop();
      await run;
      broadcast(meetingsMessage());
      broadcast({ type: "status", text: "녹음 중지 완료. 슬라이드와 전사 원문을 저장할 수 있습니다" });
    } finally {
      captureRun = null;
      stopPromise = null;
    }
  })();
  await stopPromise;
}

if (config.input.mode === "file") {
  void startCapture();
}

const shutdown = async () => {
  console.log("\n종료 중...");
  if (capturing && captureRun) await stopCapture();
  else if (captureRun) await captureRun;
  process.exit(0);
};
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

const ok = await llm.ping();
if (ok) {
  console.log(`LLM 연결 OK: ${config.llm.provider} / ${llmLabel}`);
} else {
  console.warn(`LLM 핑 실패 - 서버는 동작함. provider=${config.llm.provider}`);
}
