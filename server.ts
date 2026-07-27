// ============================================================
// server.ts - 메인 진입점: HTTP + WebSocket + 세션 오케스트레이션
// ============================================================
// Bun.serve의 네이티브 websocket 지원 사용.
// 단일 프로세스에서 whisper-stream 자식 + LLM 블록 감지 + 클라이언트 push.

import { loadConfig, loadWhisperConfig } from "./src/config.ts";
import { WhisperStream, WhisperCLI, listCaptureDevices, type TranscriptChunk } from "./src/whisper.ts";
import { LLMClient, type BlockDetector } from "./src/llm.ts";
import { CliLLMClient } from "./src/llm-cli.ts";
import { MeetingSession, type ServerMessage, type ClientListener, type ProvidersUpdate, type CaptureUpdate } from "./src/session.ts";
import { buildProviderEntries, checkCliBin, createDetector, KEY_BY_PROVIDER, upsertEnvText } from "./src/providers.ts";
import { MeetingStore } from "./src/store.ts";
import { buildDeckHtml } from "./src/deck.ts";
import { join, sep } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

let llm: BlockDetector;
let llmLabel: string;
if (config.llm.cli) {
  llm = new CliLLMClient(config.llm.cli);
  llmLabel = `cli:${config.llm.cli.preset}(${config.llm.cli.bin})`;
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
    onSlide: (slide) => store.addSlide({
      idx: slide.index,
      title: slide.title,
      bullets: slide.bullets,
      startedAt: slide.startedAt,
    }),
  },
);

// ── 프로바이더 런타임 선택 (사용자가 UI에서 교체) ──
const providerEntries = buildProviderEntries(process.env, {
  claude: checkCliBin("claude"),
  codex: checkCliBin("codex"),
});
let currentProviderId = config.llm.cli ? `cli:${config.llm.cli.preset}` : config.llm.provider;
const cliTimeoutMs = config.llm.cli?.timeoutMs ?? 120_000;
// 관찰성: 마지막 저장 경로를 유지해 클라이언트에 상시 표시
let lastSavedPath: string | null = null;

function providersMessage(): ProvidersUpdate {
  return { type: "providers", list: providerEntries, current: currentProviderId };
}

function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited.catch(() => {});
}

/**
 * 카드의 "연결" 버튼 처리. 구독 CLI는 각 CLI의 OAuth 플로우를 열고,
 * API 키 프로바이더는 키 발급 페이지를 연다 (키는 카드에 붙여넣기).
 */
function connectProvider(id: string): void {
  switch (id) {
    case "cli:codex": {
      // codex login: ChatGPT 계정 OAuth 브라우저 플로우 (CLI가 콜백 서버를 띄움)
      broadcast({ type: "status", text: "ChatGPT 로그인 창을 여는 중… 브라우저에서 승인해주세요" });
      spawn("codex", ["login"], { stdio: "ignore", detached: true }).unref();
      break;
    }
    case "cli:claude": {
      // claude CLI는 대화형 /login만 제공 → 터미널을 열어 안내
      broadcast({ type: "status", text: "열린 터미널의 claude에서 /login 을 실행해 연결하세요" });
      spawn("osascript", ["-e", 'tell application "Terminal" to do script "claude"'], { stdio: "ignore", detached: true }).unref();
      break;
    }
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

const whisper = config.input.mode === "file" && config.input.filePath
  ? new WhisperCLI(config.whisper, config.input.filePath)
  : new WhisperStream(config.whisper);

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
      ws.send(JSON.stringify(captureMessage()));
      ws.send(JSON.stringify(session.transcript("snapshot")));
      if (lastSavedPath) {
        ws.send(JSON.stringify({ type: "saved" as const, path: lastSavedPath }));
      }
    },
    message(ws: ServerWebSocket<undefined>, data: string | Buffer) {
      try {
        const cmd = JSON.parse(typeof data === "string" ? data : data.toString("utf-8")) as { action?: string; id?: string; key?: string };
        if (cmd.action === "startCapture") void startCapture();
        else if (cmd.action === "stopCapture") void stopCapture();
        else if (cmd.action === "reset") {
          session.reset();
          // 회의 저장소도 새 회의로 전환 (캡처 중이면 이어서 기록)
          store.endMeeting();
          if (capturing) store.startMeeting(currentProviderId);
          broadcast(session.transcript("snapshot"));
        }
        else if (cmd.action === "status") {
          ws.send(JSON.stringify({ type: "status" as const, text: "서버 정상" }));
        }
        else if (cmd.action === "transcript") {
          ws.send(JSON.stringify(session.transcript("export")));
        }
        else if (cmd.action === "exportDeck") {
          // lecture-deck 템플릿 기반 reveal.js 강의 덱 생성 (회의는 SQLite에서 조회)
          try {
            const meta = store.latestMeeting();
            if (!meta) {
              broadcast({ type: "status", text: "저장된 회의가 없습니다" });
            } else {
              const stamp = new Date().toISOString().replace(/[:.]/g, "-");
              const dir = join(import.meta.dir, "exports", `deck-${stamp}`);
              mkdirSync(dir, { recursive: true });
              copyFileSync(join(import.meta.dir, "deck", "theme.css"), join(dir, "theme.css"));
              const html = buildDeckHtml({
                title: "Meeting Notes",
                startedAt: meta.started_at,
                provider: meta.provider,
                slides: store.slides(meta.id),
                lines: store.lines(meta.id),
              });
              writeFileSync(join(dir, "index.html"), html, "utf-8");
              lastSavedPath = `exports/deck-${stamp}/index.html`;
              broadcast({ type: "saved", path: lastSavedPath });
              broadcast({ type: "status", text: `덱 저장됨: ${lastSavedPath}` });
              openUrl(`file://${join(dir, "index.html")}`);
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            broadcast({ type: "status", text: `덱 저장 실패: ${message}` });
          }
        }
        else if (cmd.action === "saveNotes") {
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
        }
        else if (cmd.action === "saveJson") {
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
        }
        else if (cmd.action === "setProvider" && typeof cmd.id === "string") {
          const entry = providerEntries.find((e) => e.id === cmd.id);
          if (!entry) {
            ws.send(JSON.stringify({ type: "status" as const, text: `알 수 없는 프로바이더: ${cmd.id}` }));
          } else if (!entry.available) {
            ws.send(JSON.stringify({ type: "status" as const, text: `${entry.label}은(는) 설정되지 않았습니다 (CLI 설치/API 키 확인)` }));
          } else {
            const detector = createDetector(entry.id, { cliTimeoutMs });
            if (detector) {
              session.setDetector(detector);
              currentProviderId = entry.id;
              broadcast(providersMessage());
              broadcast({ type: "status", text: `LLM 변경됨: ${entry.label}` });
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
          const claudeOk = checkCliBin("claude");
          const codexOk = checkCliBin("codex");
          for (const e of providerEntries) {
            if (e.id === "cli:claude") e.available = claudeOk;
            if (e.id === "cli:codex") e.available = codexOk;
          }
          broadcast(providersMessage());
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
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
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
  if (!capturing) return;
  capturing = false;
  broadcast(captureMessage());
  // startCapture가 await stopPromise로 기다릴 수 있도록 promise를 노출.
  const p = whisper.stop();
  stopPromise = p;
  try {
    await p;
    await session.flush();
    store.endMeeting();
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
