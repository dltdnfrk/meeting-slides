const port = Number(process.env.HTTP_PORT!);
const receiptPath = process.env.RECEIPT_PATH!;
const readyFifo = process.env.READY_FIFO!;
const sockets = new Set<ServerWebSocket<unknown>>();
const events: Record<string, unknown>[] = [];

function record(kind: string, detail: Record<string, unknown> = {}) {
  events.push({ sequence: events.length + 1, kind, ...detail });
  Bun.write(receiptPath, events.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
function broadcast(frame: Record<string, unknown>) {
  const raw = JSON.stringify(frame);
  for (const socket of sockets) socket.send(raw);
  record("server-frame", { frame });
}
function endCapture(source: string) {
  broadcast({ type: "capture", capturing: false, mode: "mic", phase: "idle", startedAt: null });
  record("capture-ended", { source });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws" && server.upgrade(request)) return;
    if (url.pathname === "/control/capturing" && request.method === "POST") {
      const startedAt = Date.now() - 125_000;
      broadcast({ type: "capture", capturing: true, mode: "mic", phase: "capturing", startedAt });
      broadcast({ type: "line", text: "핵심 결정 사항을 확정했습니다.", ts: startedAt + 1000, speaker: 1 });
      broadcast({ type: "line", text: "다음 단계와 담당자를 확인합니다.", ts: startedAt + 2000, speaker: 2 });
      broadcast({ type: "line", text: "발표 자료 구조를 정리했습니다.", ts: startedAt + 3000, speaker: 1 });
      broadcast({ type: "caption", text: "현재 논의를 기록하고 있습니다", ts: startedAt + 4000 });
      return new Response(JSON.stringify({ capturing: true, startedAt }) + "\n");
    }
    if (url.pathname === "/") {
      record("workspace-get", { host: request.headers.get("host") });
      return new Response(
        '<!doctype html><title>Meeting Slides</title><script src="/runtime-bootstrap.js"></script><main id="runtime-bootstrap">isolated QA</main>',
        { headers: { "content-type": "text/html" } },
      );
    }
    if (url.pathname === "/receipt") return Response.json(events);
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(socket) {
      sockets.add(socket);
      record("websocket-open", { clients: sockets.size });
      socket.send(JSON.stringify({ type: "capture", capturing: false, mode: "mic", phase: "idle", startedAt: null }));
      record("server-frame", { frame: { type: "capture", capturing: false, mode: "mic", phase: "idle", startedAt: null } });
    },
    message(_socket, message) {
      const raw = String(message);
      record("client-command", { raw });
      if (raw === '{"action":"stopCapture"}') endCapture("native-stopCapture");
    },
    close(socket) {
      sockets.delete(socket);
      record("websocket-close", { clients: sockets.size });
    },
  },
});
record("server-ready", { port: server.port });
const fifo = Bun.file(readyFifo).writer();
fifo.write("ready\n");
await fifo.end();
