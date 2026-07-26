// ============================================================
// server.ts - 메인 진입점: HTTP + WebSocket + 세션 오케스트레이션
// ============================================================
// Bun.serve의 네이티브 websocket 지원 사용.
// 단일 프로세스에서 whisper-stream 자식 + LLM 블록 감지 + 클라이언트 push.

import { loadConfig, loadWhisperConfig } from "./src/config.ts";
import { WhisperStream, WhisperCLI, listCaptureDevices } from "./src/whisper.ts";
import { LLMClient } from "./src/llm.ts";
import { MeetingSession, type ServerMessage, type ClientListener } from "./src/session.ts";
import { join, sep } from "node:path";
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

const llm = new LLMClient(config.llm.config);
const listeners = new Set<ClientListener>();
const session = new MeetingSession(
  llm,
  config.block.detectInterval,
  config.block.contextWindow,
  listeners,
);

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
  websocket: {
    open(ws: ServerWebSocket<undefined>) {
      const listener: ClientListener = (msg: ServerMessage) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(msg));
      };
      session.addListener(listener);
      wsListeners.set(ws, listener);
      ws.send(JSON.stringify({
        type: "status" as const,
        text: `연결됨. LLM provider=${config.llm.provider} model=${config.llm.config.model}`,
      }));
      ws.send(JSON.stringify(session.snapshot()));
    },
    message(ws: ServerWebSocket<undefined>, data: string | Buffer) {
      try {
        const cmd = JSON.parse(typeof data === "string" ? data : data.toString("utf-8")) as { action?: string };
        if (cmd.action === "reset") session.reset();
        if (cmd.action === "status") {
          ws.send(JSON.stringify({ type: "status" as const, text: "서버 정상" }));
        }
      } catch {}
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

void whisper.start({
  onChunk: (c) => session.onChunk(c),
  onStatus: (s) => {
    console.log(`[whisper] ${s}`);
    for (const l of listeners) { try { l({ type: "status", text: s }); } catch {} }
  },
  onError: (e) => {
    console.error(`[whisper error] ${e.message}`);
    for (const l of listeners) { try { l({ type: "status", text: `whisper 오류: ${e.message}` }); } catch {} }
  },
}).then(async () => {
  await session.flush();
  const mode = config.input.mode;
  if (mode === "mic") {
    // 마이크 모드에서 whisper-stream이 종료되면 비정상 (사용자가 멈추지 않는 한).
    console.warn("[whisper] 마이크 캡처가 종료됨 — 장치/권한 확인 필요");
    for (const l of listeners) {
      try { l({ type: "status", text: "⚠️ 마이크 캡처 종료. 마이크 권한/장치를 확인하고 서버를 재시작하세요." }); } catch {}
    }
  } else {
    for (const l of listeners) { try { l({ type: "status", text: "입력 종료" }); } catch {} }
  }
}).catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[whisper fatal] ${message}`);
  for (const l of listeners) { try { l({ type: "status", text: `whisper 치명 오류: ${message}` }); } catch {} }
});

const ok = await llm.ping();
if (ok) {
  console.log(`LLM 연결 OK: ${config.llm.provider} / ${config.llm.config.model}`);
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
